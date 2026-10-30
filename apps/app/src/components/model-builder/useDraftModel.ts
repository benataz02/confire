import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkModel, diffModel, isEmptyPatch, type Issue, type ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import type { TableCols } from "./exprHelpers.ts";
import { toast } from "@confire/ui/toast.ts";
import { type Translate } from "./builderMessages.ts";
import { starterModel } from "./starterModel.ts";

export const issueFor = (issues: Issue[], path: string) => issues.find((i) => i.path === path);

function colKeys(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  const keys: string[] = [];
  for (const c of columns) {
    if (typeof c === "string") keys.push(c);
    else if (c && typeof c === "object" && "key" in c && typeof c.key === "string") keys.push(c.key);
  }
  return keys;
}

// One draft ModelDef in memory; checkModel on every change is the same gate the server runs
// on save, so "0 issues" here means the save cannot be rejected for model errors.
export function useDraftModel(id?: string) {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const rec = useQuery({ ...orpc.models.get.queryOptions({ input: { id: id! } }), enabled: !!id });
  const tablesQ = useQuery(orpc.masterdata.list.queryOptions());
  const [draft, setDraft] = useState<ModelDef | null>(() => (id ? null : starterModel("", t)));
  const [dirty, setDirty] = useState(false);
  // The bundle loads after the first paint. An untouched new model is seeded again once the
  // texts exist, so a section title is never the raw key. Edits set dirty and stay as typed.
  useEffect(() => {
    if (id || dirty) return;
    setDraft((d) => (d && !d.name.trim() ? starterModel("", t) : d));
  }, [id, dirty, i18n]);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  // A brand-new model is empty by definition, so painting its mandatory fields red — and listing
  // them in the message popover — before the author has touched anything is noise. Like
  // the parameter page's `tried`, the first Save reveals them.
  // A *saved* model starts validated: it passed checkModel to get into the database, so anything
  // wrong with it is something this session just introduced, and saying so at once is the point.
  const [tried, setTried] = useState(!!id);

  // What the server holds as far as this page knows: the definition loaded, then each one saved.
  // Save sends the draft's difference from it, never the whole model.
  const [base, setBase] = useState<ModelDef | null>(null);
  useEffect(() => {
    if (rec.data && draft === null) { setDraft(rec.data.definition); setBase(rec.data.definition); }
  }, [rec.data, draft]);

  const tables = tablesQ.data ?? [];
  // Masterdata is one namespace: a model references a maintained table and a live query the same
  // way, so both kinds go into checkModel and into the expression suggestions.
  const tableCols = useMemo<TableCols[]>(
    () => tables.map((t) => ({
      name: t.name,
      kind: t.kind,
      columns: t.kind === "query" ? (t.query?.columns ?? []) : colKeys(t.columns),
      target: t.query?.target,
    })),
    [tables],
  );
  // Commit model: the parameter page and the table dialog buffer edits and commit on OK; inline
  // editors (RulesTab, SettingsTab) mutate this draft directly per keystroke. Validation
  // runs against a deferred draft so checkModel lags fast typing instead of blocking every keystroke.
  const deferredDraft = useDeferredValue(draft);
  const modelIssues = useMemo(
    () => (deferredDraft ? checkModel(deferredDraft, tableCols) : []),
    [deferredDraft, tableCols],
  );

  const saved = () => {
    setDirty(false);
    setServerIssues([]);
    setTried(true); // it is a saved model now, errors introduced from here on are live
    qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
    qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
    toast(t("MODEL_TOAST_SAVED"));
  };
  // Both reject an invalid definition with BAD_REQUEST + data.issues (span Issues).
  const refused = (e: unknown) => setServerIssues((e as { data?: { issues?: Issue[] } }).data?.issues ?? []);
  const createMut = useMutation(orpc.models.create.mutationOptions({
    onSuccess: (row) => {
      saved();
      // create RETURNs the row, so the page it moves to starts from the cache instead of refetching.
      qc.setQueryData(orpc.models.get.queryOptions({ input: { id: row.id } }).queryKey, row);
      // search kept: a save from the parameter page has already returned to the Parameters tab.
      void navigate({ to: "/$slug/models/$id", params: { id: row.id }, search: true, replace: true });
    },
    onError: refused,
  }));
  const saveMut = useMutation(orpc.models.save.mutationOptions({ onError: refused }));

  return {
    draft,
    update: (fn: (d: ModelDef) => ModelDef) => {
      setDraft((d) => (d ? fn(d) : d));
      setDirty(true);
      setServerIssues([]);
    },
    issues: modelIssues,
    serverIssues,
    dirty,
    /** Save has been pressed at least once — only then do the fields show their own errors. */
    tried,
    /** Clear the unsaved-changes blocker before navigating away deliberately (Delete). */
    setDirty,
    // Save stays enabled and the first click on an invalid model reveals the errors instead of
    // saving, so the button never greys out without saying why (same deal as the parameter page).
    // `def` is for a caller that has just called `update`: `draft` is still the render's old one.
    save: (def: ModelDef | null = draft) => {
      if (!def) return;
      setTried(true);
      const issues = def === draft ? modelIssues : checkModel(def, tableCols);
      if (issues.length > 0 || !def.name.trim()) return;
      if (!id) return createMut.mutate({ definition: def });
      if (!base) return;
      const patch = diffModel(base, def);
      // Edited and typed back: nothing to send.
      if (isEmptyPatch(patch)) return setDirty(false);
      saveMut.mutate({ id, patch }, {
        onSuccess: ({ updatedAt }) => {
          setBase(def);
          saved();
          // The answer is only the time, so the cached row is brought up to what was sent.
          qc.setQueryData(orpc.models.get.queryOptions({ input: { id } }).queryKey,
            (row) => row && { ...row, name: def.name, definition: def, updatedAt });
        },
      });
    },
    saving: saveMut.isPending || createMut.isPending,
    saveError: (saveMut.error ?? createMut.error) as Error | null,
    loading: !!id && rec.isPending,
    loadError: rec.error as Error | null,
    tableCols,
  };
}

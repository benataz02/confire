import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { checkModel, type Issue, type ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import type { TableCols } from "./exprHelpers.ts";
import { toast } from "../toast.ts";
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
  const navigate = useNavigate();
  const rec = useQuery({ ...orpc.models.get.queryOptions({ input: { id: id! } }), enabled: !!id });
  const tablesQ = useQuery(orpc.masterdata.list.queryOptions());
  const [draft, setDraft] = useState<ModelDef | null>(() => (id ? null : starterModel("")));
  const [dirty, setDirty] = useState(false);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  // A brand-new model is empty by definition, so painting its mandatory fields red — and listing
  // them in the message popover — before the author has touched anything is noise. Like
  // ParamDialog's `tried`, the first Save reveals them.
  // A *saved* model starts validated: it passed checkModel to get into the database, so anything
  // wrong with it is something this session just introduced, and saying so at once is the point.
  const [tried, setTried] = useState(!!id);
  const [portalMeta, setPortalMetaState] = useState<{ portal: boolean; portalDescription: string } | null>(
    () => (id ? null : { portal: false, portalDescription: "" }),
  );

  useEffect(() => {
    if (rec.data && draft === null) setDraft(rec.data.definition);
  }, [rec.data, draft]);

  useEffect(() => {
    if (rec.data && portalMeta === null)
      setPortalMetaState({ portal: rec.data.portal, portalDescription: rec.data.portalDescription ?? "" });
  }, [rec.data, portalMeta]);

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
  // Commit model: dialogs (ParamDialog, ComboTableDialog) buffer edits and commit on OK; inline
  // editors (RulesTab, SettingsTab) mutate this draft directly per keystroke. Validation
  // runs against a deferred draft so checkModel lags fast typing instead of blocking every keystroke.
  const deferredDraft = useDeferredValue(draft);
  const modelIssues = useMemo(
    () => (deferredDraft ? checkModel(deferredDraft, tableCols) : []),
    [deferredDraft, tableCols],
  );

  const saveMut = useMutation(
    orpc.models.save.mutationOptions({
      onSuccess: (row) => {
        setDirty(false);
        setServerIssues([]);
        setTried(true); // it is a saved model now, errors introduced from here on are live
        qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
        qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
        // save RETURNs the saved row, so seed the cache with it instead of refetching models.get.
        qc.setQueryData(orpc.models.get.queryOptions({ input: { id: row.id } }).queryKey, row);
        toast("Model saved");
        if (!id) void navigate({ to: "/models/$id", params: { id: row.id }, replace: true });
      },
      onError: (e) => {
        // models.save rejects invalid definitions with BAD_REQUEST + data.issues (span Issues).
        const data = (e as { data?: { issues?: Issue[] } }).data;
        setServerIssues(data?.issues ?? []);
      },
    }),
  );

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
    portalMeta,
    setPortalMeta: (p: { portal: boolean; portalDescription: string }) => {
      setPortalMetaState(p);
      setDirty(true);
    },
    // Save stays enabled and the first click on an invalid model reveals the errors instead of
    // saving, so the button never greys out without saying why (same deal as ParamDialog).
    save: () => {
      if (!draft || !portalMeta) return;
      setTried(true);
      if (modelIssues.length > 0 || !draft.name.trim()) return;
      saveMut.mutate({
        ...(id ? { id } : {}),
        definition: draft,
        portal: portalMeta.portal, portalDescription: portalMeta.portalDescription || null,
      });
    },
    saving: saveMut.isPending,
    saveError: saveMut.error as Error | null,
    loading: !!id && rec.isPending,
    loadError: rec.error as Error | null,
    tableCols,
  };
}

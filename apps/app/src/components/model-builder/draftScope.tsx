import { createContext, useCallback, useContext, useDeferredValue, useMemo, useState } from "react";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator } from "@ui5/webcomponents-react";
import { checkModel, diffModel, type Issue, type ModelDef } from "@confire/config-engine";
import { useObjectRecord, type ObjectRecord } from "@confire/ui/object-page/useObjectRecord.ts";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { toast } from "@confire/ui/toast.ts";
import type { Row, Section } from "@confire/ui/types.ts";
import { orpc } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { modelSections } from "../../features/model/model.ts";
import { defOf, fromRecord, toRecord, withDef, type ModelRow } from "../../features/model/record.ts";
import { modelIssues, type Translate } from "./builderMessages.ts";
import type { TableCols } from "./exprHelpers.ts";
import { sameModelPath } from "./paramRoute.ts";
import { starterModel } from "./starterModel.ts";

type Scope = {
  /** absent while the model itself is still unsaved */
  id?: string;
  /** the model as a record — alive across the builder, parameter and table routes */
  record: ObjectRecord;
  sections: Section[];
  /** the record's definition */
  def: ModelDef;
  /** an edit of the definition (structureOps, the parameter and table pages' commits) */
  editModel: (fn: (d: ModelDef) => ModelDef) => void;
  /** writes `def` into the record and saves the model — a parameter or table page's Save */
  saveModel: (def: ModelDef) => void;
  tableCols: TableCols[];
  /** checkModel's issues for the record, lagging fast typing as the record's own check does */
  issues: Issue[];
};

const ScopeContext = createContext<Scope | null>(null);

/** The model record. Only rendered once `ModelDraftScope` has loaded it. */
export function useModelDraft(): Scope {
  const value = useContext(ScopeContext);
  if (!value) throw new Error("useModelDraft outside ModelDraftScope");
  return value;
}

function colKeys(columns: unknown): string[] {
  if (!Array.isArray(columns)) return [];
  const keys: string[] = [];
  for (const c of columns) {
    if (typeof c === "string") keys.push(c);
    else if (c && typeof c === "object" && "key" in c && typeof c.key === "string") keys.push(c.key);
  }
  return keys;
}

/** Owns the model record for the builder and its parameter and table pages. The layout stays
 *  mounted, so opening a parameter does not drop an edit or ask to discard it. */
export function ModelDraftScope({ id }: { id?: string }) {
  const rec = useQuery({ ...orpc.models.get.queryOptions({ input: { id: id! } }), enabled: !!id });
  const md = useQuery(orpc.masterdata.list.queryOptions());
  if (rec.error) return <PageError error={rec.error} />;
  // Masterdata too: checkModel without it would call every table the model names unknown.
  if ((id && !rec.data) || md.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  return <Loaded id={id} row={rec.data} masterdata={md.data ?? []} />;
}

function Loaded({ id, row, masterdata }: {
  id?: string;
  row?: ModelRow;
  masterdata: { name: string; kind: "table" | "query"; columns: unknown; query: { columns: string[]; target?: "b1" | "beas" } | null }[];
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  // Read once: a new object resets the record, and a Save rebases it instead.
  const [data] = useState(() => toRecord(row
    ? { definition: row.definition, portal: row.portal, portalPricing: row.portalPricing }
    : { definition: starterModel("", t), portal: false, portalPricing: "request" }));
  const sections = useMemo(() => modelSections(t), [i18n]);
  // Masterdata is one namespace: a model references a maintained table and a live query the same
  // way, so both kinds go into checkModel and into the expression suggestions.
  const tableCols = useMemo<TableCols[]>(
    () => masterdata.map((m) => ({
      name: m.name, kind: m.kind,
      columns: m.kind === "query" ? (m.query?.columns ?? []) : colKeys(m.columns),
      target: m.query?.target,
    })),
    [masterdata],
  );
  // One check per record object: the record's validate and the page's own reads share it.
  const issuesOf = useMemo(() => {
    const seen = new WeakMap<Row, Issue[]>();
    return (r: Row) => {
      let out = seen.get(r);
      if (!out) seen.set(r, (out = checkModel(defOf(r), tableCols)));
      return out;
    };
  }, [tableCols]);
  const validate = useCallback((r: Row) => modelIssues(r, issuesOf(r), t), [issuesOf, i18n]);

  const lists = () => void qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
  const create = useMutation(orpc.models.create.mutationOptions());
  const save = useMutation(orpc.models.save.mutationOptions());

  const record = useObjectRecord({
    data, sections, validate,
    isNew: !id,
    alwaysEdit: true,
    // The builder and its parameter and table pages are one model: moving between them is not leaving.
    sameRecord: sameModelPath,
    onLeave: () => navigate({ to: "/$slug/models" }),
    // Save is one call: the definition's difference from what was loaded (or last saved), and the
    // portal columns when they changed. The server moves updatedAt only for a definition change.
    onSave: async (_diff, { formData, baseline }) => {
      const next = fromRecord(formData), base = fromRecord(baseline);
      try {
        if (!id) {
          const created = await create.mutateAsync(next);
          // create RETURNs the row, so the page it moves to starts from the cache instead of refetching.
          qc.setQueryData(orpc.models.get.queryOptions({ input: { id: created.id } }).queryKey, created);
          lists();
          toast(t("MODEL_TOAST_SAVED"));
          // search kept: a save from the parameter page has already returned to the Parameters tab.
          await navigate({ to: "/$slug/models/$id", params: { id: created.id }, search: true, replace: true });
          return;
        }
        const portal = next.portal !== base.portal || next.portalPricing !== base.portalPricing
          ? { portal: next.portal, portalPricing: next.portalPricing } : {};
        const { updatedAt } = await save.mutateAsync({ id, patch: diffModel(base.definition, next.definition), ...portal });
        // The answer is only the time, so the cached row is brought up to what was sent.
        qc.setQueryData(orpc.models.get.queryOptions({ input: { id } }).queryKey,
          (r) => r && { ...r, ...next, name: next.definition.name, updatedAt });
        lists();
        toast(t("MODEL_TOAST_SAVED"));
      } catch (e) {
        // Both refuse an invalid definition with BAD_REQUEST + data.issues: the gate saw something
        // this page did not (masterdata changed meanwhile), so say what.
        const issues = (e as { data?: { issues?: Issue[] } }).data?.issues;
        throw issues?.length ? new Error(issues.map((x) => `${x.path}: ${x.message}`).join(" · ")) : e;
      }
    },
  });

  const deferred = useDeferredValue(record.formData);
  const scope: Scope = {
    id, record, sections, tableCols,
    def: defOf(record.formData),
    editModel: (fn) => record.update(withDef(fn)),
    saveModel: (def) => void record.save(withDef(() => def)(record.formData)),
    issues: issuesOf(deferred),
  };
  return (
    <ScopeContext.Provider value={scope}>
      <Outlet />
    </ScopeContext.Provider>
  );
}

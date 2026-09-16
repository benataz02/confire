import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Button, BusyIndicator, MessageStrip,
  ObjectPage, ObjectPageSection, ObjectPageTitle, ObjectStatus,
  Title, Toolbar,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { tabOf, useDraftModel, type TabKey } from "./useDraftModel.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab } from "./ParamsTab.tsx";
import { useRulesTab } from "./RulesTab.tsx";
import { useLinesTab } from "./LinesTabs.tsx";
import { useHistoryTab } from "./HistoryTab.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

// Stable placeholder so usePreviewLookups runs unconditionally (rules of hooks) before the
// draft has loaded; enabled:false until then, so it never hits the agent.
const EMPTY_MODEL: ModelDef = {
  name: "", parameters: [], structure: { sections: [] }, computed: [], constraints: [],
  bom: [], routing: [], pricing: { priceExpr: "0", quoteItemCode: "X" }, batchDefaults: [1],
};

export function ModelBuilderPage({ id }: { id?: string }) {
  const m = useDraftModel(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Both keys: `list` backs GlobalSearch, `rows` backs the paged list page.
  const invalidateLists = () => {
    void qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
  };
  // Copies the *persisted* model, hence disabled while dirty. Delete is not dirty-gated —
  // discarding the edits is the point — so it clears the flag before the blocker can ask.
  const duplicate = useMutation(orpc.models.duplicate.mutationOptions({
    onSuccess: (r) => { invalidateLists(); toast("Model duplicated"); void navigate({ to: "/models/$id", params: { id: r.id } }); },
  }));
  const remove = useMutation(orpc.models.remove.mutationOptions({
    onSuccess: () => { m.setDirty(false); invalidateLists(); toast("Model deleted"); void navigate({ to: "/models" }); },
  }));

  // Guard against losing an unsaved draft: intercept in-app navigation (including switching models,
  // which remounts via key={id}) and confirm; enableBeforeUnload covers hard reload / tab close.
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      if (!m.dirty || m.saving) return false;
      return !(await confirm({
        title: "Discard changes?",
        message: "This model has unsaved changes. Leave without saving?",
        actionText: "Discard",
        destructive: true,
      }));
    },
    enableBeforeUnload: () => m.dirty,
  });

  // Same lookups feed the params preview and RulesTab's combo-table cells. Query definitions are
  // tenant masterdata, so nothing about the unsaved draft affects them.
  const lookups = usePreviewLookups(m.draft ?? EMPTY_MODEL, { enabled: !!m.draft });
  const allIssues: Issue[] = [...m.issues, ...m.serverIssues];
  // Rules, History and BOM/Routing hand back ObjectPageSubSection elements so the anchor bar can
  // find them (a component in between hides them from ObjectPage). They own state, so like
  // usePreviewLookups they have to be called unconditionally, above the loading return.
  const rulesSubSections = useRulesTab({
    draft: m.draft ?? EMPTY_MODEL, update: m.update, issues: allIssues,
    lookups: lookups.data, tables: m.tableCols,
  });
  const historySubSections = useHistoryTab({
    draft: m.draft ?? EMPTY_MODEL, update: m.update, issues: allIssues,
    modelId: id ?? "", dirty: m.dirty,
  });
  const linesSubSections = useLinesTab({
    draft: m.draft ?? EMPTY_MODEL, update: m.update, issues: allIssues, tables: m.tableCols,
  });
  const count = (t: TabKey) => allIssues.filter((i) => tabOf(i.path) === t).length;

  if (m.loading || !m.draft || !m.portalMeta) {
    return m.loadError
      ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{m.loadError.message}</MessageStrip>
      : <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const draft = m.draft;
  const portalMeta = m.portalMeta;

  // Section title carries the section's open issue count, e.g. "Rules (2)".
  const secTitle = (label: string, key: TabKey) => (count(key) ? `${label} (${count(key)})` : label);
  const linesIssues = count("bom") + count("routing");
  const linesTitle = linesIssues ? `Item Structure (${linesIssues})` : "Item Structure";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {m.saveError ? (
        <MessageStrip design="Negative" hideCloseButton>
          {m.serverIssues.length > 0
            ? `Save failed — ${m.serverIssues.length} issue${m.serverIssues.length === 1 ? "" : "s"}; see the section counts.`
            : m.saveError.message}
        </MessageStrip>
      ) : null}
      {/* The server refuses a model that configurations still use, and the confirm dialog cannot
          know that in advance — so the refusal has to be readable here. */}
      {(remove.error ?? duplicate.error) ? (
        <MessageStrip design="Negative" hideCloseButton>{(remove.error ?? duplicate.error)!.message}</MessageStrip>
      ) : null}

      <ObjectPage
        mode="IconTabBar"
        style={{ flex: 1, minHeight: 0, height: "100%" }}
        titleArea={
          <ObjectPageTitle
            header={<Title level="H4">{draft.name.trim() || "New model"}</Title>}
            subHeader={m.dirty ? <ObjectStatus state="Critical">Unsaved changes</ObjectStatus> : undefined}
            actionsBar={
              <Toolbar design="Transparent">
                {id ? (
                  <Button icon="copy" design="Transparent" disabled={m.dirty || duplicate.isPending}
                    tooltip={m.dirty ? "Save first" : "Duplicate model"}
                    onClick={() => duplicate.mutate({ id })}>
                    Duplicate
                  </Button>
                ) : null}
                {id ? (
                  <Button icon="delete" design="Transparent" disabled={remove.isPending}
                    onClick={async () => {
                      if (await confirm({
                        title: "Delete model",
                        message: `Delete "${draft.name || "this model"}"? A model used by a configuration can't be deleted. This cannot be undone.`,
                        actionText: "Delete", destructive: true,
                      })) remove.mutate({ ids: [id] });
                    }}>
                    Delete
                  </Button>
                ) : null}
                <Button design="Emphasized" disabled={m.issues.length > 0 || !m.dirty || m.saving || !draft.name.trim()} onClick={() => void m.save()}>
                  {m.saving ? "Saving…" : "Save"}
                </Button>
              </Toolbar>
            }
          />
        }
      >
        <ObjectPageSection id="settings" titleText={secTitle("Settings", "settings")}>
          <SettingsTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            portalMeta={portalMeta} setPortalMeta={m.setPortalMeta} />
        </ObjectPageSection>
        <ObjectPageSection id="params" titleText={secTitle("Parameters", "params")}>
          <ParamsTab modelId={id ?? ""} draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            lookups={lookups.data} lookupsError={lookups.error} onRetryLookups={() => void lookups.refetch()} />
        </ObjectPageSection>
        <ObjectPageSection id="rules" titleText={secTitle("Rules", "rules")}>
          {rulesSubSections}
        </ObjectPageSection>
        <ObjectPageSection id="outputs" titleText={linesTitle}>
          {linesSubSections}
        </ObjectPageSection>
        <ObjectPageSection id="history" titleText={secTitle("History", "history")}>
          {historySubSections}
        </ObjectPageSection>
      </ObjectPage>
    </div>
  );
}

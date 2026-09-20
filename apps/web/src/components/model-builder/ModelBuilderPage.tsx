import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, MessageStrip,
  ObjectPage, ObjectPageSection, ObjectPageTitle,
  Text, Title, Toolbar,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { useDraftModel } from "./useDraftModel.ts";
import { useSectionParam } from "../../lib/sectionParam.ts";
import { PageMessages } from "../PageMessages.tsx";
import { builderMessages, SECTION_TITLE } from "./builderMessages.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab } from "./ParamsTab.tsx";
import { useRulesTab } from "./RulesTab.tsx";
import { useItemStructureTab } from "./ItemStructureTabs.tsx";
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
  const sectionParam = useSectionParam();
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
  const history = useHistoryTab({ draft: m.draft ?? EMPTY_MODEL, update: m.update, issues: allIssues });
  const linesSubSections = useItemStructureTab({
    draft: m.draft ?? EMPTY_MODEL, update: m.update, issues: allIssues, tables: m.tableCols,
  });

  if (m.loading || !m.draft || !m.portalMeta) {
    return m.loadError
      ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{m.loadError.message}</MessageStrip>
      : <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const draft = m.draft;
  const portalMeta = m.portalMeta;

  // One list drives the title's message popover AND the per-section counts, so a tab can never
  // claim a different number of problems than the popover lists under it.
  const messages = builderMessages({
    draft,
    issues: allIssues,
    saveError: m.saveError,
    actionError: (remove.error ?? duplicate.error) as Error | null,
    lookupsError: lookups.error as Error | null,
  });
  const secTitle = (secId: string) => {
    const n = messages.filter((x) => x.section === secId && x.type === "Negative").length;
    return n ? `${SECTION_TITLE[secId]} (${n})` : SECTION_TITLE[secId]!;
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <ObjectPage
        mode="IconTabBar"
        style={{ flex: 1, minHeight: 0, height: "100%" }}
        {...sectionParam.props}
        titleArea={
          <ObjectPageTitle
            header={
              // Trailing * is the unsaved-changes mark; the native tooltip is what says so, since
              // ObjectPageTitle has no draft-indicator slot of its own.
              <Title level="H4" title={m.dirty ? "Unsaved changes" : undefined}>
                {(draft.name.trim() || "New model") + (m.dirty ? " *" : "")}
              </Title>
            }
            subHeader={draft.description ? <Text>{draft.description}</Text> : undefined}
            actionsBar={
              <Toolbar design="Transparent">
                {/* Every error, warning and blocker on the page, grouped by the tab it belongs to —
                    this is the only place they are reported, so it sits before the actions it
                    explains the disabled state of. */}
                <PageMessages messages={messages} okText="No issues — the model is valid."
                  onSection={sectionParam.go} />
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
              </Toolbar>
            }
          />
        }
        footerArea={
          <Bar design="FloatingFooter" endContent={
            <>
              <Button design="Emphasized" disabled={m.issues.length > 0 || !m.dirty || m.saving || !draft.name.trim()}
                onClick={() => void m.save()}>
                {m.saving ? "Saving…" : "Save"}
              </Button>
              {/* No setDirty(false) here, unlike Delete: leaving with edits is exactly the case the
                  blocker's "Discard changes?" exists for. */}
              <Button disabled={m.saving} onClick={() => void navigate({ to: "/models" })}>Cancel</Button>
            </>
          } />
        }
      >
        <ObjectPageSection id="settings" titleText={secTitle("settings")}>
          <SettingsTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            portalMeta={portalMeta} setPortalMeta={m.setPortalMeta} />
        </ObjectPageSection>
        <ObjectPageSection id="params" titleText={secTitle("params")}>
          <ParamsTab modelId={id ?? ""} draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            lookups={lookups.data} lookupsFailed={!!lookups.error} onRetryLookups={() => void lookups.refetch()} />
        </ObjectPageSection>
        <ObjectPageSection id="rules" titleText={secTitle("rules")}>
          {rulesSubSections}
        </ObjectPageSection>
        <ObjectPageSection id="outputs" titleText={secTitle("outputs")}>
          {linesSubSections}
        </ObjectPageSection>
        <ObjectPageSection id="history" titleText={secTitle("history")}>
          {history.subSections}
        </ObjectPageSection>
      </ObjectPage>
    </div>
  );
}

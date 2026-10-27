import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, Icon, Label,
  ObjectPage, ObjectPageSection, ObjectPageTitle, SegmentedButton, SegmentedButtonItem,
  Text, Title, Toolbar, ToolbarItem,
} from "@ui5/webcomponents-react";
import type { Issue } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { useModelDraft } from "./draftScope.tsx";
import { useSectionParam } from "../../lib/sectionParam.ts";
import { useI18n } from "../../i18n.ts";
import { PageMessages } from "../PageMessages.tsx";
import { builderMessages, sectionTitle, type Translate } from "./builderMessages.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { SettingsTab } from "./SettingsTab.tsx";
import { ParamsTab, type PreviewAt } from "./ParamsTab.tsx";
import { RulesTab } from "./RulesTab.tsx";
import { ItemStructureTab } from "./ItemStructureTabs.tsx";
import { HistoryTab } from "./HistoryTab.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

const PREVIEW_AT: { key: PreviewAt; icon: string; tip: string }[] = [
  { key: "left", icon: "arrow-left", tip: "MODEL_PREVIEW_LEFT" },
  { key: "top", icon: "arrow-top", tip: "MODEL_PREVIEW_ABOVE" },
  { key: "bottom", icon: "arrow-bottom", tip: "MODEL_PREVIEW_BELOW" },
  { key: "right", icon: "arrow-right", tip: "MODEL_PREVIEW_RIGHT" },
  { key: "hidden", icon: "hide", tip: "MODEL_PREVIEW_HIDE" },
];
const PREVIEW_AT_KEY = "modelBuilder.previewAt";

export function ModelBuilderPage({ id }: { id?: string }) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const m = useModelDraft();
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const sectionParam = useSectionParam();
  // A layout preference, so per browser like density/theme in AppShell rather than per model.
  const [previewAt, setPreviewAt] = useState<PreviewAt>(
    () => (localStorage.getItem(PREVIEW_AT_KEY) as PreviewAt | null) ?? "right",
  );
  // Both keys: `list` backs GlobalSearch, `rows` backs the paged list page.
  const invalidateLists = () => {
    void qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
  };
  // Copies the *persisted* model, hence disabled while dirty. Delete is not dirty-gated —
  // discarding the edits is the point — so it clears the flag before the blocker can ask.
  const duplicate = useMutation(orpc.models.duplicate.mutationOptions({
    onSuccess: (r) => { invalidateLists(); toast(t("MODEL_TOAST_DUPLICATED")); void navigate({ to: "/$slug/models/$id", params: { id: r.id } }); },
  }));
  const remove = useMutation(orpc.models.remove.mutationOptions({
    onSuccess: () => { m.setDirty(false); invalidateLists(); toast(t("MODEL_TOAST_DELETED")); void navigate({ to: "/$slug/models" }); },
  }));

  // Same lookups feed the params preview and RulesTab's combo-table cells. Query definitions are
  // tenant masterdata, so nothing about the unsaved draft affects them.
  const lookups = usePreviewLookups(m.draft, { enabled: true });
  const allIssues: Issue[] = [...m.issues, ...m.serverIssues];
  const draft = m.draft;

  // One list drives the title's message popover AND the per-section counts, so a tab can never
  // claim a different number of problems than the popover lists under it.
  const messages = builderMessages({
    draft,
    issues: allIssues,
    tried: m.tried,
    saveError: m.saveError,
    actionError: (remove.error ?? duplicate.error) as Error | null,
    lookupsError: lookups.error as Error | null,
    t,
  });
  const secTitle = (secId: string) => {
    const title = sectionTitle(t, secId);
    const n = messages.filter((x) => x.section === secId && x.type === "Negative").length;
    return n ? t("MODEL_TAB_COUNT", title, String(n)) : title;
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <ObjectPage
        mode="IconTabBar"
        style={{ flex: 1, minHeight: 0, height: "100%" }}
        {...sectionParam.props}
        titleArea={
          <ObjectPageTitle
            breadcrumbs={<PageBreadcrumbs items={[{ text: t("NAV_MODELS"), to: "/models" }]} current={draft.name.trim() || t("MODEL_NEW")} />}
            header={
              // Trailing * is the unsaved-changes mark; the native tooltip is what says so, since
              // ObjectPageTitle has no draft-indicator slot of its own.
              <Title level="H4" title={m.dirty ? t("MODEL_UNSAVED") : undefined}>
                {(draft.name.trim() || t("MODEL_NEW")) + (m.dirty ? " *" : "")}
              </Title>
            }
            subHeader={draft.description ? <Text>{draft.description}</Text> : undefined}
            // Only the Parameters tab has a preview to place, so the picker isn't drawn dead elsewhere.
            navigationBar={sectionParam.props.selectedSectionId === "params" ? (
              <Toolbar design="Transparent">
                <ToolbarItem overflowPriority="NeverOverflow">
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Icon name="show" />
                    <Label>{t("MODEL_PREVIEW")}</Label>
                    <SegmentedButton accessibleName={t("MODEL_PREVIEW_POSITION")} itemsFitContent
                      onSelectionChange={(e) => {
                        const key = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.key as PreviewAt | undefined;
                        if (key) { setPreviewAt(key); localStorage.setItem(PREVIEW_AT_KEY, key); }
                      }}>
                      {PREVIEW_AT.map((p) => (
                        <SegmentedButtonItem key={p.key} data-key={p.key} icon={p.icon} tooltip={t(p.tip)}
                          accessibleName={t(p.tip)} selected={previewAt === p.key} />
                      ))}
                    </SegmentedButton>
                  </div>
                </ToolbarItem>
              </Toolbar>
            ) : undefined}
            actionsBar={
              <Toolbar design="Transparent">
                {/* Every error, warning and blocker on the page, grouped by the tab it belongs to —
                    this is the only place they are reported, so it sits before the actions it
                    explains the disabled state of. */}
                <PageMessages messages={messages}
                  okText={m.tried ? t("MODEL_OK_VALID") : t("MODEL_OK_UNTRIED")}
                  onSection={sectionParam.go} />
                {id ? (
                  <Button icon="copy" design="Transparent" disabled={m.dirty || duplicate.isPending}
                    tooltip={m.dirty ? t("MODEL_SAVE_FIRST") : t("MODEL_DUPLICATE_TIP")}
                    onClick={() => duplicate.mutate({ id })}>
                    {t("MODEL_DUPLICATE")}
                  </Button>
                ) : null}
                {id ? (
                  <Button icon="delete" design="Transparent" disabled={remove.isPending}
                    onClick={async () => {
                      if (await confirm({
                        title: t("MODEL_DELETE_TITLE"),
                        message: t("MODEL_DELETE_IN_USE", draft.name || t("MODEL_THIS_MODEL")),
                        actionText: t("MODEL_DELETE"), destructive: true,
                      })) remove.mutate({ ids: [id] });
                    }}>
                    {t("MODEL_DELETE")}
                  </Button>
                ) : null}
              </Toolbar>
            }
          />
        }
        footerArea={
          <Bar design="FloatingFooter" endContent={
            <>
              {/* Not disabled on issues: pressing it is what turns the empty mandatory fields red,
                  and the popover above already carries the list. */}
              <Button design="Emphasized" disabled={!m.dirty || m.saving}
                onClick={() => void m.save()}>
                {m.saving ? t("MODEL_SAVING") : t("MODEL_SAVE")}
              </Button>
              {/* No setDirty(false) here, unlike Delete: leaving with edits is exactly the case the
                  blocker's "Discard changes?" exists for. */}
              <Button disabled={m.saving} onClick={() => void navigate({ to: "/$slug/models" })}>{t("MODEL_CANCEL")}</Button>
            </>
          } />
        }
      >
        <ObjectPageSection id="settings" titleText={secTitle("settings")}>
          <SettingsTab modelId={id} draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            tried={m.tried} />
        </ObjectPageSection>
        {/* fitContent: the section fills what the title and tab bar leave instead of growing with the
            tree, which is the only way the splitter's panes get a height to split and scroll. */}
        <ObjectPageSection id="params" titleText={secTitle("params")} fitContent>
          <ParamsTab modelId={id} draft={draft} update={m.update} issues={allIssues} tables={m.tableCols}
            lookups={lookups.data} lookupsFailed={!!lookups.error} onRetryLookups={() => void lookups.refetch()}
            previewAt={previewAt} />
        </ObjectPageSection>
        <ObjectPageSection id="rules" titleText={secTitle("rules")}>
          <RulesTab draft={draft} update={m.update} issues={allIssues} lookups={lookups.data} tables={m.tableCols} />
        </ObjectPageSection>
        <ObjectPageSection id="outputs" titleText={secTitle("outputs")}>
          <ItemStructureTab draft={draft} update={m.update} issues={allIssues} tables={m.tableCols} />
        </ObjectPageSection>
        <ObjectPageSection id="history" titleText={secTitle("history")}>
          <HistoryTab draft={draft} update={m.update} issues={allIssues} />
        </ObjectPageSection>
      </ObjectPage>
    </div>
  );
}

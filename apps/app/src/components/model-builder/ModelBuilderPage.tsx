import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, MessageStrip, ToggleButton } from "@ui5/webcomponents-react";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { orpc } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { MODEL_SECTIONS } from "../../features/model/model.ts";
import { defOf, withDef } from "../../features/model/record.ts";
import { useModelDraft } from "./draftScope.tsx";
import { builderMessages, type Translate } from "./builderMessages.ts";
import { builderControls } from "./controls.tsx";
import { ParamsTab, usePreviewShown } from "./ParamsTab.tsx";
import { CombinationTables } from "./CombinationTables.tsx";
import { usePreviewLookups } from "./usePreviewLookups.ts";

/** The model: the shared Object Page over the scope's record, in tabs, always editing. */
export function ModelBuilderPage() {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const m = useModelDraft();
  const { id } = m;
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const invalidateLists = () => void qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
  // Copies the *stored* model, hence disabled while dirty. Delete is not dirty-gated — discarding the
  // edits is the point — so it leaves past the guard.
  const duplicate = useMutation(orpc.models.duplicate.mutationOptions({
    onSuccess: (r) => { invalidateLists(); toast(t("MODEL_TOAST_DUPLICATED")); void navigate({ to: "/$slug/models/$id", params: { id: r.id } }); },
  }));
  const remove = useMutation(orpc.models.remove.mutationOptions({
    onSuccess: () => { invalidateLists(); toast(t("MODEL_TOAST_DELETED")); void navigate({ to: "/$slug/models", ignoreBlocker: true }); },
  }));

  // Same lookups feed the preview and the combination tables' cells. Query definitions are tenant
  // masterdata, so nothing about the unsaved model affects them.
  const lookups = usePreviewLookups(m.def, { enabled: true });
  const md = useQuery(orpc.masterdata.list.queryOptions());
  const historyTable = m.def.history?.table;
  const historyCols = (md.data ?? []).find((x) => x.kind === "query" && x.name === historyTable)?.query?.columns ?? [];

  const messages = builderMessages({
    issues: m.issues, shown: m.record.showsIssues, t,
    actionError: (remove.error ?? duplicate.error) as Error | null,
    lookupsError: lookups.error as Error | null,
    title: (s) => m.sections.find((x) => x.id === s)?.label ?? s,
  });
  const name = m.def.name.trim() || t("MODEL_THIS_MODEL");
  const [showPreview, setShowPreview] = usePreviewShown();
  // The switch only means something beside the structure tree, so the other tabs go without it.
  const onParams = useSearch({ strict: false, select: (s) => (s as { section?: string }).section }) === MODEL_SECTIONS.params;

  return (
    <ObjectPage record={m.record} entity="Model" localViews mode="tabs"
      header={{
        titleField: "name",
        subtitleFields: ["description"],
        createTitle: t("MODEL_NEW"),
        navigationActions: onParams ? () => (
          <ToggleButton icon="detail-view" design="Transparent" pressed={showPreview}
            tooltip={t(showPreview ? "MODEL_PREVIEW_HIDE" : "MODEL_PREVIEW_SHOW")}
            onClick={() => setShowPreview(!showPreview)}>
            {t("MODEL_PREVIEW")}
          </ToggleButton>
        ) : undefined,
        actions: id ? () => (
          <>
            <Button icon="copy" design="Transparent" disabled={m.record.dirty || duplicate.isPending}
              tooltip={m.record.dirty ? t("MODEL_SAVE_FIRST") : t("MODEL_DUPLICATE_TIP")}
              onClick={() => duplicate.mutate({ id })}>
              {t("MODEL_DUPLICATE")}
            </Button>
            <Button icon="delete" design="Transparent" disabled={remove.isPending}
              onClick={async () => {
                if (await confirm({
                  title: t("MODEL_DELETE_TITLE"), message: t("MODEL_DELETE_IN_USE", name),
                  actionText: t("MODEL_DELETE"), destructive: true,
                })) remove.mutate({ ids: [id] });
              }}>
              {t("MODEL_DELETE")}
            </Button>
          </>
        ) : undefined,
      }}
      breadcrumbs={[{ text: t("NAV_MODELS"), to: "/models" }]}
      messages={messages}
      controls={builderControls({ scope: () => m.def, tables: m.tableCols })}
      sectionTemplates={{
        params: (ctx) => (
          <ParamsTab modelId={id} draft={defOf(ctx.formData)} update={(fn) => ctx.update(withDef(fn))}
            issues={m.issues} tables={m.tableCols}
            lookups={lookups.data} lookupsFailed={!!lookups.error} onRetryLookups={() => void lookups.refetch()}
            showPreview={showPreview} />
        ),
      }}
      subsectionTemplates={{
        combinations: (ctx) => (
          <CombinationTables draft={defOf(ctx.formData)} lookups={lookups.data}
            update={(fn) => ctx.update(withDef(fn))} />
        ),
        // The query's columns are stored when its masterdata row is saved; until then nothing here
        // has anything to pick from.
        source: (ctx) => (
          <>
            {historyTable && !historyCols.length ? (
              <MessageStrip design="Information" hideCloseButton style={{ marginBlockEnd: "0.5rem" }}>{t("MODEL_HISTORY_COLS_HINT")}</MessageStrip>
            ) : null}
            {ctx.content}
          </>
        ),
      }} />
  );
}

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bar, Button, BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { localizedB1Feature } from "../../features/b1/localize.ts";
import { useFieldConstraints } from "@confire/ui/metadata.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";

// The last step of a configuration, as the Quotations document it actually is: the declared
// Quotations object page, in create mode, opened on a server-built draft.
//
// The draft — lines, quantities, prices, the dedup key — is recomputed from the persisted project on
// every read (`configs.quoteDraft`); this page shows it and posts the header the salesperson typed
// over it. The lines are locked: they come from the item matrix, which is where the cost sits next
// to the price, and editing them here would leave the document disagreeing with the configuration
// that produced it.
//
// The write still goes through `configs.createQuote`, not the generic `entities.create`: that is the
// only path with the U_CF_Key check-then-create, the status -> quoted transition and the
// quotedValue/quotedCost write.

const LOCKED = ["DocumentLines"];
/** A client's request is quoted to the client's own business partner (spec §10). */
const LOCKED_REQUEST = ["DocumentLines", "CardCode"];

export function QuoteCreatePage({ projectId }: { projectId: string }) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  // A language change replaces the bundle object, so this copy of the quotation form follows it.
  const quotations = useMemo(
    () => localizedB1Feature("Quotations", (key, ...args) => i18n.getText(key, ...args.map(String)))!,
    [i18n],
  );
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const meta = useFieldConstraints("Quotations");
  const draft = useQuery({ ...orpc.configs.quoteDraft.queryOptions({ input: { projectId } }), retry: false });
  const backToConfig = () => navigate({ to: "/$slug/configs/$id", params: { id: projectId } });
  // The lines' only editor: the configuration's items grid.
  const tableActions = {
    lines: () => (
      <Button icon="edit" design="Transparent"
        onClick={backToConfig}>
        {t("CONFIG_EDIT_IN_CONFIG")}
      </Button>
    ),
  };
  const create = useMutation(orpc.configs.createQuote.mutationOptions());

  if (draft.isPending || meta.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (draft.error) return <PageError error={draft.error} />;
  if (meta.error) return <PageError error={meta.error} />;

  const d = draft.data;
  if (d.quoted) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
        <MessageStrip design="Positive" hideCloseButton>
          {t("CONFIG_QUOTE_CREATED", String(d.quoted.docEntry))}
        </MessageStrip>
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" onClick={() => navigate({
              to: "/$slug/b1/$entity/$key",
              params: { entity: "Quotations", key: String(d.quoted!.docEntry) },
            })}>
              {t("CONFIG_OPEN_QUOTE")}
            </Button>
            <Button onClick={backToConfig}>{t("CONFIG_BACK")}</Button>
          </>
        } />
      </div>
    );
  }

  return (
    <ObjectPage
      isNew
      entity="Quotations"
      constraints={meta.data}
      data={d.data}
      sections={quotations.detail.sections}
      header={{ ...quotations.detail.header, createTitle: t("CONFIG_NEW_QUOTATION") }}
      lockedFields={d.portal ? LOCKED_REQUEST : LOCKED}
      localViews
      createLabel={d.replaces ? t("CONFIG_UPDATE_IN_SAP") : t("CONFIG_CREATE_IN_SAP")}
      // A reopened request re-quotes its quotation (spec §7.3) — said before the post, not after.
      notice={d.replaces ? (
        <MessageStrip design="Information" hideCloseButton>
          {t("CONFIG_REPLACES", String(d.replaces.docEntry))}
        </MessageStrip>
      ) : undefined}
      tableActions={tableActions}
      onCancelCreate={backToConfig}
      // A client's request is reached from Requests, a configuration from Configurations.
      breadcrumbs={[
        d.portal ? { text: t("NAV_REQUESTS"), to: "/requests" } : { text: t("NAV_CONFIGS"), to: "/configs" },
        { text: d.name.trim() || t("CONFIG_NEW"), to: `/configs/${projectId}` },
      ]}
      // The draft carries the commandId it was built from, so the server refuses to post a
      // selection that moved between preview and Create rather than quoting something else.
      onSave={async (header) => {
        const r = await create.mutateAsync({ projectId, commandId: d.commandId, header });
        void qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id: projectId } }).queryKey });
        void qc.invalidateQueries({ queryKey: orpc.requests.rows.key() });
        void qc.invalidateQueries({ queryKey: orpc.timeline.list.queryOptions({ input: { projectId } }).queryKey });
        // A request goes back to the request: its status and timeline are what moved.
        if (d.portal) {
          toast(r.mode === "updated" ? t("CONFIG_TOAST_QUOTE_UPDATED") : t("CONFIG_TOAST_QUOTE_SENT"));
          void backToConfig();
          return;
        }
        // SAP answers the POST with the whole document, which is exactly what entities.one reads —
        // so seed it and the quotation opens without a second Service Layer round trip. Absent when
        // the dedup UDF found the document instead of creating it; then the page reads it itself.
        if (r.row) {
          qc.setQueryData(
            orpc.entities.one.queryOptions({ input: { entity: "Quotations", key: r.docEntry } }).queryKey,
            { row: r.row, etag: r.etag },
          );
        }
        void navigate({ to: "/$slug/b1/$entity/$key", params: { entity: "Quotations", key: String(r.docEntry) } });
      }}
    />
  );
}

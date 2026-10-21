import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bar, Button, BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { toast } from "@confire/ui/toast.ts";
import { orpc, useIsAdmin } from "../../orpc.ts";
import { b1Feature } from "../../features/b1/index.ts";
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

const QUOTATIONS = b1Feature("Quotations")!;
const LOCKED = ["DocumentLines"];
/** A client's request is quoted to the client's own business partner (spec §10). */
const LOCKED_REQUEST = ["DocumentLines", "CardCode"];

export function QuoteCreatePage({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  // The B1 pages are admin/owner only — _admin bounces everyone else off /b1 — so a plain member
  // stays here and reads the confirmation rather than being thrown back to the dashboard.
  const canOpenInB1 = useIsAdmin();
  const meta = useFieldConstraints("Quotations");
  const draft = useQuery({ ...orpc.configs.quoteDraft.queryOptions({ input: { projectId } }), retry: false });
  const backToConfig = () => navigate({ to: "/$slug/configs/$id", params: { id: projectId } });
  // The lines' only editor: the configuration's items grid, on the Configure tab.
  const tableActions = {
    lines: () => (
      <Button icon="edit" design="Transparent"
        onClick={() => navigate({ to: "/$slug/configs/$id", params: { id: projectId }, search: { section: "configure" } })}>
        Edit in configurator
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
          {`Quotation created in SAP (DocEntry ${d.quoted.docEntry}).`}
        </MessageStrip>
        <Bar design="Footer" endContent={
          <>
            {canOpenInB1 ? (
              <Button design="Emphasized" onClick={() => navigate({
                to: "/$slug/b1/$entity/$key",
                params: { entity: "Quotations", key: String(d.quoted!.docEntry) },
              })}>
                Open quotation
              </Button>
            ) : null}
            <Button onClick={backToConfig}>Back to configuration</Button>
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
      sections={QUOTATIONS.detail.sections}
      header={{ ...QUOTATIONS.detail.header, createTitle: "New quotation" }}
      lockedFields={d.portal ? LOCKED_REQUEST : LOCKED}
      localViews
      createLabel={d.replaces ? "Update in SAP" : "Create in SAP"}
      // A reopened request re-quotes its quotation (spec §7.3) — said before the post, not after.
      notice={d.replaces ? (
        <MessageStrip design="Information" hideCloseButton>
          {`This updates quotation ${d.replaces.docEntry} in SAP with these lines. If SAP has closed it since, a new quotation is created instead.`}
        </MessageStrip>
      ) : undefined}
      tableActions={tableActions}
      onCancelCreate={backToConfig}
      // The draft carries the commandId it was built from, so the server refuses to post a
      // selection that moved between preview and Create rather than quoting something else.
      onSave={async (header) => {
        const r = await create.mutateAsync({ projectId, commandId: d.commandId, header });
        void qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id: projectId } }).queryKey });
        void qc.invalidateQueries({ queryKey: orpc.requests.rows.key() });
        void qc.invalidateQueries({ queryKey: orpc.timeline.list.queryOptions({ input: { projectId } }).queryKey });
        // A request goes back to the request: its status and timeline are what moved.
        if (d.portal) {
          toast(r.mode === "updated" ? "Quotation updated — the client can answer it now" : "Quotation sent — the client can answer it now");
          void backToConfig();
          return;
        }
        if (!canOpenInB1) {
          void draft.refetch(); // staying: the confirmation needs `quoted`
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

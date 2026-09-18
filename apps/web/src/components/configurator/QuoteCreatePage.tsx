import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bar, Button, BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { EntityObjectPage } from "../b1/EntityObjectPage.tsx";
import { meQuery, orpc } from "../../orpc.ts";

// The last step of a configuration, as the Quotations document it actually is: the same object page
// every other B1 document gets, opened on a server-built draft.
//
// The draft — lines, quantities, prices, the dedup key — is recomputed from the persisted project on
// every read (`configs.quoteDraft`); this page shows it and posts the header the salesperson typed
// over it. The lines are deliberately read-only: they come from the item matrix, which is where the
// cost sits next to the price, and editing them here would leave the document disagreeing with the
// configuration that produced it.
//
// The write still goes through `configs.createQuote`, not the generic `entities.create`: that is the
// only path with the U_CF_Key check-then-create, the status -> quoted transition and the
// quotedValue/quotedCost write.
export function QuoteCreatePage({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The B1 pages are admin/owner only — _authed bounces everyone else off /b1 — so a plain member
  // stays here and reads the confirmation rather than being thrown back to the dashboard.
  const me = useQuery(meQuery);
  const canOpenInB1 = me.data?.role === "admin" || me.data?.role === "owner";
  const draft = useQuery({ ...orpc.configs.quoteDraft.queryOptions({ input: { projectId } }), retry: false });
  const backToConfig = () => navigate({ to: "/configs/$id", params: { id: projectId } });

  const create = useMutation(orpc.configs.createQuote.mutationOptions({
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id: projectId } }).queryKey });
      if (!canOpenInB1) { void draft.refetch(); return; } // staying: the strip needs `quoted`
      // SAP answers the POST with the whole document, which is exactly what entities.one reads —
      // so seed it and the quotation opens without a second Service Layer round trip. Absent when
      // the dedup UDF found the document instead of creating it; then the page reads it itself.
      // The key is the number DocEntry because that is what EntityObjectPage coerces it to.
      if (r.row) {
        qc.setQueryData(
          orpc.entities.one.queryOptions({ input: { entity: "Quotations", key: r.docEntry } }).queryKey,
          { row: r.row, etag: r.etag },
        );
      }
      void navigate({ to: "/b1/$entity/$key", params: { entity: "Quotations", key: String(r.docEntry) } });
    },
  }));

  if (draft.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (draft.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{draft.error.message}</MessageStrip>;

  const d = draft.data!;
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
                to: "/b1/$entity/$key",
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
    <EntityObjectPage
      entity="Quotations"
      create={{
        row: d.data,
        title: "New quotation",
        notice: (
          <MessageStrip design="Information" hideCloseButton>
            Lines and prices come from the configuration's items grid. Change them there.
          </MessageStrip>
        ),
        saving: create.isPending,
        error: create.error?.message ?? null,
        // The draft carries the commandId it was built from, so the server refuses to post a
        // selection that moved between preview and Create rather than quoting something else.
        onSave: (header) => create.mutate({ projectId, commandId: d.commandId, header }),
        onCancel: backToConfig,
      }}
    />
  );
}

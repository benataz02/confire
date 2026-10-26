import { useMemo, useState } from "react";
import { createFileRoute, redirect, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import { client, orpc } from "../../../../orpc.ts";
import { useI18n } from "../../../../i18n.ts";
import { b1Feature } from "../../../../features/b1/index.ts";
import { localizedB1Feature } from "../../../../features/b1/localize.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { useFieldConstraints } from "@confire/ui/metadata.ts";
import { useListView } from "@confire/ui/useListView.ts";
import { useDetailView } from "@confire/ui/useDetailView.ts";
import { useEntityNav } from "@confire/ui/EntityLink.tsx";
import { toast } from "@confire/ui/toast.ts";
import { useUiI18n } from "@confire/ui/i18n.ts";
import { PrintActions } from "@confire/ui/PrintActions.tsx";
import { CloseQuotations, CopyTo } from "../../../../features/b1/documents.tsx";
import { InviteNewClientDialog } from "../../../../components/portal/BpPortal.tsx";
import { b1Label } from "../../../../components/AppShell.tsx";
import type { EntityFeature, ListQuery, Row } from "@confire/ui/types.ts";

// One declared B1 entity's list — or, with the `#create` fragment, its object page in create mode
// (Beas' createModeMatch: `/items#create` is the detail component, `/items` the list), or with
// `#copy`, a copy's draft (`?from=Orders&docs=1,2`, opened by Copy to). Only the declared features
// have a page; any other entity set name goes home.

export const Route = createFileRoute("/$slug/_admin/b1/$entity")({
  beforeLoad: ({ params }) => {
    if (!b1Feature(params.entity)) throw redirect({ to: "/$slug", params });
  },
  component: EntityPage,
});

function EntityPage() {
  const { entity } = Route.useParams();
  const i18n = useI18n();
  // The resolved location's hash, like the params: the pending one runs ahead of them, and Copy to's
  // jump from /b1/Orders to /b1/DeliveryNotes#copy drew Orders' draft for one render.
  const hash = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).hash });
  // beforeLoad already checked the English registry. This copy is what the page draws.
  const feature = useMemo(
    () => localizedB1Feature(entity, (key, ...args) => i18n.getText(key, ...args))!,
    [entity, i18n],
  );
  if (hash === "create") return <EntityCreate key={entity} feature={feature} />;
  if (hash === "copy") return <EntityCopy key={entity} feature={feature} />;
  return <EntityList key={entity} feature={feature} />;
}

const NO_QUERY: ListQuery = { select: [], filter: [], orderby: [] };

function EntityList({ feature }: { feature: EntityFeature }) {
  const i18n = useI18n();
  const { entity } = feature;
  const qc = useQueryClient();
  const meta = useFieldConstraints(entity);
  const [query, setQuery] = useState<ListQuery | null>(null);
  // The cursor is B1's own @odata.nextLink, sealed server-side; page 1 also asks for the count.
  const data = useListView(
    {
      ...orpc.entities.rows.infiniteOptions({
        input: (cursor: string | undefined) => ({ entity, query: query ?? NO_QUERY, ...(cursor ? { cursor } : { count: true }) }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor,
      }),
      enabled: !!query && !!meta.data,
    },
    { route: `/b1/${entity}`, keyOf: (r) => r[feature.keyField], create: true },
  );
  // The server never re-reads $metadata on its own (a UDF added in B1 waits for this button).
  const refresh = useMutation({
    mutationFn: () => client.entities.metadata({ entity, refresh: true }),
    onSuccess: (fresh) => qc.setQueryData(orpc.entities.metadata.queryOptions({ input: { entity } }).queryKey, fresh),
  });
  const [inviting, setInviting] = useState(false);

  if (meta.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (meta.error) return <PageError error={meta.error} />;
  const printable = meta.data.printable;

  return (
    <>
      <ListReport
        feature={feature.list}
        constraints={meta.data.fields}
        data={data}
        onQuery={setQuery}
        keyOf={(r) => String(r[feature.keyField] ?? "")}
        readOnly={!meta.data.writable}
        error={refresh.error}
        headerActions={
          <Toolbar design="Transparent">
            {/* A new client, no CardCode yet (spec §5.1). /b1 is admin/owner only, as is the call. */}
            {entity === "BusinessPartners" ? (
              <ToolbarButton design="Transparent" icon="paper-plane" text={i18n.getText("ADMIN_INVITE_NEW_CLIENT")} onClick={() => setInviting(true)} />
            ) : null}
            <ToolbarButton design="Transparent" icon="refresh" tooltip={i18n.getText("ADMIN_REFRESH_SAP_FIELDS")} accessibleName={i18n.getText("ADMIN_REFRESH_SAP_FIELDS")}
              disabled={refresh.isPending} onClick={() => refresh.mutate()} />
          </Toolbar>
        }
        toolbarActions={printable ? ({ rows, clear }) => {
          const docEntry = rows.length === 1 ? Number((rows[0] as Row).DocEntry) : NaN;
          return (
            <>
              {/* Keyed by the selected document: a new selection remounts it, which drops a stale
                  error and closes any open preview — PrintActions releases the blob URL in its own
                  cleanup. No single row selected is NaN, which draws it disabled. */}
              <PrintActions key={docEntry} entity={entity} docEntry={docEntry} />
              <CopyTo entity={entity} flows={meta.data.flows.filter((f) => b1Feature(f.target))} rows={rows as Row[]} />
              {entity === "Quotations" && rows.length ? <CloseQuotations rows={rows as Row[]} onClosed={clear} /> : null}
            </>
          );
        } : undefined}
      />
      {inviting ? <InviteNewClientDialog onClose={() => setInviting(false)} /> : null}
    </>
  );
}

function EntityCreate({ feature }: { feature: EntityFeature }) {
  const i18n = useI18n();
  const open = useEntityNav();
  const route = `/b1/${feature.entity}`;
  const d = useDetailView({ entity: feature.entity, route, isNew: true });
  // Fresh per "Create and new": the epoch is what makes a new, empty record.
  const seed = useMemo(() => feature.detail.createDefaults?.() ?? {}, [feature, d.createEpoch]);

  if (d.loading) return <ObjectPageSkeleton />;
  if (d.error || !d.constraints) return <PageError error={d.error ?? new Error(i18n.getText("ADMIN_NO_METADATA"))} />;
  if (!d.constraints.writable) return <PageError error={new Error(i18n.getText("ADMIN_READONLY", d.constraints.label))} />;
  return (
    <ObjectPage key={d.createEpoch} isNew entity={feature.entity} constraints={d.constraints} data={seed}
      sections={feature.detail.sections} header={feature.detail.header}
      onSave={d.save} onCancelCreate={() => open(route)}
      breadcrumbs={[{ text: b1Label(feature.entity, (k) => i18n.getText(k)), to: route }]} />
  );
}

const CREATED: Record<string, string> = {
  Orders: "ADMIN_CREATED_ORDER",
  DeliveryNotes: "ADMIN_CREATED_DELIVERY",
  Invoices: "ADMIN_CREATED_INVOICE",
};

/** Copy to's draft: the target document built from its sources, unposted, on the target's own
 *  object page in create mode. The server draws the form (`copyDraft`: only the copy's allowlist is
 *  editable) and Save posts through `copy`, which rebuilds the document from the sources and lays the
 *  changes over it — the browser never sends a line's base. DeliveryNotes and Invoices have no other
 *  create page. In the URL, so a reload rebuilds it. */
function EntityCopy({ feature }: { feature: EntityFeature }) {
  const i18n = useI18n();
  // One Create, not the create-and-new split: a second post of the same draft would copy it twice.
  const ui = useUiI18n();
  const qc = useQueryClient();
  const open = useEntityNav();
  const search = Route.useSearch() as { from?: unknown; docs?: unknown };
  const input = {
    sourceEntity: String(search.from ?? ""),
    targetEntity: feature.entity,
    docEntries: String(search.docs ?? "").split(",").filter(Boolean).map(Number).filter(Number.isInteger),
  };
  // A draft is the sources as they were on opening: a refetch would replace the form under the user.
  const draft = useQuery({ ...orpc.entities.copyDraft.queryOptions({ input }), staleTime: Infinity, refetchOnWindowFocus: false, retry: false });
  const copy = useMutation(orpc.entities.copy.mutationOptions());
  const sections = useMemo(
    () => feature.detail.sections.map((s) => (s.table ? { ...s, table: { ...s.table, fixedRows: true } } : s)),
    [feature],
  );
  const back = () => open(`/b1/${input.sourceEntity}`, input.docEntries.length === 1 ? input.docEntries[0] : undefined);

  if (draft.isPending) return <ObjectPageSkeleton />;
  if (draft.error) return <PageError error={draft.error} />;
  return (
    <ObjectPage isNew entity={feature.entity} constraints={draft.data.constraints} data={draft.data.draft}
      sections={sections} header={feature.detail.header} createLabel={ui.getText("UI_CREATE")}
      onSave={async (diff) => {
        // The diff holds what changed: header fields, and the lines whole once any was edited or
        // deleted. Lines left alone are all of them (an emptied grid never gets here: lines are required).
        const { DocumentLines, ...header } = diff;
        const lines = Array.isArray(DocumentLines)
          ? (DocumentLines as Row[]).map((l) => ({ baseEntry: Number(l.BaseEntry), baseLine: Number(l.BaseLine), quantity: Number(l.Quantity) }))
          : undefined;
        const r = await copy.mutateAsync({ ...input, header, lines });
        // The sources' lines are closed now; their status in any cached list or record is stale.
        void qc.invalidateQueries({ queryKey: orpc.entities.one.key() });
        void qc.invalidateQueries({ queryKey: orpc.entities.rows.key() });
        const num = String(r.docNum ?? r.docEntry);
        toast(CREATED[r.entity] ? i18n.getText(CREATED[r.entity]!, num) : `${r.entity} ${num} created`);
        open(`/b1/${r.entity}`, r.docEntry);
      }}
      onCancelCreate={back}
      breadcrumbs={[{ text: b1Label(feature.entity, (k) => i18n.getText(k)), to: `/b1/${feature.entity}` }]} />
  );
}

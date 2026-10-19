import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardHeader, IllustratedMessage, List, ListItemStandard, MessageStrip, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { money } from "@confire/ui/money.ts";
import { meQuery, orpc } from "../../../orpc.ts";
import { DOC_PAGES } from "../../../features/documents.ts";

export const Route = createFileRoute("/$slug/_authed/")({
  component: Home,
});

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))", gap: "1rem", alignItems: "start" } as const;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const date = (d: string | Date | null) => (d ? new Date(d).toLocaleDateString() : "");

/** The overview (spec §9): requests by status and quotes awaiting an answer from Postgres, recent
 *  documents and open invoices live from SAP — two calls, so a down agent costs two cards. */
function Home() {
  const navigate = useNavigate({ from: "/$slug" });
  // Primed by _authed's beforeLoad, which only lets a user with a seat through.
  const me = useQuery(meQuery).data!;
  const overview = useQuery(orpc.home.overview.queryOptions());
  const documents = useQuery({ ...orpc.home.documents.queryOptions(), retry: false });
  const counts = overview.data?.byStatus ?? {};
  const statuses = (Object.keys(PROJECT_STATUS) as (keyof typeof PROJECT_STATUS)[]).filter((s) => counts[s]);
  const openDoc = (entity: string, key: number) => void navigate({ to: "/$slug/docs/$entity/$key", params: { entity, key: String(key) } });
  const sapDown = documents.error
    ? <MessageStrip design="Critical" hideCloseButton style={{ margin: "1rem" }}>{`Can't reach ${me.tenant.name}'s documents right now: ${documents.error.message}`}</MessageStrip>
    : null;

  return (
    <div style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <Title level="H2">Welcome, {me.user.name}</Title>
        <Text style={{ color: "var(--sapContent_LabelColor)", marginTop: "0.5rem" }}>
          {me.company!.cardName} · {me.tenant.name}'s customer portal
        </Text>
      </div>
      {overview.error ? <MessageStrip design="Negative" hideCloseButton>{overview.error.message}</MessageStrip> : null}
      <div style={GRID}>
        <Card loading={overview.isPending} accessibleName="Your requests"
          header={<CardHeader interactive titleText="Your requests" subtitleText="Projects by status"
            onClick={() => void navigate({ to: "/$slug/projects" })} />}>
          {statuses.length ? (
            <List>
              {statuses.map((s) => (
                <ListItemStandard key={s} additionalText={String(counts[s])} additionalTextState={PROJECT_STATUS[s].state}>
                  {PROJECT_STATUS[s].text}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoEntries" design="Spot" titleText="No projects yet"
              subtitleText={`Create one to request a quote from ${me.tenant.name}.`} />
          )}
        </Card>

        <Card loading={overview.isPending} accessibleName="Quotes awaiting your response"
          header={<CardHeader titleText="Quotes awaiting your response" additionalText={String(overview.data?.awaiting.length ?? "")} />}>
          {overview.data?.awaiting.length ? (
            <List>
              {overview.data.awaiting.map((p) => (
                <ListItemStandard key={p.id} type="Navigation" description={`Quoted ${date(p.quotedAt)}`}
                  onClick={() => void navigate({ to: "/$slug/projects/$id", params: { id: p.id } })}>
                  {p.name}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoData" design="Spot" titleText="Nothing waiting for you" />
          )}
        </Card>

        <Card loading={documents.isPending} accessibleName="Recent documents"
          header={<CardHeader titleText="Recent documents" subtitleText="Quotations, orders and deliveries" />}>
          {sapDown ?? (documents.data?.recent.length ? (
            <List>
              {documents.data.recent.map((d) => (
                <ListItemStandard key={`${d.entity}:${d.docEntry}`} type="Navigation" icon={DOC_PAGES[d.entity].icon}
                  description={date(d.docDate)} additionalText={money(d.docTotal, d.currency || me.currency || undefined)}
                  onClick={() => openDoc(d.entity, d.docEntry)}>
                  {`${capital(DOC_PAGES[d.entity].one)} ${d.docNum}`}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoData" design="Spot" titleText="No documents yet" />
          ))}
        </Card>

        <Card loading={documents.isPending} accessibleName="Open invoices"
          header={<CardHeader interactive titleText="Open invoices" additionalText={documents.data ? String(documents.data.openInvoices.count) : ""}
            onClick={() => void navigate({ to: "/$slug/docs/$entity", params: { entity: "Invoices" } })} />}>
          {sapDown ?? (documents.data?.openInvoices.rows.length ? (
            <List>
              {documents.data.openInvoices.rows.map((d) => (
                <ListItemStandard key={d.docEntry} type="Navigation" icon="receipt" description={date(d.docDate)}
                  additionalText={money(d.docTotal, d.currency || me.currency || undefined)} additionalTextState="Critical"
                  onClick={() => openDoc(d.entity, d.docEntry)}>
                  {`Invoice ${d.docNum}`}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoData" design="Spot" titleText="No open invoices" />
          ))}
        </Card>
      </div>
    </div>
  );
}

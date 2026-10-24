import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardHeader, IllustratedMessage, List, ListItemStandard, MessageStrip, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { money } from "@confire/ui/money.ts";
import { meQuery, orpc } from "../../orpc.ts";
import { DOC_PAGES } from "../../features/documents.ts";
import { PROJECT_STATUS_KEY } from "../../features/labels.ts";
import { useI18n } from "../../i18n.ts";

export const Route = createFileRoute("/$slug/")({
  component: Home,
});

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))", gap: "1rem", alignItems: "start" } as const;
const date = (d: string | Date | null) => (d ? new Date(d).toLocaleDateString() : "");

/** The overview (spec §9): requests by status and quotes awaiting an answer from Postgres, recent
 *  documents and open invoices live from SAP — two calls, so a down agent costs two cards. */
function Home() {
  const i18n = useI18n();
  const navigate = useNavigate({ from: "/$slug" });
  // Primed by $slug's beforeLoad, which only lets a user with a seat through.
  const me = useQuery(meQuery).data!;
  const overview = useQuery(orpc.home.overview.queryOptions());
  const documents = useQuery({ ...orpc.home.documents.queryOptions(), retry: false });
  const counts = overview.data?.byStatus ?? {};
  const statuses = (Object.keys(PROJECT_STATUS) as (keyof typeof PROJECT_STATUS)[]).filter((s) => counts[s]);
  const openDoc = (entity: string, key: number) => void navigate({ to: "/$slug/docs/$entity/$key", params: { entity, key: String(key) } });
  const sapDown = documents.error
    ? <MessageStrip design="Critical" hideCloseButton style={{ margin: "1rem" }}>{i18n.getText("PORTAL_HOME_SAP_DOWN", me.tenant.name, documents.error.message)}</MessageStrip>
    : null;

  return (
    <div style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <Title level="H2">{i18n.getText("PORTAL_HOME_WELCOME", me.user.name)}</Title>
        <Text style={{ color: "var(--sapContent_LabelColor)", marginTop: "0.5rem" }}>
          {i18n.getText("PORTAL_HOME_SUBTITLE", me.company!.cardName, me.tenant.name)}
        </Text>
      </div>
      {overview.error ? <MessageStrip design="Negative" hideCloseButton>{overview.error.message}</MessageStrip> : null}
      <div style={GRID}>
        <Card loading={overview.isPending} accessibleName={i18n.getText("PORTAL_HOME_REQUESTS")}
          header={<CardHeader interactive titleText={i18n.getText("PORTAL_HOME_REQUESTS")} subtitleText={i18n.getText("PORTAL_HOME_BY_STATUS")}
            onClick={() => void navigate({ to: "/$slug/projects" })} />}>
          {statuses.length ? (
            <List>
              {statuses.map((s) => (
                <ListItemStandard key={s} additionalText={String(counts[s])} additionalTextState={PROJECT_STATUS[s].state}>
                  {i18n.getText(PROJECT_STATUS_KEY[s])}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoEntries" design="Spot" titleText={i18n.getText("PORTAL_HOME_NO_PROJECTS")}
              subtitleText={i18n.getText("PORTAL_HOME_NO_PROJECTS_SUB", me.tenant.name)} />
          )}
        </Card>

        <Card loading={overview.isPending} accessibleName={i18n.getText("PORTAL_HOME_AWAITING")}
          header={<CardHeader titleText={i18n.getText("PORTAL_HOME_AWAITING")} additionalText={String(overview.data?.awaiting.length ?? "")} />}>
          {overview.data?.awaiting.length ? (
            <List>
              {overview.data.awaiting.map((p) => (
                <ListItemStandard key={p.id} type="Navigation" description={i18n.getText("PORTAL_HOME_QUOTED", date(p.quotedAt))}
                  onClick={() => void navigate({ to: "/$slug/projects/$id", params: { id: p.id } })}>
                  {p.name}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoData" design="Spot" titleText={i18n.getText("PORTAL_HOME_NOTHING_WAITING")} />
          )}
        </Card>

        <Card loading={documents.isPending} accessibleName={i18n.getText("PORTAL_HOME_RECENT")}
          header={<CardHeader titleText={i18n.getText("PORTAL_HOME_RECENT")} subtitleText={i18n.getText("PORTAL_HOME_RECENT_SUB")} />}>
          {sapDown ?? (documents.data?.recent.length ? (
            <List>
              {documents.data.recent.map((d) => (
                <ListItemStandard key={`${d.entity}:${d.docEntry}`} type="Navigation" icon={DOC_PAGES[d.entity].icon}
                  description={date(d.docDate)} additionalText={money(d.docTotal, d.currency || me.currency || undefined)}
                  onClick={() => openDoc(d.entity, d.docEntry)}>
                  {i18n.getText(DOC_PAGES[d.entity].numKey, String(d.docNum))}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoData" design="Spot" titleText={i18n.getText("PORTAL_HOME_NO_DOCUMENTS")} />
          ))}
        </Card>

        <Card loading={documents.isPending} accessibleName={i18n.getText("PORTAL_HOME_OPEN_INVOICES")}
          header={<CardHeader interactive titleText={i18n.getText("PORTAL_HOME_OPEN_INVOICES")} additionalText={documents.data ? String(documents.data.openInvoices.count) : ""}
            onClick={() => void navigate({ to: "/$slug/docs/$entity", params: { entity: "Invoices" } })} />}>
          {sapDown ?? (documents.data?.openInvoices.rows.length ? (
            <List>
              {documents.data.openInvoices.rows.map((d) => (
                <ListItemStandard key={d.docEntry} type="Navigation" icon="receipt" description={date(d.docDate)}
                  additionalText={money(d.docTotal, d.currency || me.currency || undefined)} additionalTextState="Critical"
                  onClick={() => openDoc(d.entity, d.docEntry)}>
                  {i18n.getText("PORTAL_DOC_INVOICE_NUM", String(d.docNum))}
                </ListItemStandard>
              ))}
            </List>
          ) : (
            <IllustratedMessage name="NoData" design="Spot" titleText={i18n.getText("PORTAL_HOME_NO_OPEN_INVOICES")} />
          ))}
        </Card>
      </div>
    </div>
  );
}

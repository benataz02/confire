import { useEffect } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, CardHeader, FlexBox, IllustratedMessage, List, ListItemStandard, MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle,
  ObjectStatus, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowActionNavigation, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { Tile } from "@confire/ui/Tile.tsx";
import { RouterLink } from "@confire/ui/RouterLink.tsx";
import { money } from "@confire/ui/money.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { useGreeting } from "@confire/ui/greeting.ts";
import { meQuery, orpc } from "../../orpc.ts";
import { DOC_PAGES } from "../../features/documents.ts";
import { Journey, type HomeInquiry, type Next } from "../../components/Journey.tsx";
import { useI18n } from "../../i18n.ts";

// The portal home (spec 2026-11-06-portal-home): the customer's open inquiries and how far each has
// got — sent to invoiced — with the to-dos as tiles above them and the latest documents below. The server
// decides every step and figure; Postgres and SAP are separate calls, so a down agent costs the
// journey's refresh and the documents, never the page.
export const Route = createFileRoute("/$slug/")({ component: Home });

const STEP_KEYS = ["SENT", "REVIEW", "QUOTED", "ORDERED", "DELIVERED", "INVOICED"].map((s) => `PORTAL_HOME_STEP_${s}`);
const NEXT_STATE: Partial<Record<Next, "Critical" | "Negative" | "Positive" | "None">> = {
  answer: "Critical", changes: "Critical", declined: "Negative", done: "Positive", finish: "None",
};
const keyOf = (next: Next) => next.toUpperCase();

/** A date-only string is a calendar day, not UTC midnight (which shows the day before west of Greenwich). */
const day = (at: string) => new Date(at.length === 10 ? `${at}T00:00` : at)
  .toLocaleDateString(formatLocale(), { day: "numeric", month: "short" });

function Home() {
  const i18n = useI18n();
  const t = (key: string, ...params: (string | number)[]) => i18n.getText(key, ...params.map(String));
  const navigate = useNavigate({ from: "/$slug" });
  const router = useRouter();
  const qc = useQueryClient();
  // Primed by $slug's beforeLoad, which only lets a user with a seat through.
  const me = useQuery(meQuery).data!;
  const overview = useQuery(orpc.home.overview.queryOptions());
  // SAP, off the page's path: refreshes the stored journey, then the overview redraws with it.
  const progress = useQuery({ ...orpc.home.progress.queryOptions(), retry: false });
  const documents = useQuery({ ...orpc.home.documents.queryOptions(), retry: false });
  const refresh = () => qc.invalidateQueries({ queryKey: orpc.home.overview.key() });
  useEffect(() => { if (progress.data?.changed) void refresh(); }, [progress.data]);
  const pin = useMutation(orpc.home.pin.mutationOptions({ onSuccess: refresh }));

  const canCreate = me.company!.role !== "viewer";
  const newProject = () => void navigate({ to: "/$slug/projects/new" });
  const open = (id: string) => void navigate({ to: "/$slug/projects/$id", params: { id } });
  // The whole row opens the project, so hovering it preloads as the name's link does.
  const preload = (id: string) => void router.preloadRoute({ from: "/$slug", to: "/$slug/projects/$id", params: { id } }).catch(() => undefined);
  const { greeting, today } = useGreeting(me.user);
  const labels = STEP_KEYS.map((k) => t(k));
  const f = overview.data?.figures;
  const sapError = progress.error ?? documents.error;

  const since = (r: HomeInquiry) => {
    const text = t(`PORTAL_HOME_SINCE_${keyOf(r.next)}`, day(r.at));
    return r.next === "answer" && r.quotedValue !== null ? `${text} · ${money(r.quotedValue, me.currency || undefined)}` : text;
  };

  return (
    <ObjectPage
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title>{greeting}</Title>}
          subHeader={<Text>{t("PORTAL_HOME_OVERLINE", today, me.company!.cardName, me.tenant.name)}</Text>}
        />
      }
    >
      {/* The staff home's launchpad squares. Each figure opens the projects list on the journey steps it
          counts (figuresOf's groups, server portal/journey.ts), which the list filters with journeyOf's own SQL. */}
      <ObjectPageSection id="actions" titleText={t("PORTAL_HOME_QUICK_ACTIONS")}>
        <div className="cf-tiles">
          {canCreate ? <Tile title={t("PORTAL_HOME_NEW_PROJECT")} icon="add" to="/projects/new" /> : null}
          <Tile title={t("PORTAL_HOME_NEED_ANSWER")} icon="message-warning" loading={overview.isPending}
            value={f?.needAnswer} state={f?.needAnswer ? "Critical" : undefined} to="/projects" search={{ next: "answer,changes" }} />
          <Tile title={t("PORTAL_HOME_WITH_SUPPLIER", me.tenant.name)} icon="process" loading={overview.isPending} value={f?.withSupplier}
            to="/projects" search={{ next: "review,awaitOrder" }} />
          <Tile title={t("PORTAL_HOME_IN_DELIVERY")} icon="shipping-status" loading={overview.isPending} value={f?.inDelivery}
            to="/projects" search={{ next: "delivery,invoice" }} />
        </div>
      </ObjectPageSection>

      {/* The card's header carries the title (the section's is hidden, kept for the anchor bar) and the link. */}
      <ObjectPageSection id="inquiries" titleText={t("PORTAL_HOME_INQUIRIES")} hideTitleText>
        {overview.error ? <MessageStrip design="Negative" hideCloseButton>{overview.error.message}</MessageStrip> : null}
        <Card accessibleName={t("PORTAL_HOME_INQUIRIES")} header={
          <CardHeader titleText={t("PORTAL_HOME_INQUIRIES")}
            // UI5 pulls the action slot up and out by .5rem (::slotted, sized for a Button's padding):
            // a Link has none, so it would sit above the title's line. Inline wins over ::slotted.
            action={<RouterLink from="/$slug" to="/$slug/projects" style={{ top: 0, insetInlineEnd: 0 }}>{t("PORTAL_HOME_ALL_PROJECTS")}</RouterLink>} />
        }>
          {overview.data && !overview.data.inquiries.length ? (
            <IllustratedMessage name="NoEntries" design="Spot" titleText={t("PORTAL_HOME_NO_PROJECTS")}
              subtitleText={t("PORTAL_HOME_NO_PROJECTS_SUB", me.tenant.name)}>
              {canCreate ? <Button icon="add" design="Emphasized" onClick={newProject}>{t("PORTAL_HOME_NEW_PROJECT")}</Button> : null}
            </IllustratedMessage>
          ) : (
            <Table accessibleName={t("PORTAL_HOME_INQUIRIES")} overflowMode="Popin" loading={overview.isPending} rowActionCount={1}
              onRowClick={(e) => open(String(e.detail.row.rowKey))}
              headerRow={
                <TableHeaderRow>
                  {/* The icon button (2.25rem) and the cell's 1rem padding either side: any less and the name covers its edge. */}
                  <TableHeaderCell width="4.25rem"><span /></TableHeaderCell>
                  <TableHeaderCell minWidth="12rem">{t("PORTAL_HOME_COL_INQUIRY")}</TableHeaderCell>
                  <TableHeaderCell minWidth="23rem">{t("PORTAL_HOME_COL_PROGRESS")}</TableHeaderCell>
                  <TableHeaderCell minWidth="10rem">{t("PORTAL_HOME_COL_NEXT")}</TableHeaderCell>
                </TableHeaderRow>
              }>
              {overview.data?.inquiries.map((r) => (
                // The List below draws a two-line item 5rem high (UI5's fixed height): the rows match it.
                <TableRow key={r.id} rowKey={r.id} interactive style={{ height: "5rem" }} onMouseEnter={() => preload(r.id)}
                  actions={<TableRowActionNavigation interactive onClick={() => open(r.id)} />}>
                  <TableCell>
                    {/* The row fires row-click only when the row itself has focus, so this press never opens it. */}
                    <Button design="Transparent" icon={r.pinned ? "pushpin-on" : "pushpin-off"} disabled={pin.isPending}
                      tooltip={t(r.pinned ? "PORTAL_HOME_UNPIN" : "PORTAL_HOME_PIN")} accessibleName={t(r.pinned ? "PORTAL_HOME_UNPIN" : "PORTAL_HOME_PIN")}
                      onClick={() => pin.mutate({ id: r.id, pinned: !r.pinned })} />
                  </TableCell>
                  <TableCell>
                    <FlexBox direction="Column" style={{ gap: "0.125rem" }}>
                      {/* A real href (new tab, middle-click); the router's own navigation and preload on a plain click. */}
                      <RouterLink from="/$slug" to="/$slug/projects/$id" params={{ id: r.id }}
                        style={{ fontFamily: "var(--sapFontSemiboldDuplexFamily)" }}>{r.name}</RouterLink>
                      <Text style={{ color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" }}>{since(r)}</Text>
                    </FlexBox>
                  </TableCell>
                  <TableCell>
                    <Journey step={r.step} next={r.next} labels={labels}
                      ariaLabel={t("PORTAL_HOME_JOURNEY_ARIA", Math.min(r.step, 5) + 1, labels[Math.min(r.step, 5)]!)} />
                  </TableCell>
                  <TableCell>
                    <ObjectStatus inverted state={NEXT_STATE[r.next] ?? "Information"}>{t(`PORTAL_HOME_NEXT_${keyOf(r.next)}`, me.tenant.name)}</ObjectStatus>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </Card>
      </ObjectPageSection>

      <ObjectPageSection id="documents" titleText={t("PORTAL_HOME_LATEST")} hideTitleText>
        {sapError ? <MessageStrip design="Critical" hideCloseButton>{t("PORTAL_HOME_SAP_DOWN", me.tenant.name, sapError.message)}</MessageStrip> : null}
        {documents.error ? null : <Card accessibleName={t("PORTAL_HOME_LATEST")} header={<CardHeader titleText={t("PORTAL_HOME_LATEST")} />}>
          {documents.data && !documents.data.recent.length ? (
            <IllustratedMessage name="NoData" design="Spot" titleText={t("PORTAL_HOME_NO_DOCUMENTS")} />
          ) : (
            <List accessibleName={t("PORTAL_HOME_LATEST")} loading={documents.isPending}>
              {documents.data?.recent.map((d) => (
                <ListItemStandard key={`${d.entity}:${d.docEntry}`} type="Navigation" icon={DOC_PAGES[d.entity].icon}
                  description={day(d.docDate)} additionalText={money(d.docTotal, d.currency || me.currency || undefined)}
                  additionalTextState={d.entity === "Invoices" && d.status === "bost_Open" ? "Critical" : "None"}
                  onClick={() => void navigate({ to: "/$slug/docs/$entity/$key", params: { entity: d.entity, key: String(d.docEntry) } })}>
                  {t(DOC_PAGES[d.entity].numKey, String(d.docNum))}
                </ListItemStandard>
              ))}
            </List>
          )}
        </Card>}
      </ObjectPageSection>
    </ObjectPage>
  );
}

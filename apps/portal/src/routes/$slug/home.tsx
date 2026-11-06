import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, FlexBox, HeroBanner, IllustratedMessage, Link, List, ListItemStandard, MessageStrip, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowActionNavigation, Tag, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { Tile } from "@confire/ui/Tile.tsx";
import { money } from "@confire/ui/money.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { meQuery, orpc } from "../../orpc.ts";
import { DOC_PAGES } from "../../features/documents.ts";
import { Journey, type HomeInquiry, type Next } from "../../components/Journey.tsx";
import { useI18n } from "../../i18n.ts";

// The portal home (spec 2026-11-06-portal-home): the customer's open inquiries and how far each has
// got — sent to invoiced — with the to-dos in the banner and the latest documents below. The server
// decides every step and figure; Postgres and SAP are separate calls, so a down agent costs the
// journey's refresh and the documents, never the page.
export const Route = createFileRoute("/$slug/home")({ component: Home });

const STEP_KEYS = ["SENT", "REVIEW", "QUOTED", "ORDERED", "DELIVERED", "INVOICED"].map((s) => `PORTAL_HOME_STEP_${s}`);
const NEXT_DESIGN: Partial<Record<Next, "Critical" | "Negative" | "Positive" | "Neutral">> = {
  answer: "Critical", changes: "Critical", declined: "Negative", done: "Positive", finish: "Neutral",
};
const keyOf = (next: Next) => next.toUpperCase();

/** A date-only string is a calendar day, not UTC midnight (which shows the day before west of Greenwich). */
const day = (at: string) => new Date(at.length === 10 ? `${at}T00:00` : at)
  .toLocaleDateString(formatLocale(), { day: "numeric", month: "short" });

function Home() {
  const i18n = useI18n();
  const t = (key: string, ...params: (string | number)[]) => i18n.getText(key, ...params.map(String));
  const navigate = useNavigate({ from: "/$slug" });
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
  const firstName = (me.user.name || me.user.email).split(/[ @]/)[0]!;
  const hour = new Date().getHours();
  const greeting = t(hour < 12 ? "PORTAL_HOME_GREETING_MORNING" : hour < 18 ? "PORTAL_HOME_GREETING_AFTERNOON" : "PORTAL_HOME_GREETING_EVENING", firstName);
  const today = new Date().toLocaleDateString(formatLocale(), { weekday: "long", day: "numeric", month: "long" });
  const labels = STEP_KEYS.map((k) => t(k));
  const f = overview.data?.figures;
  const sapError = progress.error ?? documents.error;
  const sapDown = sapError
    ? <MessageStrip design="Critical" hideCloseButton>{t("PORTAL_HOME_SAP_DOWN", me.tenant.name, sapError.message)}</MessageStrip>
    : null;

  const since = (r: HomeInquiry) => {
    const text = t(`PORTAL_HOME_SINCE_${keyOf(r.next)}`, day(r.at));
    return r.next === "answer" && r.quotedValue !== null ? `${text} · ${money(r.quotedValue, me.currency || undefined)}` : text;
  };

  return (
    <FlexBox direction="Column" style={{ gap: "1.5rem", padding: "1rem 2rem 2rem" }}>
      <HeroBanner
        overlineText={t("PORTAL_HOME_OVERLINE", today, me.company!.cardName, me.tenant.name)}
        headerText={greeting}
        actions={canCreate ? <Button icon="add" onClick={newProject}>{t("PORTAL_HOME_NEW_PROJECT")}</Button> : undefined}
      >
        <div className="cf-tiles">
          <Tile wide title={t("PORTAL_HOME_NEED_ANSWER")} icon="message-warning" loading={overview.isPending}
            value={f?.needAnswer} state={f?.needAnswer ? "Critical" : undefined} />
          <Tile wide title={t("PORTAL_HOME_WITH_SUPPLIER", me.tenant.name)} icon="process" loading={overview.isPending} value={f?.withSupplier} />
          <Tile wide title={t("PORTAL_HOME_IN_DELIVERY")} icon="shipping-status" loading={overview.isPending} value={f?.inDelivery} />
        </div>
      </HeroBanner>

      {overview.error ? <MessageStrip design="Negative" hideCloseButton>{overview.error.message}</MessageStrip> : null}
      {sapDown}

      <section>
        <FlexBox alignItems="Baseline" justifyContent="SpaceBetween" style={{ marginBottom: "0.75rem" }}>
          <Title level="H4">{t("PORTAL_HOME_INQUIRIES")}</Title>
          <Link onClick={() => void navigate({ to: "/$slug/projects" })}>{t("PORTAL_HOME_ALL_PROJECTS")}</Link>
        </FlexBox>
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
                <TableHeaderCell width="3rem"><span /></TableHeaderCell>
                <TableHeaderCell minWidth="12rem">{t("PORTAL_HOME_COL_INQUIRY")}</TableHeaderCell>
                <TableHeaderCell minWidth="23rem">{t("PORTAL_HOME_COL_PROGRESS")}</TableHeaderCell>
                <TableHeaderCell minWidth="10rem">{t("PORTAL_HOME_COL_NEXT")}</TableHeaderCell>
              </TableHeaderRow>
            }>
            {overview.data?.inquiries.map((r) => (
              <TableRow key={r.id} rowKey={r.id} interactive
                actions={<TableRowActionNavigation interactive onClick={() => open(r.id)} />}>
                <TableCell>
                  {/* The row fires row-click only when the row itself has focus, so this press never opens it. */}
                  <Button design="Transparent" icon={r.pinned ? "pushpin-on" : "pushpin-off"} disabled={pin.isPending}
                    tooltip={t(r.pinned ? "PORTAL_HOME_UNPIN" : "PORTAL_HOME_PIN")} accessibleName={t(r.pinned ? "PORTAL_HOME_UNPIN" : "PORTAL_HOME_PIN")}
                    onClick={() => pin.mutate({ id: r.id, pinned: !r.pinned })} />
                </TableCell>
                <TableCell>
                  <FlexBox direction="Column" style={{ gap: "0.125rem" }}>
                    <Text style={{ fontFamily: "var(--sapFontSemiboldDuplexFamily)" }}>{r.name}</Text>
                    <Text style={{ color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" }}>{since(r)}</Text>
                  </FlexBox>
                </TableCell>
                <TableCell>
                  <Journey step={r.step} next={r.next} labels={labels}
                    ariaLabel={t("PORTAL_HOME_JOURNEY_ARIA", Math.min(r.step, 5) + 1, labels[Math.min(r.step, 5)]!)} />
                </TableCell>
                <TableCell>
                  {/* Neutral's state icon is a question mark: a draft is not a question. */}
                  <Tag design={NEXT_DESIGN[r.next] ?? "Information"} hideStateIcon={r.next === "finish"}>{t(`PORTAL_HOME_NEXT_${keyOf(r.next)}`, me.tenant.name)}</Tag>
                </TableCell>
              </TableRow>
            ))}
          </Table>
        )}
      </section>

      <section>
        <Title level="H4" style={{ marginBottom: "0.75rem" }}>{t("PORTAL_HOME_LATEST")}</Title>
        {documents.error ? null : documents.data && !documents.data.recent.length ? (
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
      </section>
    </FlexBox>
  );
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnalyticalCardHeader, Button, Card, NumericSideIndicator, ObjectStatus, Panel, Tag } from "@ui5/webcomponents-react";
import { LineChart } from "@ui5/webcomponents-react-charts";
import { formatLocale } from "@confire/ui/format.ts";
import { money } from "@confire/ui/money.ts";
import { useI18n } from "../../i18n.ts";
import { client, orpc, useCurrency } from "../../orpc.ts";
import type { ConfigView } from "../../components/configurator/useConfigProcess.ts";
import { ListCard, TableCard } from "./kit.tsx";

// Once nothing is missing (assistant spec §4.1 step 5): the lowest price per batch quantity as a KPI
// and a curve, one row per quantity to pick from — a pick is `configs.select` directly, no model —
// similar past quotes on request, and the way on to the quote page. The figures are the view's.

export function CandidatesCard({ projectId, view }: { projectId: string; view: ConfigView }) {
  const i18n = useI18n();
  const t = (k: string, ...a: Array<string | number>) => i18n.getText(k, ...a.map(String));
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const currency = useCurrency();
  const similar = useQuery(orpc.configs.similar.queryOptions({ input: { id: projectId, entries: view.project.entries as Record<string, never> } }));
  const qtys = view.project.batches;
  const rows = view.candidates.rows;
  // The lowest-priced candidate at each quantity: the server marks it.
  const best = qtys.map((q) => {
    const idx = rows.findIndex((r) => r.perBatch.some((b) => b.batchQty === q && b.lowest));
    const b = rows[idx]?.perBatch.find((x) => x.batchQty === q);
    return { q, idx, unitPrice: b?.unitPrice ?? 0, total: b?.total ?? 0 };
  }).filter((b) => b.idx >= 0);
  const picked = (idx: number, q: number) => view.selection.picks.some((p) => p.candidateIdx === idx && p.batchQty === q);
  const pick = async (idx: number) => {
    const answer = await client.configs.select({ projectId, selection: qtys.map((q) => ({ candidateIdx: idx, batchQty: q })) });
    qc.setQueryData(orpc.configs.get.queryKey({ input: { id: projectId } }), (prev: ConfigView | undefined) => (prev ? { ...prev, ...answer } : prev));
  };
  const first = best[0];
  const fmt = new Intl.NumberFormat(formatLocale(), { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const qtyFmt = new Intl.NumberFormat(formatLocale());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Card header={
        <AnalyticalCardHeader titleText={t("ASSISTANT_CANDIDATES")} subtitleText={first ? t("ASSISTANT_CANDIDATES_SUB", qtyFmt.format(first.q)) : undefined}
          value={first ? fmt.format(first.unitPrice) : "—"} scale={currency}>
          <NumericSideIndicator titleText={t("ASSISTANT_CANDIDATES")} number={rows.length} />
          <NumericSideIndicator titleText={t("ASSISTANT_QTYS")} number={qtys.map((q) => qtyFmt.format(q)).join(", ")} />
        </AnalyticalCardHeader>
      }>
        {best.length > 1 ? (
          <LineChart style={{ height: "10rem" }} noLegend dataset={best.map((b) => ({ qty: b.q, price: b.unitPrice }))}
            dimensions={[{ accessor: "qty", formatter: (v) => qtyFmt.format(Number(v)) }]}
            measures={[{ accessor: "price", label: t("ASSISTANT_UNIT_PRICE"), hideDataLabel: true, width: 2, formatter: (v: number) => money(v, currency) }]} />
        ) : null}
      </Card>
      <TableCard title={t("ASSISTANT_PER_QTY")}
        columns={[{ key: "qty", label: t("ASSISTANT_QTY"), end: true }, { key: "unit", label: t("ASSISTANT_UNIT_PRICE"), end: true }, { key: "total", label: t("ASSISTANT_TOTAL"), end: true }, { key: "pick", label: "" }]}
        rows={best.map((b) => ({
          id: String(b.q),
          cells: {
            qty: qtyFmt.format(b.q),
            unit: <span>{money(b.unitPrice, currency)} <Tag design="Positive" hideStateIcon>{t("ASSISTANT_LOWEST")}</Tag></span>,
            total: money(b.total, currency),
            pick: picked(b.idx, b.q)
              ? <ObjectStatus state="Positive" showDefaultIcon>{t("ASSISTANT_PICKED")}</ObjectStatus>
              : <Button design="Transparent" onClick={() => void pick(b.idx)}>{t("ASSISTANT_PICK")}</Button>,
          },
        }))}
        footer={
          <Button design="Emphasized" disabled={!view.selection.picks.length}
            onClick={() => void navigate({ to: "/$slug/configs/$id/quote", params: { id: projectId } })}>{t("ASSISTANT_CARD_REVIEW")}</Button>
        } />
      {similar.data?.results.length ? (
        <Panel collapsed headerText={t("ASSISTANT_SIMILAR")} headerLevel="H6">
          <ListCard title={t("ASSISTANT_SIMILAR")} noData={t("ASSISTANT_CARD_NONE")}
            items={similar.data.results.slice(0, 3).map((r, i) => {
              const [head, ...rest] = Object.values(r.display).filter((x) => x !== null && x !== "").map(String);
              return { id: String(i), title: head ?? "—", description: rest.join(" · "), info: `${Math.round(r.score * 100)} %` };
            })} />
        </Panel>
      ) : null}
    </div>
  );
}

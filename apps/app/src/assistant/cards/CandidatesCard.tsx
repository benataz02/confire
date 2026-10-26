import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button, FlexBox, Panel } from "@ui5/webcomponents-react";
import { formatLocale } from "@confire/ui/format.ts";
import { money } from "@confire/ui/money.ts";
import { useI18n } from "../../i18n.ts";
import { client, orpc, useCurrency } from "../../orpc.ts";
import type { ConfigView } from "../../components/configurator/useConfigProcess.ts";
import { lineKey, mergeSelection, type Sel } from "../../components/configurator/runView.ts";
import { ListCard, TableCard } from "./kit.tsx";

// Once nothing is missing (assistant spec §4.1 step 5): one row per batch quantity, its lowest price,
// selected while picked — a change is `configs.select` directly, no model, merged as the page's grid
// merges, so a pick of another candidate made on the page stays — similar past quotes on request, and
// the way on to the quote page. The figures are the view's.

export function CandidatesCard({ projectId, view }: { projectId: string; view: ConfigView }) {
  const i18n = useI18n();
  const t = (k: string, ...a: Array<string | number>) => i18n.getText(k, ...a.map(String));
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const currency = useCurrency();
  const similar = useQuery(orpc.configs.similar.queryOptions({ input: { id: projectId, entries: view.project.entries as Record<string, never> } }));
  const rows = view.candidates.rows;
  // The lowest-priced candidate at each quantity: the server marks it.
  const best = view.project.batches.map((q) => {
    const idx = rows.findIndex((r) => r.perBatch.some((b) => b.batchQty === q && b.lowest));
    const b = rows[idx]?.perBatch.find((x) => x.batchQty === q);
    return { q, idx, key: lineKey({ candidateIdx: idx, batchQty: q }), unitPrice: b?.unitPrice ?? 0, total: b?.total ?? 0 };
  }).filter((b) => b.idx >= 0);
  const picks = new Set(view.selection.picks.map(lineKey));
  const pick = async (keys: string[]) => {
    const on: Sel[] = best.filter((b) => keys.includes(b.key)).map((b) => ({ candidateIdx: b.idx, batchQty: b.q }));
    const answer = await client.configs.select({ projectId, selection: mergeSelection(view.selection.picks, new Set(best.map((b) => b.key)), on) });
    qc.setQueryData(orpc.configs.get.queryKey({ input: { id: projectId } }), (prev: ConfigView | undefined) => (prev ? { ...prev, ...answer } : prev));
  };
  const qtyFmt = new Intl.NumberFormat(formatLocale());

  return (
    <FlexBox direction="Column" gap="0.5rem">
      <TableCard title={t("ASSISTANT_PER_QTY")}
        columns={[{ key: "qty", label: t("ASSISTANT_QTY"), end: true }, { key: "unit", label: t("ASSISTANT_CARD_UNIT_PRICE"), end: true }, { key: "total", label: t("ASSISTANT_TOTAL"), end: true }]}
        rows={best.map((b) => ({
          id: b.key,
          cells: { qty: qtyFmt.format(b.q), unit: money(b.unitPrice, currency), total: money(b.total, currency) },
        }))}
        selected={best.filter((b) => picks.has(b.key)).map((b) => b.key)} onSelect={(keys) => void pick(keys)}
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
    </FlexBox>
  );
}

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnalyticalCardHeader, Button, Card, CardHeader, FlexBox, HeroBanner, Icon, IllustratedMessage,
  List, ListItemStandard, MessageStrip, NumericSideIndicator, SegmentedButton, SegmentedButtonItem,
  Tag, Text, Toolbar, ToolbarButton, ToolbarItem, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import { BulletChart, ColumnChart, DonutChart, LineChart } from "@ui5/webcomponents-react-charts";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { useLanguage } from "@confire/ui/i18n.ts";
import { meQuery, orpc, useCurrency, useIsAdmin } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import {
  attentionReason, bucketLabel, conversionSlices, deviationPct, greeting, monthLabel, percent,
  percentPoints, scaled, stageLabel, trendOf,
} from "./dashboardView.ts";
import { money } from "@confire/ui/money.ts";

const WINDOWS = [
  { key: "month", labelKey: "SHELL_DASH_WINDOW_MONTH" },
  { key: "quarter", labelKey: "SHELL_DASH_WINDOW_QUARTER" },
  { key: "year12", labelKey: "SHELL_DASH_WINDOW_YEAR" },
] as const;

const cards = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "1rem" };
const panels = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: "1rem" };
const chartH = { height: "12rem", width: "100%" } as const;

export function DashboardPage() {
  const i18n = useI18n();
  // getText reads this.packageName, so a bare method reference throws. The helpers stay pure.
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const { language } = useLanguage();
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const [window, setWindow] = useState<"month" | "quarter" | "year12">("month");
  const [ageFilter, setAgeFilter] = useState<string | null>(null);

  const { data: me } = useQuery(meQuery);
  const o = useQuery(orpc.dashboard.overview.queryOptions({ input: { window } }));
  const refresh = useMutation(orpc.dashboard.refresh.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: orpc.dashboard.overview.queryOptions({ input: { window } }).queryKey }),
  }));

  const firstName = (me?.user?.name ?? me?.user?.email ?? i18n.getText("SHELL_DASH_GREETING_FALLBACK")).split(/[ @]/)[0]!;
  const isAdmin = useIsAdmin();
  const busy = o.isFetching || refresh.isPending;
  const d = o.data;
  // undefined until SAP has answered once for this tenant; the cards then read as bare numbers
  // rather than "undefined", which is what the empty label below is for.
  const cur = useCurrency();
  const curLabel = cur ?? "";
  const windowLabel = i18n.getText(WINDOWS.find((w) => w.key === window)!.labelKey);
  const orderValue = scaled(d?.orderValue.total ?? 0);
  const confireValue = scaled(d?.orderValue.confire ?? 0);
  const vsPrior = d ? deviationPct(d.orderValue.total, d.orderValue.prevTotal) : null;
  const bucketDocEntries = new Set(d?.pipeline.find((p) => p.bucket === ageFilter)?.docEntries ?? []);
  const attention = !d ? [] : ageFilter
    ? d.attention.filter((a) => a.docEntry !== null && bucketDocEntries.has(a.docEntry))
    : d.attention;
  const attentionN = d?.attention.length ?? 0;

  const overline = `${new Date().toLocaleDateString(language, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${
    d?.computedAt ? ` · ${i18n.getText("SHELL_DASH_SAP_AS_OF", new Date(d.computedAt).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" }))}` : ""
  }`;

  return (
    <FlexBox direction="Column" style={{ gap: "1rem", padding: "1rem" }}>
      <HeroBanner
        columnsRatio="FirstWider"
        overlineText={overline}
        headerText={greeting(new Date(), firstName, t)}
        actions={
          <Button icon="add" design="Default" onClick={() => navigate({ to: "/$slug/configs/new" })}>{i18n.getText("SHELL_DASH_NEW_CONFIG")}</Button>
        }
        endContent={
          <Card
            accessibleName={i18n.getText("SHELL_DASH_NEEDS_ATTENTION")}
            loading={!d}
            header={
              <CardHeader
                interactive={attentionN > 0}
                titleText={i18n.getText("SHELL_DASH_NEEDS_ATTENTION")}
                subtitleText={attentionN ? i18n.getText("SHELL_DASH_NO_MOVEMENT") : i18n.getText("SHELL_DASH_NOTHING_WAITING")}
                additionalText={String(attentionN)}
                avatar={<Icon name="alert" />}
                onClick={() => { if (attentionN) void navigate({ to: "/$slug/configs" }); }}
              />
            }
          />
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem" }}>
          <Card
            accessibleName={i18n.getText("NAV_CONFIGS")}
            header={
              <CardHeader
                interactive
                titleText={i18n.getText("NAV_CONFIGS")}
                subtitleText={i18n.getText("SHELL_DASH_CONFIGS_SUB")}
                avatar={<Icon name="sales-quote" />}
                onClick={() => void navigate({ to: "/$slug/configs" })}
              />
            }
          />
          {isAdmin && (
            <>
              <Card
                accessibleName={i18n.getText("SHELL_DASH_MODELS")}
                header={
                  <CardHeader
                    interactive
                    titleText={i18n.getText("SHELL_DASH_MODELS")}
                    subtitleText={i18n.getText("NAV_MODELS")}
                    avatar={<Icon name="tree" />}
                    onClick={() => void navigate({ to: "/$slug/models" })}
                  />
                }
              />
              <Card
                accessibleName={i18n.getText("NAV_MASTERDATA")}
                header={
                  <CardHeader
                    interactive
                    titleText={i18n.getText("NAV_MASTERDATA")}
                    subtitleText={i18n.getText("SHELL_DASH_MASTERDATA_SUB")}
                    avatar={<Icon name="table-view" />}
                    onClick={() => void navigate({ to: "/$slug/masterdata" })}
                  />
                }
              />
            </>
          )}
        </div>
      </HeroBanner>

      <Toolbar>
        <ToolbarItem overflowPriority="NeverOverflow">
          <SegmentedButton
            accessibleName={i18n.getText("SHELL_DASH_TIME_WINDOW")}
            itemsFitContent
            onSelectionChange={(e) => {
              const key = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.key;
              if (key === "month" || key === "quarter" || key === "year12") setWindow(key);
            }}
          >
            {WINDOWS.map((w) => (
              <SegmentedButtonItem key={w.key} data-key={w.key} selected={window === w.key}>{i18n.getText(w.labelKey)}</SegmentedButtonItem>
            ))}
          </SegmentedButton>
        </ToolbarItem>
        <ToolbarSpacer />
        <ToolbarButton
          icon="refresh" design="Transparent" tooltip={i18n.getText("SHELL_DASH_REFRESH")} accessibleName={i18n.getText("SHELL_DASH_REFRESH")}
          disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)}
        />
      </Toolbar>

      {o.error && <MessageStrip design="Negative" hideCloseButton>{o.error.message}</MessageStrip>}
      {refresh.error && <MessageStrip design="Negative" hideCloseButton>{refresh.error.message}</MessageStrip>}
      {d && (d.snapshotError || !d.computedAt) && (
        <MessageStrip design="Critical" hideCloseButton>
          {d.snapshotError
            ? i18n.getText("SHELL_DASH_SAP_REFRESH_FAILED", d.snapshotError)
            : i18n.getText("SHELL_DASH_SAP_NOT_COLLECTED")}
        </MessageStrip>
      )}

      <div style={cards}>
        {!d ? (
          [0, 1, 2, 3].map((i) => <Card key={i} loading accessibleName={i18n.getText("SHELL_DASH_LOADING")} style={{ height: "16rem" }} />)
        ) : (
          <>
            <Card accessibleName={i18n.getText("SHELL_DASH_ORDER_VALUE")} loading={busy} header={
              <AnalyticalCardHeader
                titleText={i18n.getText("SHELL_DASH_ORDER_VALUE")} subtitleText={windowLabel}
                value={orderValue.value} scale={orderValue.scale} unitOfMeasurement={curLabel}
                trend={trendOf(d.orderValue.total, d.orderValue.prevTotal)} state="None"
              >
                <NumericSideIndicator
                  titleText={i18n.getText("SHELL_DASH_VIA_CONFIRE")} number={confireValue.value}
                  unit={[confireValue.scale, curLabel].filter(Boolean).join(" ")}
                />
                {vsPrior && <NumericSideIndicator titleText={i18n.getText("SHELL_DASH_VS_PRIOR")} number={vsPrior.number} unit={vsPrior.unit} />}
              </AnalyticalCardHeader>
            }>
              <LineChart
                style={chartH} dataset={d.orderValue.series} noLegend loading={busy}
                chartConfig={{ xAxisVisible: false, yAxisWidth: 28, margin: { left: 0, right: 8, top: 8, bottom: 8 } }}
                dimensions={[{ accessor: "month", formatter: (v) => monthLabel(String(v), language) }]}
                measures={[{
                  accessor: "value",
                  label: cur ? i18n.getText("SHELL_DASH_ORDER_VALUE_CUR", cur) : i18n.getText("SHELL_DASH_ORDER_VALUE"),
                  hideDataLabel: true, showDot: false,
                  formatter: (v: number) => money(v, cur),
                }]}
              />
            </Card>
            <Card accessibleName={i18n.getText("SHELL_DASH_QUOTE_TO_ORDER")} loading={busy} header={
              <AnalyticalCardHeader
                titleText={i18n.getText("SHELL_DASH_QUOTE_TO_ORDER")}
                subtitleText={i18n.getText("SHELL_DASH_QUOTATIONS_OF", String(d.conversion.converted), String(d.conversion.quotes))}
                value={percentPoints(d.conversion.rate)} unitOfMeasurement="%"
                trend={trendOf(d.conversion.rate, d.conversion.prevRate)} state="None"
              />
            }>
              {d.conversion.quotes > 0 && (
                <DonutChart
                  style={chartH} dataset={conversionSlices(d.conversion.converted, d.conversion.quotes, t)}
                  dimension={{ accessor: "status" }} measure={{ accessor: "count" }}
                  centerLabel={percent(d.conversion.rate)} loading={busy}
                />
              )}
            </Card>
            <Card accessibleName={i18n.getText("SHELL_DASH_TURNAROUND")} loading={busy} header={
              <AnalyticalCardHeader
                titleText={i18n.getText("SHELL_DASH_TURNAROUND")}
                subtitleText={i18n.getText("SHELL_DASH_MEDIAN_OF", String(d.turnaround.sampled))}
                value={d.turnaround.medianDays === null ? "—" : d.turnaround.medianDays.toFixed(1)}
                unitOfMeasurement={i18n.getText("SHELL_DASH_DAYS")} state="None"
                description={d.turnaround.sampled === 0 ? i18n.getText("SHELL_DASH_NO_QUOTED") : undefined}
              />
            } />
            <Card accessibleName={i18n.getText("SHELL_DASH_MARGIN")} loading={busy} header={
              <AnalyticalCardHeader
                titleText={i18n.getText("SHELL_DASH_MARGIN")}
                subtitleText={i18n.getText("SHELL_DASH_QUOTES_OF", String(d.margin.covered), String(d.margin.of))}
                value={percentPoints(d.margin.pct)} unitOfMeasurement="%"
                state={d.margin.pct !== null && d.margin.pct < 0.15 ? "Critical" : d.margin.pct === null ? "None" : "Good"}
              />
            }>
              {d.margin.pct !== null && (
                <BulletChart
                  style={chartH} noLegend loading={busy}
                  dataset={[{ name: i18n.getText("SHELL_DASH_MARGIN_NAME"), actual: d.margin.pct * 100, target: 15 }]}
                  dimensions={[{ accessor: "name" }]}
                  measures={[
                    { accessor: "actual", type: "primary", label: i18n.getText("SHELL_DASH_MARGIN_NAME") },
                    { accessor: "target", type: "comparison", label: i18n.getText("SHELL_DASH_MARGIN_TARGET") },
                  ]}
                />
              )}
            </Card>
          </>
        )}
      </div>

      {d && (
        <>
          <div style={panels}>
            <Card
              accessibleName={i18n.getText("SHELL_DASH_FUNNEL")} loading={busy}
              header={<CardHeader interactive titleText={i18n.getText("SHELL_DASH_FUNNEL")} onClick={() => void navigate({ to: "/$slug/configs" })} />}
            >
              <ColumnChart
                style={chartH} dataset={d.funnel} noLegend loading={busy}
                dimensions={[{ accessor: "stage", formatter: (v) => stageLabel(String(v), t) }]}
                measures={[{ accessor: "count", label: i18n.getText("NAV_CONFIGS") }]}
              />
            </Card>
            <Card
              accessibleName={i18n.getText("SHELL_DASH_PIPELINE")} loading={busy}
              header={<CardHeader titleText={i18n.getText("SHELL_DASH_PIPELINE")} />}
            >
              <ColumnChart
                style={chartH} dataset={d.pipeline} loading={busy}
                dimensions={[{ accessor: "bucket", formatter: (v) => bucketLabel(String(v), t) }]}
                measures={[
                  {
                    accessor: "confire", label: i18n.getText("SHELL_DASH_VIA_CONFIRE"), stackId: "open",
                    formatter: (v: number) => money(v, cur),
                    highlightColor: (_v, _m, row) =>
                      row.bucket === ageFilter ? "var(--sapHighlightColor)"
                        : row.bucket === "30d+" ? "var(--sapNegativeColor)"
                          : undefined,
                  },
                  {
                    accessor: "other", label: i18n.getText("SHELL_DASH_OTHER"), stackId: "open",
                    formatter: (v: number) => money(v, cur),
                    highlightColor: (_v, _m, row) =>
                      row.bucket === ageFilter ? "var(--sapHighlightColor)"
                        : row.bucket === "30d+" ? "var(--sapNegativeColor)"
                          : undefined,
                  },
                ]}
                onDataPointClick={(e) => {
                  const bucket = (e.detail as { payload?: { bucket?: string } }).payload?.bucket ?? null;
                  setAgeFilter((prev) => (prev === bucket ? null : bucket));
                }}
              />
              {d.pipelineTruncated && (
                <Text style={{ padding: "0 1rem 0.5rem" }}>
                  {i18n.getText("SHELL_DASH_PIPELINE_TRUNCATED")}
                </Text>
              )}
            </Card>
          </div>

          <div style={panels}>
            <Card
              accessibleName={i18n.getText("SHELL_DASH_NEEDS_ATTENTION")} loading={busy}
              header={
                <CardHeader
                  interactive
                  titleText={i18n.getText("SHELL_DASH_NEEDS_ATTENTION")}
                  additionalText={ageFilter ? i18n.getText("SHELL_DASH_COUNT_OF", String(attention.length), String(d.attention.length)) : String(d.attention.length)}
                  action={ageFilter ? (
                    <Tag interactive design="Information" hideStateIcon onClick={(e) => {
                      e.stopPropagation();
                      setAgeFilter(null);
                    }}>{bucketLabel(ageFilter, t)}</Tag>
                  ) : undefined}
                  onClick={() => void navigate({ to: "/$slug/configs" })}
                />
              }
            >
              {attention.length === 0 ? (
                <IllustratedMessage name="NoData" design="Spot" titleText={i18n.getText("SHELL_DASH_NOTHING_ON_YOU")} />
              ) : (
                <List>
                  {attention.map((a) => (
                    <ListItemStandard
                      key={a.id} type="Navigation" description={a.customer ?? undefined}
                      additionalText={i18n.getText("SHELL_DASH_AGE_DAYS", String(a.ageDays))}
                      additionalTextState={a.reason.startsWith("Portal") ? "Information" : "Critical"}
                      onClick={() => void navigate({ to: "/$slug/configs/$id", params: { id: a.id } })}
                    >
                      {a.name} — {attentionReason(a.reason, t)}
                    </ListItemStandard>
                  ))}
                </List>
              )}
            </Card>
          </div>
        </>
      )}
    </FlexBox>
  );
}

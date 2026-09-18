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
import { meQuery } from "../../orpc.ts";
import { orpc } from "../../orpc.ts";
import {
  conversionSlices, deviationPct, greeting, monthLabel, percent, percentPoints, scaled, trendOf,
} from "./dashboardView.ts";
import { money, useCurrency } from "../../lib/money.ts";

const WINDOWS = [
  { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" },
  { key: "year12", label: "Last 12 months" },
] as const;

const cards = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: "1rem" };
const panels = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: "1rem" };
const chartH = { height: "12rem", width: "100%" } as const;

export function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [window, setWindow] = useState<"month" | "quarter" | "year12">("month");
  const [ageFilter, setAgeFilter] = useState<string | null>(null);

  const { data: me } = useQuery(meQuery);
  const o = useQuery(orpc.dashboard.overview.queryOptions({ input: { window } }));
  const refresh = useMutation(orpc.dashboard.refresh.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: orpc.dashboard.overview.queryOptions({ input: { window } }).queryKey }),
  }));

  const firstName = (me?.user?.name ?? me?.user?.email ?? "there").split(/[ @]/)[0]!;
  const isAdmin = me?.role === "admin" || me?.role === "owner";
  const busy = o.isFetching || refresh.isPending;
  const d = o.data;
  // undefined until SAP has answered once for this tenant; the cards then read as bare numbers
  // rather than "undefined", which is what the empty label below is for.
  const cur = useCurrency();
  const curLabel = cur ?? "";
  const windowLabel = WINDOWS.find((w) => w.key === window)!.label;
  const orderValue = scaled(d?.orderValue.total ?? 0);
  const confireValue = scaled(d?.orderValue.confire ?? 0);
  const vsPrior = d ? deviationPct(d.orderValue.total, d.orderValue.prevTotal) : null;
  const bucketDocEntries = new Set(d?.pipeline.find((p) => p.bucket === ageFilter)?.docEntries ?? []);
  const attention = !d ? [] : ageFilter
    ? d.attention.filter((a) => a.docEntry !== null && bucketDocEntries.has(a.docEntry))
    : d.attention;
  const attentionN = d?.attention.length ?? 0;

  const overline = `${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${
    d?.computedAt ? ` · SAP data as of ${new Date(d.computedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""
  }`;

  return (
    <FlexBox direction="Column" style={{ gap: "1rem", padding: "1rem" }}>
      <HeroBanner
        columnsRatio="FirstWider"
        overlineText={overline}
        headerText={greeting(new Date(), firstName)}
        actions={me?.role === "client" ? undefined : (
          <Button icon="add" design="Default" onClick={() => navigate({ to: "/configs/new" })}>New configuration</Button>
        )}
        endContent={
          <Card
            accessibleName="Needs attention"
            loading={!d}
            header={
              <CardHeader
                interactive={attentionN > 0}
                titleText="Needs attention"
                subtitleText={attentionN ? "Portal requests and stale quotes" : "Nothing waiting"}
                additionalText={String(attentionN)}
                avatar={<Icon name="alert" />}
                onClick={() => { if (attentionN) void navigate({ to: "/configs" }); }}
              />
            }
          />
        }
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))", gap: "0.75rem" }}>
          <Card
            accessibleName="Configurations"
            header={
              <CardHeader
                interactive
                titleText="Configurations"
                subtitleText="Open and quoted work"
                avatar={<Icon name="sales-quote" />}
                onClick={() => void navigate({ to: "/configs" })}
              />
            }
          />
          {isAdmin && (
            <>
              <Card
                accessibleName="Models"
                header={
                  <CardHeader
                    interactive
                    titleText="Models"
                    subtitleText="Configurator models"
                    avatar={<Icon name="tree" />}
                    onClick={() => void navigate({ to: "/models" })}
                  />
                }
              />
              <Card
                accessibleName="Master data"
                header={
                  <CardHeader
                    interactive
                    titleText="Master data"
                    subtitleText="Tables and live queries"
                    avatar={<Icon name="table-view" />}
                    onClick={() => void navigate({ to: "/masterdata" })}
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
            accessibleName="Time window"
            itemsFitContent
            onSelectionChange={(e) => {
              const key = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.key;
              if (key === "month" || key === "quarter" || key === "year12") setWindow(key);
            }}
          >
            {WINDOWS.map((w) => (
              <SegmentedButtonItem key={w.key} data-key={w.key} selected={window === w.key}>{w.label}</SegmentedButtonItem>
            ))}
          </SegmentedButton>
        </ToolbarItem>
        <ToolbarSpacer />
        <ToolbarButton
          icon="refresh" design="Transparent" tooltip="Refresh SAP figures" accessibleName="Refresh SAP figures"
          disabled={refresh.isPending} onClick={() => refresh.mutate(undefined)}
        />
      </Toolbar>

      {o.error && <MessageStrip design="Negative" hideCloseButton>{o.error.message}</MessageStrip>}
      {refresh.error && <MessageStrip design="Negative" hideCloseButton>{refresh.error.message}</MessageStrip>}
      {d && (d.snapshotError || !d.computedAt) && (
        <MessageStrip design="Critical" hideCloseButton>
          {d.snapshotError
            ? `SAP figures could not be refreshed: ${d.snapshotError}`
            : "SAP figures have not been collected yet."}
        </MessageStrip>
      )}

      <div style={cards}>
        {!d ? (
          [0, 1, 2, 3].map((i) => <Card key={i} loading accessibleName="Loading" style={{ height: "16rem" }} />)
        ) : (
          <>
            <Card accessibleName="Order value" loading={busy} header={
              <AnalyticalCardHeader
                titleText="Order value" subtitleText={windowLabel}
                value={orderValue.value} scale={orderValue.scale} unitOfMeasurement={curLabel}
                trend={trendOf(d.orderValue.total, d.orderValue.prevTotal)} state="None"
              >
                <NumericSideIndicator
                  titleText="via Confire" number={confireValue.value}
                  unit={[confireValue.scale, curLabel].filter(Boolean).join(" ")}
                />
                {vsPrior && <NumericSideIndicator titleText="vs prior" number={vsPrior.number} unit={vsPrior.unit} />}
              </AnalyticalCardHeader>
            }>
              <LineChart
                style={chartH} dataset={d.orderValue.series} noLegend loading={busy}
                chartConfig={{ xAxisVisible: false, yAxisWidth: 28, margin: { left: 0, right: 8, top: 8, bottom: 8 } }}
                dimensions={[{ accessor: "month", formatter: (v) => monthLabel(String(v)) }]}
                measures={[{
                  accessor: "value", label: cur ? `Order value (${cur})` : "Order value", hideDataLabel: true, showDot: false,
                  formatter: (v: number) => money(v, cur, 0),
                }]}
              />
            </Card>
            <Card accessibleName="Quote-to-order" loading={busy} header={
              <AnalyticalCardHeader
                titleText="Quote-to-order"
                subtitleText={`${d.conversion.converted} of ${d.conversion.quotes} quotations`}
                value={percentPoints(d.conversion.rate)} unitOfMeasurement="%"
                trend={trendOf(d.conversion.rate, d.conversion.prevRate)} state="None"
              />
            }>
              {d.conversion.quotes > 0 && (
                <DonutChart
                  style={chartH} dataset={conversionSlices(d.conversion.converted, d.conversion.quotes)}
                  dimension={{ accessor: "status" }} measure={{ accessor: "count" }}
                  centerLabel={percent(d.conversion.rate)} loading={busy}
                />
              )}
            </Card>
            <Card accessibleName="Quote turnaround" loading={busy} header={
              <AnalyticalCardHeader
                titleText="Quote turnaround"
                subtitleText={`median of ${d.turnaround.sampled}`}
                value={d.turnaround.medianDays === null ? "—" : d.turnaround.medianDays.toFixed(1)}
                unitOfMeasurement="days" state="None"
                description={d.turnaround.sampled === 0 ? "No quoted configurations in this tenant yet" : undefined}
              />
            } />
            <Card accessibleName="Configured margin" loading={busy} header={
              <AnalyticalCardHeader
                titleText="Configured margin"
                subtitleText={`${d.margin.covered} of ${d.margin.of} quotes`}
                value={percentPoints(d.margin.pct)} unitOfMeasurement="%"
                state={d.margin.pct !== null && d.margin.pct < 0.15 ? "Critical" : d.margin.pct === null ? "None" : "Good"}
              />
            }>
              {d.margin.pct !== null && (
                <BulletChart
                  style={chartH} noLegend loading={busy}
                  dataset={[{ name: "Margin", actual: d.margin.pct * 100, target: 15 }]}
                  dimensions={[{ accessor: "name" }]}
                  measures={[
                    { accessor: "actual", type: "primary", label: "Margin" },
                    { accessor: "target", type: "comparison", label: "15% target" },
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
              accessibleName="Configuration to order" loading={busy}
              header={<CardHeader interactive titleText="Configuration → order" onClick={() => void navigate({ to: "/configs" })} />}
            >
              <ColumnChart
                style={chartH} dataset={d.funnel} noLegend loading={busy}
                dimensions={[{ accessor: "stage" }]}
                measures={[{ accessor: "count", label: "Configurations" }]}
              />
            </Card>
            <Card
              accessibleName="Open pipeline by age" loading={busy}
              header={<CardHeader titleText="Open pipeline by age" />}
            >
              <ColumnChart
                style={chartH} dataset={d.pipeline} loading={busy}
                dimensions={[{ accessor: "bucket" }]}
                measures={[
                  {
                    accessor: "confire", label: "via Confire", stackId: "open",
                    formatter: (v: number) => money(v, cur, 0),
                    highlightColor: (_v, _m, row) =>
                      row.bucket === ageFilter ? "var(--sapHighlightColor)"
                        : row.bucket === "30d+" ? "var(--sapNegativeColor)"
                          : undefined,
                  },
                  {
                    accessor: "other", label: "Other", stackId: "open",
                    formatter: (v: number) => money(v, cur, 0),
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
                  Showing the 1,000 most recent open quotations; older ones are not counted.
                </Text>
              )}
            </Card>
          </div>

          <div style={panels}>
            <Card
              accessibleName="Needs attention" loading={busy}
              header={
                <CardHeader
                  interactive
                  titleText="Needs attention"
                  additionalText={ageFilter ? `${attention.length} of ${d.attention.length}` : String(d.attention.length)}
                  action={ageFilter ? (
                    <Tag interactive design="Information" hideStateIcon onClick={(e) => {
                      e.stopPropagation();
                      setAgeFilter(null);
                    }}>{ageFilter}</Tag>
                  ) : undefined}
                  onClick={() => void navigate({ to: "/configs" })}
                />
              }
            >
              {attention.length === 0 ? (
                <IllustratedMessage name="NoData" design="Spot" titleText="Nothing waiting on you" />
              ) : (
                <List>
                  {attention.map((a) => (
                    <ListItemStandard
                      key={a.id} type="Navigation" description={a.customer ?? undefined}
                      additionalText={`${a.ageDays}d`}
                      additionalTextState={a.reason.startsWith("Portal") ? "Information" : "Critical"}
                      onClick={() => void navigate({ to: "/configs/$id", params: { id: a.id } })}
                    >
                      {a.name} — {a.reason}
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

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties } from "react";
import { BusyIndicator, Button, List, ListItemCustom, MessageStrip, Tag, Text } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Val } from "@confire/config-engine";
import { money } from "./costElements.ts";
import { formatCell } from "../../listSpec.ts";
import { orpc } from "../../orpc.ts";

// The two supplementary views of the process page — live B1 doc history and similar past
// configurations. Each is a panel in the insights rail (see InsightsRail.tsx).
//
// Both are Lists, not Tables. The rail is ~21rem wide and a responsive table needs its widest
// column to fit; doc history declared ~31.5rem of columns, so Popin fired on nearly every one and
// each row rendered as a stacked label/value blob. Fiori's own rule (responsive table, "do not
// use if"): few details per item and no cross-column comparison -> use a list. So the two panels
// share one shape — left bar = how relevant, right figure = the number you came for.

/** One flex row: headline column shrinks, figure column does not. */
const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" };
const MAIN: CSSProperties = { flex: 1, minWidth: 0 };
const MUTED: CSSProperties = { opacity: 0.7, fontSize: "0.875rem" };
/** Same one-line clamp ValueHelp's CELL uses — without it a long CardName reflows the row. */
const CLIP: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
/** tabular-nums so the decimal points line up down the column, which is what the table was for. */
const FIGURE: CSSProperties = { fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
const HEADER: CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem", padding: "0 0.25rem" };
/** Full row width, not the headline column — chips wrap to 3 lines if boxed into ~60% of a rail. */
const CHIPS: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.25rem", marginBlockStart: "0.25rem" };

// The 8rem "Match" column was the widest fixed one and carried the least — three states. As a
// `highlight` it is the native left bar and costs no width at all. Highlight has no "Neutral";
// an unmatched row simply has no bar. `text` survives as the tooltip so the colour stays readable.
const matchTag = {
  both: { highlight: "Positive", text: "customer + item" },
  item: { highlight: "Information", text: "item" },
  customer: { highlight: "None", text: "customer" },
} as const;

const setOf = (docType: "order" | "quotation") => (docType === "order" ? "Orders" : "Quotations");

export function DocHistory({ projectId, itemCodes, open }: {
  projectId: string;
  /** the item codes in the configuration's items grid — see InsightsRail */
  itemCodes: string[];
  /** the Documents panel is expanded */
  open: boolean;
}) {
  const navigate = useNavigate();
  // Debounced: this key drives two live B1 GETs (Orders + Quotations), and every distinct value
  // is a cache miss — undebounced, typing an item code is one agent round trip per keystroke.
  // A string, not the array: the caller rebuilds the array every render, and an array identity
  // that changes every render would restart the timer forever.
  const key = useDebounced(itemCodes.join("\n"), 500);
  const codes = key ? key.split("\n") : [];
  const q = useQuery({
    ...orpc.configs.docHistory.queryOptions({ input: { id: projectId, itemCodes: codes } }),
    enabled: open, // the panel stays mounted when collapsed —
    // don't fire live B1 agent traffic for a panel nobody is looking at.
    staleTime: 5 * 60_000,
    retry: false, // agent-offline should show its message, not spin
  });
  if (q.error)
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <MessageStrip design="Information" hideCloseButton>{q.error.message}</MessageStrip>
        <Button style={{ alignSelf: "start" }} onClick={() => void q.refetch()}>Retry</Button>
      </div>
    );
  if (q.data && !q.data.cardCode && !q.data.itemCodes.length)
    return <Text>Assign a customer to this configuration or fill in an item code to see past documents.</Text>;
  // No isPending early-return: List's own `loading` overlays the rows, so a refetch dims in place
  // instead of swapping the whole panel for a spinner and back.
  const rows = q.data?.rows ?? [];
  const found = q.data?.itemCodes ?? [];
  const context = [
    q.data?.cardCode && `customer ${q.data.cardCode}`,
    found.length > 0 && `item${found.length > 1 ? "s" : ""} ${found.join(", ")}`,
  ].filter(Boolean).join(" · ");

  return (
    // ponytail: one row per (doc, line) pair. A *customer*-matched document contributes all of its
    // lines, so 10 rows can be 2 documents repeating themselves — group with ListItemGroup keyed on
    // docEntry if that reads badly against real data.
    <List
      accessibleName="Past orders and quotations"
      loading={q.isFetching} loadingDelay={0}
      noDataText="No recent orders or quotations."
      separators="Inner"
      header={
        <div slot="header" style={HEADER}>
          <Text style={{ ...MUTED, ...CLIP, flex: 1 }}>{context}</Text>
          <Button icon="refresh" design="Transparent" tooltip="Refresh"
            disabled={q.isFetching} onClick={() => void q.refetch()} />
        </div>
      }
      onItemClick={(e) => {
        // dataset, not an index: the same way routes/_authed/b1/index.tsx carries identity through
        // a web-component event.
        const { entity, key } = (e.detail.item as HTMLElement).dataset;
        if (entity && key) void navigate({ to: "/b1/$entity/$key", params: { entity, key } });
      }}>
      {rows.map((r, i) => (
        <ListItemCustom key={i} data-entity={setOf(r.docType)} data-key={String(r.docEntry)}
          highlight={matchTag[r.matched].highlight}
          tooltip={`Matched on ${matchTag[r.matched].text}`}
          // A row with no DocEntry has nowhere to go — don't draw the chevron and lie about it.
          type={r.docEntry ? "Navigation" : "Inactive"}>
          <div style={ROW}>
            <div style={MAIN}>
              <div style={CLIP}>
                {r.itemCode}
                {r.itemDescription ? <span style={MUTED}>{`  ${r.itemDescription}`}</span> : null}
              </div>
              <div style={{ ...MUTED, ...CLIP }}>
                {[`${r.docType === "order" ? "SO" : "SQ"} ${r.docNum}`,
                  formatCell(r.docDate, "Edm.DateTimeOffset"),
                  r.cardName || r.cardCode].filter(Boolean).join(" · ")}
              </div>
            </div>
            <div style={{ textAlign: "end" }}>
              {/* `|| undefined` so money() falls back to its own default — passing "" explicitly
                  skips the default parameter and Intl throws on an empty currency code. */}
              <div style={FIGURE}>{money(r.unitPrice, r.currency || undefined)}</div>
              <div style={{ ...MUTED, whiteSpace: "nowrap" }}>{`× ${r.quantity}`}</div>
            </div>
          </div>
        </ListItemCustom>
      ))}
    </List>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Not Critical for a partial match: orange is Fiori's *warning* colour, and a 60% match is not a
// warning. Exact / close / differs is the actual scale.
const chipDesign = (score: number) => (score >= 0.99 ? "Positive" : score > 0 ? "Information" : "Neutral");
const scoreHighlight = (score: number) => (score >= 0.99 ? "Positive" : score >= 0.5 ? "Information" : "None");

export function Similar({ projectId, model, entries, onCopy }: {
  projectId: string;
  model: ModelDef;
  entries: Entries;
  onCopy: (v: Record<string, Val>) => void;
}) {
  const h = model.history;
  const debounced = useDebounced(entries, 500);
  const anyFilled = !!h?.mappings.some((m) => {
    const v = debounced[m.param];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  });
  const q = useQuery({
    ...orpc.configs.similar.queryOptions({ input: { id: projectId, entries: debounced } }),
    enabled: anyFilled,
    placeholderData: keepPreviousData, // re-rank without flashing while typing
    staleTime: 30_000,
  });
  const labelOf = (key: string) => model.parameters.find((p) => p.key === key)?.label ?? key;

  if (!h?.mappings.length)
    return <Text>No similarity mappings configured for this model (model builder → History).</Text>;
  if (!anyFilled) return <Text>Fill a mapped parameter to find similar past configurations.</Text>;
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "2rem" }} />;
  if (q.error) return <MessageStrip design="Information" hideCloseButton>{q.error.message}</MessageStrip>;
  if (!q.data.results.length)
    return <Text>No historic rows yet — an admin can press "Sync now" in the model's History tab.</Text>;

  return (
    // The dim stays, and List's own `loading` is deliberately NOT used here: paired with
    // keepPreviousData it re-ranks in place, where a loading overlay would flash per keystroke.
    <div style={{ opacity: q.isFetching ? 0.6 : 1 }}>
      <List accessibleName="Similar past configurations" separators="Inner">
        {q.data.results.map((r, i) => {
          const pct = Math.round(r.score * 100);
          // display columns identify the row — the author ordered them. Values alone on one line,
          // the labelled form (the old subtitle) kept as the tooltip so nothing is lost.
          const values = Object.values(r.display).map((v) => String(v ?? "—")).join(" · ");
          const labelled = Object.entries(r.display).map(([k, v]) => `${k}: ${String(v ?? "—")}`).join(" · ");
          return (
            <ListItemCustom key={i} type="Inactive" highlight={scoreHighlight(r.score)} tooltip={labelled}>
              <div style={{ width: "100%" }}>
                {/* Score on the headline line, evidence beneath it across the full width — same
                    shape as Documents, where the price sits on line 1. */}
                <div style={ROW}>
                  <div style={{ ...MAIN, ...CLIP }}>{values || `${pct}% match`}</div>
                  <span style={FIGURE}>{`${pct}%`}</span>
                  {/* Transparent, not Emphasized: up to 10 results render here (scoreRows caps at
                      top=10) and Fiori allows one emphasized button per page, not ten. */}
                  <Button design="Transparent" icon="copy" tooltip="Use these values"
                    onClick={() => onCopy(r.values)} />
                </div>
                <div style={CHIPS}>
                  {r.matches.map((m) => (
                    <Tag key={m.param} design={chipDesign(m.score)} hideStateIcon>
                      {labelOf(m.param)}: {String(m.value ?? "—")}
                    </Tag>
                  ))}
                </div>
              </div>
            </ListItemCustom>
          );
        })}
      </List>
    </div>
  );
}

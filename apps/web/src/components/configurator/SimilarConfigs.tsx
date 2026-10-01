import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties } from "react";
import { BusyIndicator, Button, List, ListItemCustom, MessageStrip, Tag, Text } from "@ui5/webcomponents-react";
import type { Entries, ModelDef, Val } from "@confire/config-engine";
import { money } from "../../lib/money.ts";
import { formatCell } from "../../listSpec.ts";
import { orpc } from "../../orpc.ts";

// "Similar configurations": the process page's fuzzy help, ranking the model's cached history
// rows against the entries filled so far. A panel in the insights rail (see InsightsRail.tsx).
//
// A List, not a Table. The rail is ~21rem wide and a responsive table needs its widest column to
// fit, so Popin fires on nearly every one and each row renders as a stacked label/value blob.
// Fiori's own rule (responsive table, "do not use if"): few details per item and no cross-column
// comparison -> use a list. Left bar = how relevant, right figure = the number you came for.

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

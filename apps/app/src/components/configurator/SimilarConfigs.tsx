import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, IllustratedMessage, MessageStrip, ObjectStatus } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/BeforeSearch.js";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { historyFields, historyKey, type Entries, type ModelDef, type TableRows, type Val } from "@confire/config-engine";
import { Grid, type CellTemplate, type GridState } from "@confire/ui/list-report/Grid.tsx";
import { formatValue } from "@confire/ui/format.ts";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { useI18n } from "../../i18n.ts";
import { orpc, type client } from "../../orpc.ts";

// "Similar configurations": the process page's fuzzy help, ranking the model's cached history
// rows against the entries filled so far — a section of its own above Candidates. One grid row
// per past configuration, best first (the server's order, so nothing sorts): how well it matched,
// the columns the author picked to identify it, then every mapped value — what Copy writes — each
// coloured by how closely it matched what is filled in.

type Result = Awaited<ReturnType<typeof client.configs.similar>>["results"][number];

// The line's own fields. Not identifiers, so no parameter key or query column collides.
const SCORE = "#score";
const RESULT = "#result";
const COPY = "#copy";
const shown = (column: string) => `#d:${column}`;
const scoreOf = (key: string) => `#s:${key}`;

// Not Critical for a partial match: orange is Fiori's *warning* colour, and a 60% match is not a
// warning. Exact / close / differs is the actual scale; a mapping nothing was filled for is plain.
const matchState = (score: unknown) =>
  typeof score !== "number" ? "None" : score >= 0.99 ? "Positive" : score > 0 ? "Information" : "None";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const filled = (v: Val | undefined) =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

const empty = (name: string, title: string, subtitle: string) => (
  <IllustratedMessage name={name} design="Small" titleText={title} subtitleText={subtitle} />
);

export function SimilarConfigs({ projectId, model, entries, tables, onCopy }: {
  projectId: string;
  model: ModelDef;
  entries: Entries;
  tables: TableRows;
  onCopy: (v: Record<string, Val>, item: number | null) => void;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const h = model.history;
  // Debounce the page's own object (its identity only changes on an edit), then narrow: a subset
  // rebuilt every render would restart the timer on every render.
  const debounced = useDebounced(entries, 500);
  const rows = useDebounced(tables, 500);
  // Only the mapped values go over the wire — the parameters, and each items-grid row's mapped
  // cells keyed `<table>.<column>` (every row, empty ones too: the answer's `item` is a row index).
  // They are all scoreRows reads, and the query key is hashed structurally, so an edit to any other
  // field no longer re-ranks.
  const mapped: Entries = {};
  const cols = (h?.mappings ?? []).filter((m) => m.table);
  for (const m of h?.mappings ?? []) if (!m.table && filled(debounced[m.param])) mapped[m.param] = debounced[m.param]!;
  // historyFields allows the items grid alone, so every column mapping names the same table.
  const items = cols.length ? (rows[cols[0]!.table!] ?? []).map((r) =>
    Object.fromEntries(cols.filter((m) => filled(r[m.param])).map((m) => [historyKey(m), r[m.param]!]))) : [];
  const anyFilled = Object.keys(mapped).length > 0 || items.some((r) => Object.keys(r).length > 0);
  const q = useQuery({
    ...orpc.configs.similar.queryOptions({ input: { id: projectId, entries: mapped, ...(items.length ? { items } : {}) } }),
    enabled: anyFilled,
    placeholderData: keepPreviousData, // re-rank without flashing while typing
    staleTime: 30_000,
  });

  const matchText = t("CONFIG_MATCH");
  const copyText = t("CONFIG_USE_VALUES");
  const columns = useMemo<ListColumn[]>(() => {
    const fields = historyFields(model);
    return [
      { key: SCORE, label: matchText, type: "number", sortable: false },
      ...(model.history?.display ?? []).map((c) => ({ key: shown(c), label: c, sortable: false })),
      ...(model.history?.mappings ?? []).map((m) => {
        const k = historyKey(m);
        return { key: k, label: fields.get(k)?.label ?? k, type: fields.get(k)?.type, sortable: false };
      }),
      { key: COPY, label: "", sortable: false, width: 64 },
    ];
  }, [model, matchText]);
  const state = useMemo<GridState>(() => ({ columns: columns.map((c) => c.key), sortBy: [], groupBy: [] }), [columns]);

  // A template must outlive the render (a new one is a new component type, and would remount the
  // button under the user's focus), so Copy reads the page's latest handler through a ref.
  const copy = useRef(onCopy);
  copy.current = onCopy;
  const cellTemplates = useMemo<Record<string, CellTemplate>>(() => {
    // A span when there is no state, as Grid's own status cells: ObjectStatus announces itself.
    const matched: CellTemplate = (r, c) => {
      const state = matchState(r[scoreOf(c.key)]);
      const text = formatValue(r[c.key], c.type);
      return state === "None" ? <span>{text}</span> : <ObjectStatus state={state}>{text}</ObjectStatus>;
    };
    return {
      ...Object.fromEntries((model.history?.mappings ?? []).map((m) => [historyKey(m), matched])),
      // Transparent, not Emphasized: one per row, and Fiori allows one emphasized button per page.
      [COPY]: (r) => {
        const res = r[RESULT] as Result;
        return <Button design="Transparent" icon="copy" tooltip={copyText} accessibleName={copyText}
          onClick={() => copy.current(res.values, res.item)} />;
      },
    };
  }, [model, copyText]);

  if (!anyFilled) return empty("BeforeSearch", t("CONFIG_NOTHING_COMPARE"), t("CONFIG_NOTHING_COMPARE_SUB"));
  if (q.error) return <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip>;
  if (q.data && !q.data.results.length) return empty("NoEntries", t("CONFIG_NO_HISTORY"), t("CONFIG_NO_HISTORY_SUB"));

  const results = (q.data?.results ?? []).map((r): Row => ({
    [SCORE]: Math.round(r.score * 100),
    [RESULT]: r,
    ...Object.fromEntries(Object.entries(r.display).map(([c, v]) => [shown(c), v])),
    ...r.values,
    ...Object.fromEntries(r.matches.map((m) => [scoreOf(m.param), m.score])),
  }));
  // The first answer loads as the table's skeleton; a re-rank keeps the last one on screen, and
  // the table's busy overlay waits a second (loadingDelay) before it shows, so typing never flashes.
  return (
    <Grid title={t("CONFIG_SIMILAR_LIST")} columns={columns} state={state} rows={results} fill={false}
      loading={q.isFetching} cellTemplates={cellTemplates} />
  );
}

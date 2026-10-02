import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, MultiInput, SuggestionItemCustom, Text, Token, type MultiInputDomRef,
} from "@ui5/webcomponents-react";
import { orpc } from "../../orpc.ts";
import { EntityLink, useCanOpen, useEntityNav } from "../EntityLink.tsx";
import { formatValue } from "../format.ts";
import { showLink } from "../navigation.ts";
import { fetchPage, sourceKey } from "./cfl-provider.ts";
import { allExist, findRow, markKnown, notFoundMessage, probeKey, probeRequest } from "./existence.ts";
import { keyFieldOf, tokenLabel } from "./cfl-configs.ts";
import type { CflFieldConfig, LinkConfig, Row } from "../types.ts";

// beas-cfl-field (VALUE-HELP-AND-KEY-NAVIGATION.md §3): a key field with type-ahead, the F4 value
// help, tokens for multi-select, an existence check and a link to the record the key names.
//
// Built on MultiInput even for single select: it is the UI5 input that carries the value-help
// icon and fires valueHelpTrigger on F4 natively; a single-select field simply never has tokens.
// Arrow keys, Enter and Esc over the suggestions are the input's own.

const CflDialog = lazy(() => import("./CflDialog.tsx"));

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);
const showAll = (n: number) => `Show all (${n})`;

export function CflField({
  config, value, onValueChange, onRowSelect, onExistenceError, onCheckStarted,
  editable = true, disabled, placeholder, maxLength, error, required, link, formData, mustExist: mustExistProp,
  accessibleName,
}: {
  config: CflFieldConfig;
  /** single: the key; multi-select: the token rows */
  value: unknown;
  onValueChange: (v: unknown) => void;
  /** a row was picked — or a typed key was found — so dependent fields can fill */
  onRowSelect?: (row: Row) => void;
  onExistenceError?: (message: string | null) => void;
  /** a probe started: an object page waits for it before saving */
  onCheckStarted?: (p: Promise<unknown>) => void;
  editable?: boolean;
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
  error?: string | null;
  /** show the empty state as an error right away (pages without a save-time validation) */
  required?: boolean;
  link?: true | LinkConfig;
  /** the record — `link.idField` reads from it */
  formData?: Row;
  mustExist?: boolean;
  accessibleName?: string;
}) {
  const d = config.dialogConfig;
  const key = keyFieldOf(d);
  const multi = !!d.multiSelect;
  const labelMode = !multi && !!d.displayColumns?.length;
  const src = config.searchEndpoint ?? d.source;
  const mustExist = mustExistProp ?? config.mustExist ?? true;
  const qc = useQueryClient();
  const canOpen = useCanOpen();
  const go = useEntityNav();
  const inputRef = useRef<MultiInputDomRef>(null);

  const [typed, setTyped] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const focusedRef = useRef(false);
  const latestText = useRef("");
  const [sugg, setSugg] = useState<{ rows: Row[]; total: number; text: string } | null>(null);
  const [dialog, setDialog] = useState<string | null>(null);
  const [missing, setMissing] = useState<unknown>(undefined);
  const [ownError, setOwnError] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** the suggestion the arrow keys or the mouse last landed on — `change` then says it was taken */
  const preview = useRef<{ idx: number | "all"; text: string } | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const tokens = multi && Array.isArray(value) ? (value as Row[]) : [];
  const raw = multi || isBlank(value) ? "" : String(value);

  // Label mode: the key's display columns, looked up once per key — through the probe's own cache
  // entry, so a probed key never costs a second read for its label.
  const label = useQuery({
    queryKey: probeKey(config, value),
    queryFn: () => fetchPage(src, probeRequest(config, value)),
    enabled: labelMode && !isBlank(value),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const labelRow = label.data?.rows.find((r) => String(r[key] ?? "").trim() === raw.trim()) ?? label.data?.rows[0];
  const labelText = labelRow ? (d.displayColumns ?? []).map((c) => formatValue(labelRow[c])).filter(Boolean).join("  ") : "";

  const setErr = (m: string | null) => {
    setOwnError(m);
    onExistenceError?.(m);
  };

  const check = async (v: unknown, fromTyping: boolean) => {
    if (!mustExist || isBlank(v) || !key) {
      setMissing(undefined);
      setErr(null);
      return;
    }
    const p = findRow(qc, config, v);
    onCheckStarted?.(p);
    const row = await p;
    if (row === null) {
      setMissing(v);
      setErr(notFoundMessage(config));
    } else {
      setMissing(undefined);
      setErr(null);
      // A typed key that resolves fills the same fields a pick does (Beas object dialog).
      if (row && fromTyping) onRowSelect?.(row);
    }
  };

  const suggest = (text: string) => {
    clearTimeout(timer.current);
    preview.current = null;
    if (!text.trim()) {
      setSugg(null);
      return;
    }
    timer.current = setTimeout(async () => {
      const my = ++seq.current;
      try {
        // startswith, as Beas' type-ahead — the dialog searches with contains. A masterdata
        // source has no startswith and uses contains either way.
        const page = await fetchPage(src, {
          search: text, searchFields: d.searchFields, mode: "startswith", filter: d.fixedFilters,
          count: src.kind === "entity",
        });
        // Stale: a newer request went out, the field lost focus, or the text moved on.
        if (my !== seq.current || !focusedRef.current || latestText.current !== text) return;
        setSugg({ rows: page.rows.slice(0, 10), total: page.total ?? page.rows.length, text });
      } catch {
        if (my === seq.current) setSugg(null);
      }
    }, 200);
  };

  const setInputText = (t: string) => {
    if (inputRef.current) inputRef.current.value = t;
  };

  const addTokens = (rows: Row[]) => {
    const have = new Set(tokens.map((t) => String(t[key] ?? "").trim()));
    const fresh = rows.filter((r) => {
      const k = String(r[key] ?? "").trim();
      if (!k || have.has(k)) return false;
      have.add(k);
      return true;
    });
    setTyped(null);
    latestText.current = "";
    setInputText("");
    if (!fresh.length) return;
    const next = [...tokens, ...fresh];
    onValueChange(next);
    if (mustExist) void allExist(qc, config, next.map((t) => t[key])).then((gone) =>
      setErr(gone.size ? `${notFoundMessage(config)}: ${[...gone].join(", ")}` : null));
  };

  const pick = (row: Row) => {
    setSugg(null);
    setTyped(null);
    latestText.current = "";
    if (multi) return addTokens([row]);
    onValueChange(trimmed(row[key]) ?? null);
    onRowSelect?.(row);
    markKnown(qc, config, row);
    setMissing(undefined);
    setErr(null);
  };

  const openDialog = (search: string) => {
    clearTimeout(timer.current);
    setSugg(null);
    setDialog(search);
  };

  const onChange = (text: string) => {
    const pv = preview.current;
    preview.current = null;
    if (pv && pv.text === text) {
      if (pv.idx === "all") {
        // The "Show all" item put its own caption in the input; put the search back.
        const search = sugg?.text ?? latestText.current;
        setInputText(multi || labelMode ? search : raw);
        return openDialog(search);
      }
      const row = sugg?.rows[pv.idx];
      if (row) return pick(row);
    }
    const t = text.trim();
    setSugg(null);
    if (multi) return t ? addTokens([{ [key]: t }]) : undefined;
    if (labelMode) {
      // Typing in label mode only searches; the value changes on a pick. Clearing the box clears
      // the value, and an exact key from the suggestions counts as picking it.
      setTyped(null);
      if (!t) {
        if (!isBlank(value)) onValueChange(null);
        return;
      }
      const hit = sugg?.rows.find((r) => String(r[key] ?? "").trim().toLowerCase() === t.toLowerCase());
      if (hit) pick(hit);
      return;
    }
    setTyped(null);
    if (t !== raw) onValueChange(t === "" ? null : t);
    void check(t, true);
  };

  // --- display ------------------------------------------------------------------------------
  const target = multi ? null : showLink({ link, dialogRoute: d.route, value, row: formData, missingValue: missing, canOpen });
  const shownText = labelMode ? (labelText || raw) : raw;

  if (!editable) {
    if (multi) return <Text>{tokens.map((t) => tokenLabel(t, d)).join(", ")}</Text>;
    return target ? (
      <EntityLink route={target.route} target={target.target} value={value}
        action={target.action ? (v) => target.action!(v, formData ?? {}) : undefined}>
        {shownText}
      </EntityLink>
    ) : <Text>{shownText}</Text>;
  }

  const err = error ?? ownError ?? (required && (multi ? !tokens.length : isBlank(value)) ? "Pick a value." : null);
  const inputValue = multi ? (typed ?? "") : labelMode ? (focused ? (typed ?? "") : shownText) : (typed ?? raw);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", width: "100%" }}>
      {target ? (
        <Button icon="navigation-right-arrow" design="Transparent" tooltip="Open" accessibleName="Open"
          onClick={() => (target.action ? target.action(value, formData ?? {}) : target.route && go(target.route, target.target))} />
      ) : null}
      <MultiInput
        ref={inputRef}
        style={{ flex: 1, minWidth: 0, width: "100%" }}
        value={inputValue}
        placeholder={placeholder ?? (labelMode && focused ? shownText : undefined)}
        accessibleName={accessibleName}
        disabled={disabled}
        maxlength={multi || labelMode ? undefined : maxLength}
        showSuggestions
        // The server already matched; re-filtering could only drop a row it chose, and inline
        // autocompletion would type the first match's key into the box for the user.
        filter="None"
        noTypeahead
        showValueHelpIcon
        showClearIcon={!multi}
        valueState={err ? "Negative" : "None"}
        valueStateMessage={err ? <div>{err}</div> : undefined}
        tokens={multi ? tokens.map((t) => (
          <Token key={String(t[key])} text={tokenLabel(t, d)} data-k={String(t[key] ?? "")} />
        )) : undefined}
        onFocus={() => { focusedRef.current = true; setFocused(true); }}
        onBlur={() => {
          focusedRef.current = false;
          setFocused(false);
          if (labelMode) setTyped(null);
        }}
        onInput={(e) => {
          const t = e.target.value ?? "";
          // Landing on or taking a suggestion fires `input` with that suggestion's text (for "Show
          // all", its caption). That is not typing: `change` takes the pick, so no new search and
          // no keystroke value.
          if (preview.current && t === preview.current.text) return;
          latestText.current = t;
          setTyped(t);
          // Plain single select: every keystroke is the value (Beas valueChange(text)).
          if (!multi && !labelMode) onValueChange(t === "" ? null : t);
          suggest(t);
        }}
        onChange={(e) => onChange(e.target.value ?? "")}
        onSelectionChange={(e) => {
          const item = e.detail.item as (HTMLElement & { text?: string }) | null;
          preview.current = item
            ? { idx: item.dataset.idx === "all" ? "all" : Number(item.dataset.idx), text: item.text ?? "" }
            : null;
        }}
        onValueHelpTrigger={() => openDialog(typed ?? "")}
        onTokenDelete={(e) => {
          const gone = new Set(e.detail.tokens.map((t) => (t as HTMLElement).dataset.k));
          onValueChange(tokens.filter((t) => !gone.has(String(t[key] ?? ""))));
        }}
      >
        {focused && sugg ? [
          ...sugg.rows.map((row, i) => (
            <SuggestionItemCustom key={i} text={String(row[key] ?? "")} data-idx={String(i)}>
              <SuggestionRow row={row} config={config} />
            </SuggestionItemCustom>
          )),
          <SuggestionItemCustom key="all" text={showAll(sugg.total)} data-idx="all">
            <span style={{ color: "var(--sapLinkColor)" }}>{showAll(sugg.total)}</span>
          </SuggestionItemCustom>,
        ] : null}
      </MultiInput>
      {dialog !== null ? (
        <Suspense fallback={null}>
          <CflDialog config={d} initialSearch={dialog} multiSelect={multi}
            onClose={() => setDialog(null)}
            onSelect={(rows) => {
              setDialog(null);
              if (multi) addTokens(rows);
              else if (rows[0]) pick(rows[0]);
            }} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** One suggestion: the non-hidden columns — or, once the user has arranged the dialog's grid,
 *  those columns in that order (read from the cache only; a suggestion never costs a fetch). */
function SuggestionRow({ row, config }: { row: Row; config: CflFieldConfig }) {
  const qc = useQueryClient();
  const d = config.dialogConfig;
  const layout = qc.getQueryData(orpc.views.getState.queryOptions({ input: { key: `cfl:${sourceKey(d.source)}` } }).queryKey) as
    { columns?: string[] } | null | undefined;
  const cols = layout?.columns?.length ? layout.columns : d.columns.filter((c) => !c.hidden).map((c) => c.key);
  return (
    <div style={{ display: "flex", gap: "1rem", width: "100%", overflow: "hidden" }}>
      {cols.map((c, j) => (
        <span key={c} style={{
          flex: j === 0 ? "none" : 1, fontWeight: j === 0 ? 600 : undefined,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {formatValue(row[c])}
        </span>
      ))}
    </div>
  );
}

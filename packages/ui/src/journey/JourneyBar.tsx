import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "@ui5/webcomponents-react";
import { ringOf, type JourneyNext, type Ring, type Side } from "./ring.ts";

// A project's six steps (sent · review · quoted · ordered · delivered · invoiced) as icon nodes joined
// by a line, the page header's progress bar. UI5 has nothing for a read-only step display (Wizard is for
// input), so this draws it, every colour a theme variable. The server decides `step` and `next`
// (portal/journey.ts); `side` is the reader's, and the current node's ring says whose move it is
// (ringOf). The icons are named, so each app must have registered them (both load AllIcons).

export const JOURNEY_ICONS = ["paper-plane", "inspection", "sales-quote", "sales-order", "shipping-status", "receipt"] as const;

const RING: Record<Ring, { color: string; text: string }> = {
  Critical: { color: "var(--sapCriticalColor)", text: "var(--sapCriticalTextColor)" },
  Negative: { color: "var(--sapNegativeColor)", text: "var(--sapNegativeTextColor)" },
  Neutral: { color: "var(--sapNeutralBorderColor)", text: "var(--sapNeutralTextColor)" },
  Information: { color: "var(--sapInformativeColor)", text: "var(--sapInformativeTextColor)" },
};

const D = "2.75rem"; // node diameter
const ICON = "1.15rem"; // 0.42 of it
const NARROW_REM = 30;

// The pulse needs @keyframes and the hover needs :hover, which inline styles cannot say. React 19 hoists a
// <style href precedence> into <head> once however many bars are drawn. The keyframes sit inside the
// motion query, so under reduced motion the pulse's `animation` names nothing and its shadow stays empty.
const CSS = `@media (prefers-reduced-motion: no-preference){@keyframes cf-jr-pulse{to{box-shadow:0 0 0 .875rem transparent}}}
.cf-jr-btn:hover .cf-jr-node{filter:brightness(.96)}`;

/** Narrow mode hides a label by clipping it, not display:none, so a screen reader still gets every step. */
const CLIPPED: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

const LINE = "var(--sapList_BorderColor)";
const DONE = "var(--sapPositiveColor)";

/** Half of the line between two nodes: `side` 0 runs into node i from the left, 1 out of it to the right. */
const half = (side: 0 | 1, done: boolean): CSSProperties => ({
  position: "absolute", top: `calc(${D} / 2 - 1px)`, height: 2, width: "50%",
  [side ? "right" : "left"]: 0, background: done ? DONE : LINE,
});

function node(state: "done" | "cur" | "todo", ring: string): CSSProperties {
  const base: CSSProperties = {
    position: "relative", zIndex: 1, boxSizing: "border-box", width: D, height: D, borderRadius: "50%", display: "grid", placeItems: "center",
  };
  if (state === "done") return { ...base, background: DONE, border: `1px solid ${DONE}`, color: "var(--sapButton_Emphasized_TextColor)" };
  if (state === "cur") {
    return { ...base, background: "var(--sapList_Background)", color: ring,
      boxShadow: `0 0 0 .1875rem ${ring}, 0 0 0 .5625rem color-mix(in srgb, ${ring} 14%, transparent)` };
  }
  return { ...base, background: "var(--sapNeutralBackgroundColor)", border: `1px solid ${LINE}`, color: "var(--sapContent_NonInteractiveIconColor)" };
}

export function JourneyBar({ step, next, side, labels, dates, nextText, ariaLabel, onStep }: {
  step: number; next: JourneyNext; side: Side;
  labels: string[];
  dates: (string | undefined)[];
  nextText: string;
  ariaLabel: string;
  onStep?: (step: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  // Its own width, not the window's: the bar sits in a page that may be a column. Container queries cannot
  // be said inline; the layout effect measures before the first paint, the observer follows resizes.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < parseFloat(getComputedStyle(document.documentElement).fontSize) * NARROW_REM);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ring = RING[ringOf(next, side)];
  return (
    <div ref={root} role="group" aria-label={ariaLabel}
      style={{ display: "grid", gridTemplateColumns: `repeat(${labels.length}, minmax(0, 1fr))` }}>
      <style href="cf-journey-bar" precedence="default">{CSS}</style>
      {labels.map((label, i) => {
        const done = i < step, cur = i === step;
        const date = done ? dates[i] : undefined;
        const hide = narrow && !cur;
        const text: CSSProperties = { textAlign: "center", overflowWrap: "anywhere", ...(hide ? CLIPPED : {}) };
        const body = (
          <>
            <span className="cf-jr-node" style={node(done ? "done" : cur ? "cur" : "todo", ring.color)}>
              {cur && <span aria-hidden style={{ position: "absolute", inset: "-.1875rem", borderRadius: "50%",
                boxShadow: `0 0 0 0 color-mix(in srgb, ${ring.color} 40%, transparent)`, animation: "cf-jr-pulse 2.4s ease-out infinite" }} />}
              <Icon name={JOURNEY_ICONS[i]} style={{ width: ICON, height: ICON, color: "inherit" }} />
            </span>
            <span style={{ ...text, fontSize: "0.8125rem", color: done || cur ? "var(--sapTextColor)" : "var(--sapContent_LabelColor)", fontWeight: cur ? 700 : 400 }}>{label}</span>
            {(date || cur) && (
              <span style={{ ...text, fontSize: "var(--sapFontSmallSize)", marginTop: "-0.375rem",
                ...(cur ? { color: ring.text, fontWeight: 700 } : { color: "var(--sapContent_LabelColor)" }) }}>{cur ? nextText : date}</span>
            )}
          </>
        );
        const column: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: "0.5rem", minWidth: 0 };
        return (
          <div key={i} aria-current={cur ? "step" : undefined} style={{ ...column, position: "relative" }}>
            {i > 0 && <span style={half(0, i <= step)} />}
            {i < labels.length - 1 && <span style={half(1, i < step)} />}
            {done && onStep ? (
              <button type="button" className="cf-jr-btn" aria-label={date ? `${label}, ${date}` : label} onClick={() => onStep(i)}
                style={{ ...column, maxWidth: "100%", padding: 0, border: 0, background: "none", font: "inherit", color: "inherit", cursor: "pointer" }}>
                {body}
              </button>
            ) : body}
          </div>
        );
      })}
    </div>
  );
}

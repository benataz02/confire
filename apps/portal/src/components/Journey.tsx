import type { CSSProperties } from "react";
import type { client } from "../orpc.ts";

// An inquiry's six steps (sent · review · quoted · ordered · delivered · invoiced) as dots joined by a
// line. UI5 has nothing for a read-only step display — Wizard is for input, a horizontal Timeline is an
// event log — so this draws it, every colour a theme variable. The server decides `step` and `next`
// (portal/journey.ts); this only draws them.

export type HomeInquiry = Awaited<ReturnType<typeof client.home.overview>>["inquiries"][number];
export type Next = HomeInquiry["next"];

/** The current dot's ring says whose move it is: the customer's (Critical), a refusal (Negative), a
 *  draft nobody sent (neutral), else the supplier at work. */
const RING: Partial<Record<Next, string>> = {
  answer: "var(--sapCriticalColor)",
  changes: "var(--sapCriticalColor)",
  declined: "var(--sapNegativeColor)",
  finish: "var(--sapNeutralBorderColor)",
};

const DOT = "0.75rem";
const DONE = "var(--sapPositiveColor)";
const TODO = "var(--sapNeutralBorderColor)";

function dot(i: number, step: number, next: Next): CSSProperties {
  const base: CSSProperties = { position: "relative", width: DOT, height: DOT, borderRadius: "50%", boxSizing: "border-box" };
  if (i < step) return { ...base, background: DONE };
  if (i === step) return { ...base, background: "var(--sapList_Background)", boxShadow: `0 0 0 0.1875rem ${RING[next] ?? "var(--sapInformativeColor)"}` };
  return { ...base, background: TODO };
}

/** Half of the line between two dots: `side` 0 runs into dot i from the left, 1 out of it to the right. */
const half = (side: 0 | 1, done: boolean): CSSProperties => ({
  position: "absolute", top: `calc(${DOT} / 2 - 0.0625rem)`, height: "0.125rem", width: "50%",
  [side ? "right" : "left"]: 0, background: done ? DONE : TODO,
});

/** One column per step: the dot centred over its label, the line drawn as two halves per column so the
 *  dots sit exactly over their labels at any width. */
export function Journey({ step, next, labels, ariaLabel }: { step: number; next: Next; labels: string[]; ariaLabel: string }) {
  return (
    <div role="img" aria-label={ariaLabel}
      style={{ display: "grid", gridTemplateColumns: `repeat(${labels.length}, minmax(3.75rem, 1fr))`, padding: "0.25rem 0 0" }}>
      {labels.map((label, i) => (
        <div key={label} style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: "0.375rem" }}>
          {i > 0 && <span style={half(0, i <= step)} />}
          {i < labels.length - 1 && <span style={half(1, i + 1 <= step)} />}
          <span style={dot(i, step, next)} />
          <span aria-hidden style={{ fontSize: "var(--sapFontSmallSize)", color: "var(--sapContent_LabelColor)", whiteSpace: "nowrap" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

import type { CSSProperties } from "react";

// Joule's colours (Joule spec §3, read off SAP for Me): Horizon and Horizon Dark get them; any other
// theme (high contrast, Quartz) keeps its own parameters, so high contrast stays high contrast. Set
// inline on the panel as `--cf-a-*`, which inherit into UI5's shadow DOM: no stylesheet.

export type Palette = "light" | "dark" | null;

export function paletteFor(theme: string, osDark: boolean): Palette {
  if (theme === "sap_horizon") return "light";
  if (theme === "sap_horizon_dark") return "dark";
  if (theme === "sap_horizon_auto") return osDark ? "dark" : "light";
  return null;
}

/** name → [dark, light, other themes]. */
const VARS: Record<string, [string, string, string]> = {
  head: ["#140069", "#f4f2ff", "var(--sapAssistant_BackgroundGradient)"],
  "head-text": ["#f5f6f7", "#000", "var(--sapAssistant_TextColor)"],
  "head-hover": ["#4db1ff", "#5d36ff", "var(--sapAssistant_Hover_TextColor)"],
  "head-active": ["#4db1ff", "#a100c2", "var(--sapAssistant_Active_TextColor)"],
  page: ["#1d232a", "#fff", "var(--sapBackgroundColor)"],
  text: ["#f5f6f7", "#131e29", "var(--sapTextColor)"],
  question: ["#12171c", "#eae5ff", "var(--sapAssistant_Question_Background)"],
  accent: ["#4db1ff", "#5d36ff", "var(--sapLinkColor)"],
  "accent-soft": ["#1d2d3e", "rgba(116,88,255,.06)", "var(--sapList_SelectionBackgroundColor)"],
  more: ["#f5f6f7", "#5d36ff", "var(--sapButton_Lite_TextColor)"],
  send: ["#0070f2", "#5d36ff", "var(--sapButton_Emphasized_Background)"],
  "send-empty": ["rgba(0,112,242,.5)", "#beafff", "var(--sapButton_Emphasized_Background)"],
  "send-text": ["#fff", "#fff", "var(--sapButton_Emphasized_TextColor)"],
  focus: ["#9ad3ff", "#5d36ff", "var(--sapContent_FocusColor)"],
  "hover-shadow": ["0 4px 8px #1B90FF29, 0 0 2px #1B90FF29", "0 0 2px #5d36ff", "none"],
  muted: ["#8396a8", "#556b82", "var(--sapContent_LabelColor)"],
  mark: ["#f5f6f7", "#5d36ff", "var(--sapAssistant_TextColor)"],
  shadow: ["2px 2px 8px rgba(93,54,255,.16)", "2px 2px 8px rgba(93,54,255,.16)", "var(--sapContent_Shadow2)"],
};

export function paletteVars(p: Palette): CSSProperties {
  const i = p === "dark" ? 0 : p === "light" ? 1 : 2;
  return Object.fromEntries(Object.entries(VARS).map(([k, v]) => [`--cf-a-${k}`, v[i]])) as CSSProperties;
}

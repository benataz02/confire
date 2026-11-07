import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { TextArea, type TextAreaDomRef } from "@ui5/webcomponents-react";

// The chat box both apps write in — the assistant's and a client project's comments — as ChatGPT's:
// one pill row (leading buttons, the field, trailing buttons) while the text fits on it; once it does
// not, the text takes the pill's whole width and the buttons drop to a row under it, and it goes back
// when the text fits again. The field grows a row per line to 8, then scrolls. Enter sends,
// Shift+Enter breaks the line. Its look is UI5's theme unless the caller passes its own (`look`).

/** A round button (send): its radius, and its segment's — the AI button's inner one is a split button's. */
export const ROUND_BUTTON = { "--sapButton_BorderCornerRadius": "50%", "--sapButton_Segment_BorderCornerRadius": "50%" } as CSSProperties;

/** The textarea's own field look, switched off through its public parameters: the pill draws the
 *  border and the focus instead. */
const BARE_FIELD = {
  width: "100%",
  margin: 0,
  "--sapField_Background": "transparent",
  "--sapField_Hover_Background": "transparent",
  "--sapField_Focus_Background": "transparent",
  "--sapField_ReadOnly_Background": "transparent",
  "--sapField_BackgroundStyle": "none",
  "--sapField_Hover_BackgroundStyle": "none",
  "--sapField_ReadOnly_BackgroundStyle": "none",
  "--sapField_BorderWidth": "0",
  "--sapField_Shadow": "none",
  "--sapField_Hover_Shadow": "none",
  "--sapContent_FocusWidth": "0",
  // One row is the buttons' height (36 px cozy, 26 compact): UI5 draws it 2 px taller (line + 8/7 px
  // padding + a 1 px wrapper edge each side). Its padding variables also size the mirror `growing`
  // measures, so they are the one knob.
  // ponytail: UI5's private variables (`--_ui5_`); recheck on a UI5 bump — at worst it is 2 px off again.
  "--_ui5_textarea_padding_top": "var(--_ui5-compact-size, .125rem) var(--_ui5-cozy-size, .4375rem)",
  "--_ui5_textarea_padding_bottom": "var(--_ui5-compact-size, .0625rem) var(--_ui5-cozy-size, .375rem)",
} as CSSProperties;

let canvas: CanvasRenderingContext2D | null = null;
const textWidth = (text: string, s: CSSStyleDeclaration) => {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return 0;
  canvas.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  return canvas.measureText(text).width;
};

export type ComposerLook = { background?: string; border?: string; focus?: string; shadow?: string; hoverShadow?: string };

export function Composer({
  value, onInput, onSend, placeholder, accessibleName, disabled, readonly, maxlength, leading, trailing, look = {}, inputRef,
}: {
  value: string;
  onInput: (value: string) => void;
  /** Enter without Shift; the caller decides whether there is anything to send */
  onSend: () => void;
  placeholder: string; accessibleName?: string;
  disabled?: boolean; readonly?: boolean; maxlength?: number;
  /** before the field (attach, toggles); under it, at the left, while the text spans the pill */
  leading?: ReactNode;
  /** after the field (send last); under it, at the right, while the text spans the pill */
  trailing?: ReactNode;
  look?: ComposerLook;
  inputRef?: Ref<TextAreaDomRef>;
}) {
  const pill = useRef<HTMLDivElement>(null);
  const field = useRef<TextAreaDomRef | null>(null);
  const lead = useRef<HTMLDivElement>(null);
  const trail = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  // Would the text fit on one row beside the buttons? Asked of the one-row slot's width whichever
  // layout is drawn, so switching layouts never changes the answer (no flip-flop at the edge).
  const measure = () => {
    const p = pill.current, f = field.current, inner = f?.shadowRoot?.querySelector("textarea");
    if (!p || !f || !inner) return;
    if (value.includes("\n")) return setWide(true);
    const ps = getComputedStyle(p), is = getComputedStyle(inner);
    const gap = parseFloat(ps.columnGap) || 0;
    const content = (el: HTMLElement, s: CSSStyleDeclaration) => el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    // What the field draws around its text (padding, edges): the same in either layout.
    const chrome = f.offsetWidth - content(inner, is);
    const slot = content(p, ps) - (lead.current?.offsetWidth ?? 0) - (trail.current?.offsetWidth ?? 0) - 2 * gap - chrome;
    setWide(textWidth(value, is) > slot - 2);
  };
  const latest = useRef(measure);
  latest.current = measure;
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => latest.current());
    if (pill.current) ro.observe(pill.current);
    if (field.current) ro.observe(field.current);
    return () => ro.disconnect();
  }, []);

  const setField = (el: TextAreaDomRef | null) => {
    field.current = el;
    if (typeof inputRef === "function") inputRef(el);
    else if (inputRef) inputRef.current = el;
  };
  const row: CSSProperties = { display: "flex", alignItems: "flex-end", gap: "0.25rem" };
  return (
    <div ref={pill} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{
        display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", alignItems: "end", columnGap: "0.25rem", rowGap: "0.125rem",
        gridTemplateAreas: wide ? '"primary primary primary" "leading . trailing"' : '"leading primary trailing"',
        // 3 px round 36 px buttons and a 1 px edge: a 44 px pill, its radius half that.
        padding: "0.1875rem", borderRadius: "1.375rem",
        border: `1px solid ${look.border ?? "var(--sapGroup_ContentBorderColor)"}`,
        background: look.background ?? "var(--sapField_Background)",
        boxShadow: (hovered && look.hoverShadow) || look.shadow || "none",
        outline: focused ? `0.125rem solid ${look.focus ?? "var(--sapContent_FocusColor)"}` : "none",
      }}>
      <div ref={lead} style={{ ...row, gridArea: "leading" }}>{leading}</div>
      <TextArea ref={setField} growing growingMaxRows={8} rows={1} value={value} maxlength={maxlength}
        style={{ ...BARE_FIELD, gridArea: "primary" }} disabled={disabled} readonly={readonly}
        placeholder={placeholder} accessibleName={accessibleName ?? placeholder}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onInput={(e) => onInput(e.target.value ?? "")}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onSend(); } }} />
      <div ref={trail} style={{ ...row, gridArea: "trailing" }}>{trailing}</div>
    </div>
  );
}

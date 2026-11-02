import { useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import {
  Input, List, ResponsivePopover, SuggestionItem, SuggestionItemCustom, TextArea, type TextAreaDomRef,
} from "@ui5/webcomponents-react";
import generateHighlightedMarkup from "@ui5/webcomponents-base/dist/util/generateHighlightedMarkup.js";
import { DslError, parse, type Issue, type ModelDef } from "@confire/config-engine";
import { useI18n } from "../../i18n.ts";
import { ExprHelp } from "./ExprGuide.tsx";
import { complete, issueText, matches, scopeSuggestions, trailingIdent, type Suggestion, type TableCols } from "./exprHelpers.ts";

// The one expression editor used everywhere in the builder: monospace, parse-on-change with
// span-accurate messages, trailing-token suggestions in the Input's native popup, and the
// expression guide on the help icon inside the field. Each suggestion's text is the *completed* expression,
// so picking one just fires onInput with it.

// Monospace inside the shadow DOM via the exposed `input`/`textarea` CSS parts.
if (typeof document !== "undefined") {
  const el = document.getElementById("confire-expr-style") ?? document.createElement("style");
  el.id = "confire-expr-style";
  el.textContent = `.confire-expr::part(input),.confire-expr::part(textarea){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}`
    // TextArea has no icon slot, so the help icon is overlaid and the text stops short of it.
    + `.confire-expr-help::part(textarea){padding-inline-end:2rem;}`
    + `.confire-expr-help-anchor{position:absolute;inset-inline-end:.35rem;inset-block-start:.35rem;z-index:1;line-height:0;}`
    // Input's own suggestions popover rules (Suggestions.css), which live in its shadow root.
    + `.confire-expr-pop{box-shadow:var(--sapContent_Shadow1);}.confire-expr-pop::part(header),.confire-expr-pop::part(content){padding:0;}`;
  if (!el.parentNode) document.head.appendChild(el);
}

export function ExprInput({
  value,
  onChange,
  model,
  extraVars,
  tables,
  placeholder,
  optional = false,
  issue,
  fieldId,
  rows,
  style,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  model: ModelDef;
  extraVars?: string[];
  tables?: TableCols[];
  placeholder?: string;
  /** empty input -> undefined (for condition/when/default fields) */
  optional?: boolean;
  /** checkModel's issue for this field, or its message (the record's), shown when the text parses */
  issue?: Issue | string;
  /** DOM id (MessageView jump target) */
  fieldId?: string;
  /** render as a growing TextArea of this many rows instead of a one-line Input */
  rows?: number;
  style?: CSSProperties;
}) {
  const i18n = useI18n();
  const text = value ?? "";
  const all = useMemo(
    () => scopeSuggestions(model, extraVars, tables, (key, ...params) => i18n.getText(key, ...params)),
    [model, extraVars, tables, i18n],
  );

  const parseError = useMemo(() => {
    if (text.trim() === "") return null; // emptiness is the caller's concern (optional/required)
    try {
      parse(text);
      return null;
    } catch (e) {
      return e instanceof DslError ? e : null;
    }
  }, [text]);
  const error = parseError ?? issue ?? null;
  const errorText = !error ? "" : typeof error === "string" ? error
    : issueText(error, text, (key, ...params) => i18n.getText(key, ...params));

  const sugg = matches(all, text).slice(0, 8);
  const emit = (v: string | undefined) => onChange(!v && optional ? undefined : (v ?? ""));

  // TextArea has no suggestion slot (SuggestionItem is Input's alone), so the multi-line box
  // rebuilds Input's own popup (InputSuggestionsTemplate): the same popover, list and items,
  // driven from the text's keys while the focus stays in it. -1 = nothing highlighted yet.
  const area = useRef<TextAreaDomRef>(null);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = open && sugg.length > 0;
  const at = Math.min(active, sugg.length - 1);
  const width = area.current?.offsetWidth ?? 0;
  const pick = (s: Suggestion) => {
    emit(complete(text, s));
    setOpen(false);
    area.current?.focus();
  };

  // One element: FormItem gives every direct child its own slot. The help icon is inside
  // the field — Input's icon slot, or overlaid on a TextArea, which has no such slot.
  const field = (icon: ReactElement) => rows ? (
      <>
        <TextArea
          ref={area}
          id={fieldId}
          className="confire-expr confire-expr-help"
          style={{ width: "100%", ...style }}
          rows={rows}
          growing
          growingMaxRows={rows + 5}
          value={text}
          placeholder={placeholder}
          // Not while the list is open: the half-typed token is "unknown" by definition, and the
          // message's popup would sit over the list (Input hides it the same way).
          valueState={error && !shown ? "Negative" : "None"}
          valueStateMessage={<div>{errorText}</div>}
          onInput={(e) => {
            // Escape reverts the whole edit unless its input event is cancelled: with the list
            // open, Escape only means "close the list". A keystroke's detail is null, typings aside.
            // The list itself is closed by UI5's popup registry, which shuts the topmost popup on
            // the same keydown (onClose below): closing it here first hands that Escape on to
            // whatever is under it — a Dialog round the box closed too.
            if (e.detail?.escapePressed && shown) { e.preventDefault(); return; }
            const v = e.target.value;
            // Completion replaces the trailing token, so it is only offered with the caret at the end.
            // ponytail: caret-aware completion mid-formula needs the caret restored after the write.
            const caret = e.target.shadowRoot?.querySelector("textarea")?.selectionEnd;
            setOpen(caret === undefined || caret === v.length);
            setActive(-1);
            emit(v);
          }}
          onKeyDown={(e) => {
            if (!shown) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive(e.key === "ArrowDown" ? Math.min(at + 1, sugg.length - 1) : Math.max(at - 1, -1));
            } else if (e.key === "Enter") {
              // Nothing highlighted: Enter is a new line, as it would be without the list.
              if (at >= 0) { e.preventDefault(); pick(sugg[at]!); } else setOpen(false);
            } else if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Tab"].includes(e.key)) {
              setOpen(false);
            }
          }}
          onClick={() => setOpen(false)}
          data-expr-input
        />
        <span className="confire-expr-help-anchor">{icon}</span>
        <ResponsivePopover className="confire-expr-pop" open={shown} opener={area.current} placement="Bottom"
          horizontalAlign="Start" hideArrow preventInitialFocus preventFocusRestore tabIndex={-1}
          style={{ minWidth: width || undefined, maxWidth: `max(40rem, ${width}px)` }}
          onClose={() => setOpen(false)}>
          {/* Mouse-down kept from moving the focus, as Input's list does, so the caret stays put. */}
          <List accessibleRole="ListBox" separators="None" selectionMode="Single"
            onMouseDown={(e) => e.preventDefault()}>
            {sugg.map((s, i) => (
              // `selected`/`focused`/`markupText` are the item state Input sets itself (the
              // highlight, the keyboard focus ring, the typed part in bold); the wrapper passes them on.
              <SuggestionItem key={s.text} text={s.text} additionalText={s.label} onClick={() => pick(s)}
                {...{
                  selected: i === at, focused: i === at,
                  markupText: generateHighlightedMarkup(s.text, trailingIdent(text)),
                }} />
            ))}
          </List>
        </ResponsivePopover>
      </>
  ) : (
    <Input
      id={fieldId}
      style={{ width: "100%", ...style }}
      className="confire-expr" // fontFamily via CSS part
      icon={icon}
      value={text}
      placeholder={placeholder}
      // Not while a completion is on offer: valueState Negative is drawn as that popover's
      // header, so the unfinished-token message sits over the list (the TextArea drops it too).
      valueState={error && !(focused && sugg.length > 0) ? "Negative" : "None"}
      valueStateMessage={<div>{errorText}</div>}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      showSuggestions
      filter="None"
      noTypeahead // items carry the whole completed expression; autocompleting it while typing fights the caret
      onInput={(e) => emit(e.target.value)}
      // UI5 fires `change` (not `input`) when a suggestion is accepted — without this the
      // picked completion lands in the DOM only and state keeps the typed fragment.
      onChange={(e) => emit(e.target.value)}
      data-expr-input
    >
      {sugg.map((s) => (
        // text drives autocomplete/insertion (the full completed expression, preserving
        // mid-expression completion); children render key + label only.
        // ponytail: secondary blank for non-param kinds; functions still identify by the inserted "(".
        <SuggestionItemCustom key={s.text} text={complete(text, s)}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", width: "100%" }}>
            <span>{s.text}</span>
            <span style={{ color: "var(--sapContent_LabelColor)" }}>{s.label ?? ""}</span>
          </div>
        </SuggestionItemCustom>
      ))}
    </Input>
  );
  return <ExprHelp>{field}</ExprHelp>;
}

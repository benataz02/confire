import { useEffect, useRef, useState } from "react";
import {
  Bar, Button, MessageItem, MessageView, MessageViewButton, ResponsivePopover, type ButtonDomRef,
} from "@ui5/webcomponents-react";
import { useUiI18n } from "./i18n.ts";

/** One row in a page's message popover. */
export type PageMessage = {
  /** react key — stable across renders so the open list doesn't rebuild under the user */
  id: string;
  type: "Negative" | "Critical" | "Information" | "Positive";
  /** the message itself, one line */
  text: string;
  /** what it is about: the field, or the action that failed */
  detail?: string;
  /** group header — the title of the ObjectPageSection the message belongs to */
  group: string;
  /** id of the ObjectPageSection to open on click */
  section?: string;
  /** CSS selector of the control to scroll to and focus once that section has rendered */
  anchor?: string;
};

// The button reflects the highest severity on the page (the Fiori rule for MessageViewButton), and
// the same order picks which type the counter counts.
const SEVERITY = ["Negative", "Critical", "Information", "Positive"] as const;

// An anchor points either at a UI5 control (an ExprInput's id, a tree row) or at a plain wrapper
// around one (a form field's `data-field`), so dive into a wrapper and take whatever field it holds.
const FIELD = "ui5-input,ui5-textarea,ui5-select,ui5-combobox,ui5-multi-combobox,ui5-multi-input,ui5-step-input,"
  + "ui5-date-picker,ui5-checkbox,ui5-radio-button,ui5-switch,ui5-slider";

/** Scroll to and focus a control the section switch has not rendered yet — in IconTabBar mode the
 *  target only exists a frame or two after `selectedSectionId` changes.
 *  ponytail: a fixed frame budget, not a MutationObserver. An anchor that never appears (a field
 *  that only exists inside a dialog) simply leaves the user on the right section, which is the point. */
function focusWhenReady(selector: string, tries = 30) {
  const host = document.querySelector<HTMLElement>(selector);
  if (!host) {
    if (tries > 0) requestAnimationFrame(() => focusWhenReady(selector, tries - 1));
    return;
  }
  host.scrollIntoView({ block: "center" });
  (host.localName.startsWith("ui5-") ? host : (host.querySelector<HTMLElement>(FIELD) ?? host)).focus();
}

/** Negative messages under a section, for its anchor or tab (the Fiori anchor-bar counter). */
export const negativeCount = (messages: PageMessage[], section: string) =>
  messages.filter((m) => m.section === section && m.type === "Negative").length;

/**
 * How many actions came back refused, counted off signals: each time one turns into a new truthy
 * value (a new error object, a new failure key) the count goes up. What it starts with does not
 * count — loading a page is not an action. Hand the count to {@link PageMessages}' `openOn`.
 */
export function useRefusals(...signals: unknown[]): number {
  const prev = useRef(signals);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const fresh = signals.filter((s, i) => s && !Object.is(s, prev.current[i])).length;
    prev.current = signals;
    if (fresh) setCount((n) => n + fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, signals);
  return count;
}

/**
 * The page's whole message state as one title action: severity and count on the button, the list
 * grouped by ObjectPageSection in the popover, and a click that lands on the offending field.
 *
 * Opens itself only when `openOn` goes up (an action came back refused) and there is a Negative
 * message to show — never while typing, never for warnings.
 */
export function PageMessages({ messages, okText, onSection, openOn }: {
  messages: PageMessage[];
  /** what the popover says when there is nothing wrong */
  okText?: string;
  onSection: (id: string) => void;
  /** refused actions so far ({@link useRefusals}, or the record's `refused`) */
  openOn?: number;
}) {
  const i18n = useUiI18n();
  const button = useRef<ButtonDomRef>(null);
  const [open, setOpen] = useState(false);
  const worst = SEVERITY.find((t) => messages.some((m) => m.type === t)) ?? "Positive";
  const counter = messages.filter((m) => m.type === worst).length;
  const ok = okText ?? i18n.getText("UI_NO_ISSUES");

  const seen = useRef(openOn);
  useEffect(() => {
    if (openOn === seen.current) return;
    seen.current = openOn;
    if (messages.some((m) => m.type === "Negative")) setOpen(true);
  }, [openOn, messages]);

  const go = (m: PageMessage) => {
    setOpen(false);
    if (m.section) onSection(m.section);
    if (m.anchor) focusWhenReady(m.anchor);
  };

  return (
    <>
      <MessageViewButton ref={button} type={worst} counter={counter}
        accessibilityAttributes={{ hasPopup: "dialog", expanded: open ? "true" : "false" }}
        tooltip={messages.length
          ? i18n.getText(messages.length === 1 ? "UI_MSG_COUNT_ONE" : "UI_MSG_COUNT_MANY", String(messages.length))
          : ok}
        onClick={() => setOpen(true)} />
      <ResponsivePopover className="confire-msgpop" headerText={i18n.getText("UI_MESSAGES")} opener={button.current ?? undefined}
        open={open && !!button.current} onClose={() => setOpen(false)}
        footer={
          <Bar design="Footer"
            endContent={<Button design="Transparent" onClick={() => setOpen(false)}>{i18n.getText("UI_CLOSE")}</Button>} />
        }>
        {/* MessageView lays its two panes out at height:100%, so the popover cannot size itself to
            the list. A grouped row with a subtitle is ~4rem; the cap keeps a long list on screen.
            ponytail: one row per message with a cap; tune the 4rem if the rows grow. */}
        <MessageView groupItems showDetailsPageHeader={false}
          style={{ width: "26rem", height: `${Math.min(4 + messages.length * 4, 42)}rem` }}>
          {messages.length === 0 ? (
            <MessageItem type="Positive" titleText={ok} />
          ) : (
            messages.map((m) => (
              // The details body is the only thing that makes a row clickable — MessageItem
              // ignores a click on an item that has none. Nobody reads it: the click closes the
              // popover in the same batch that opens the details page.
              <MessageItem key={m.id} type={m.type} groupName={m.group} titleText={m.text}
                subtitleText={m.detail} onClick={() => go(m)}>
                {m.detail ?? m.text}
              </MessageItem>
            ))
          )}
        </MessageView>
      </ResponsivePopover>
    </>
  );
}

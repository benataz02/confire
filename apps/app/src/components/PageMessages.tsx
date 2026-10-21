import { useState } from "react";
import { Bar, Button, MessageItem, MessageView, MessageViewButton, ResponsivePopover } from "@ui5/webcomponents-react";

/** One row in a page's message popover. */
export type PageMessage = {
  /** react key — stable across renders so the open list doesn't rebuild under the user */
  id: string;
  type: "Negative" | "Critical" | "Information" | "Positive";
  /** the message itself, one line */
  text: string;
  /** what it is about: the field path, or the action that failed */
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
// around one, so dive into a wrapper and take whatever field it holds.
const FIELD = "ui5-input,ui5-textarea,ui5-select,ui5-combobox,ui5-multi-combobox,ui5-step-input,ui5-checkbox,ui5-radio-button";

/** Scroll to and focus a control the section switch has not rendered yet — in IconTabBar mode the
 *  target only exists a frame or two after `selectedSectionId` changes.
 *  ponytail: a fixed frame budget, not a MutationObserver. An anchor that never appears (a field
 *  that only exists inside a dialog) simply leaves the user on the right tab, which is the point. */
function focusWhenReady(selector: string, tries = 30) {
  const host = document.querySelector<HTMLElement>(selector);
  if (!host) {
    if (tries > 0) requestAnimationFrame(() => focusWhenReady(selector, tries - 1));
    return;
  }
  host.scrollIntoView({ block: "center" });
  (host.localName.startsWith("ui5-") ? host : (host.querySelector<HTMLElement>(FIELD) ?? host)).focus();
}

/**
 * The page's whole message state as one title action: severity and count on the button, the list
 * grouped by ObjectPageSection in the popover, and a click that lands on the offending field.
 *
 * Drop it into an `ObjectPageTitle` `actionsBar` and hand `onSection` the section setter
 * (`useSectionParam`'s), so the jump is a URL the user can share and go Back out of.
 */
export function PageMessages({ messages, okText, onSection }: {
  messages: PageMessage[];
  /** what the popover says when there is nothing wrong */
  okText: string;
  onSection: (id: string) => void;
}) {
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const worst = SEVERITY.find((t) => messages.some((m) => m.type === t)) ?? "Positive";
  const counter = messages.filter((m) => m.type === worst).length;

  const go = (m: PageMessage) => {
    setOpen(false);
    if (m.section) onSection(m.section);
    if (m.anchor) focusWhenReady(m.anchor);
  };

  return (
    <>
      <MessageViewButton type={worst} counter={counter}
        tooltip={messages.length ? `${messages.length} message${messages.length === 1 ? "" : "s"}` : okText}
        onClick={(e) => { setOpener(e.currentTarget); setOpen(true); }} />
      <ResponsivePopover className="confire-msgpop" headerText="Messages" opener={opener} open={open}
        onClose={() => setOpen(false)}
        footer={
          <Bar design="Footer"
            endContent={<Button design="Transparent" onClick={() => setOpen(false)}>Close</Button>} />
        }>
        {/* MessageView lays its two panes out at height:100%, so the popover cannot size itself to
            the list. ponytail: one row per message with a cap; tune the 3rem if the rows grow. */}
        <MessageView groupItems showDetailsPageHeader={false}
          style={{ width: "26rem", height: `${Math.min(3 + messages.length * 3, 27)}rem` }}>
          {messages.length === 0 ? (
            <MessageItem type="Positive" titleText={okText} />
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

import { createElement as h } from "react";
import { Bar, Button, Label, Modals, MessageBoxAction, Text, TextArea } from "@ui5/webcomponents-react";

// Promise-returning confirm built on Modals.showMessageBox — no host component or context needed,
// but <Modals /> must be rendered once in the tree (see main.tsx). Resolves true when the user
// picks the confirm action, false on Cancel/Escape.
export function confirm({
  title,
  message,
  actionText = "OK",
  destructive = false,
}: {
  title?: string;
  message: string;
  /** label of the confirming button, e.g. "Delete" */
  actionText?: string;
  /** show the warning highlight (destructive/irreversible actions) */
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    Modals.showMessageBox({
      type: destructive ? "Warning" : "Confirm",
      titleText: title,
      children: message,
      actions: [actionText, MessageBoxAction.Cancel],
      emphasizedAction: actionText,
      onClose: (action) => resolve(action === actionText),
    });
  });
}

/** confirm() with a note: the reason a decision carries onto the project timeline ("Send back",
 *  "Decline"). Resolves the trimmed note ("" when left empty), or null on Cancel/Escape. Same host
 *  as confirm — a .ts module, so the dialog is built with createElement rather than JSX. */
export function promptNote({ title, message, actionText, label = "Note (optional)" }: {
  title: string;
  message: string;
  actionText: string;
  label?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    let note = "";
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const id = `note-${Math.random().toString(36).slice(2)}`;
    const dialog = Modals.showDialog({
      headerText: title,
      style: { width: "min(32rem, 90vw)" },
      onClose: () => finish(null),
      children: h("div", { style: { display: "flex", flexDirection: "column", gap: "0.5rem" } },
        h(Text, null, message),
        h(Label, { for: id, style: { marginTop: "0.5rem" } }, label),
        h(TextArea, {
          id, rows: 4, maxlength: 2000, growing: true, style: { width: "100%" },
          onInput: (e: { target: { value?: string } }) => { note = e.target.value ?? ""; },
        })),
      footer: h(Bar, {
        design: "Footer",
        endContent: [
          h(Button, { key: "ok", design: "Emphasized", onClick: () => { finish(note.trim()); dialog.close(); } }, actionText),
          h(Button, { key: "cancel", design: "Transparent", onClick: () => { finish(null); dialog.close(); } }, "Cancel"),
        ],
      }),
    });
  });
}

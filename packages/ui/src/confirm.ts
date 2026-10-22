import { createElement as h } from "react";
import { getI18nBundle } from "@ui5/webcomponents-base/dist/i18nBundle.js";
import { Bar, Button, Label, Modals, MessageBoxAction, Text, TextArea } from "@ui5/webcomponents-react";

// Promise-returning confirm built on Modals.showMessageBox — no host component or context needed,
// but <Modals /> must be rendered once in the tree (see main.tsx). Resolves true when the user
// picks the confirm action, false on Cancel/Escape. A caller-supplied actionText stays as given;
// the default "OK" is translated here. MessageBoxAction.Cancel is UI5's own action, so UI5
// localises Cancel.
export async function confirm({
  title,
  message,
  actionText,
  destructive = false,
}: {
  title?: string;
  message: string;
  /** label of the confirming button, e.g. "Delete". Omit for the translated OK. */
  actionText?: string;
  /** show the warning highlight (destructive/irreversible actions) */
  destructive?: boolean;
}): Promise<boolean> {
  const label = actionText ?? (await getI18nBundle("@confire/ui")).getText("UI_OK");
  return new Promise((resolve) => {
    Modals.showMessageBox({
      type: destructive ? "Warning" : "Confirm",
      titleText: title,
      children: message,
      actions: [label, MessageBoxAction.Cancel],
      emphasizedAction: label,
      onClose: (action) => resolve(action === label),
    });
  });
}

/** confirm() with a note: the reason a decision carries onto the project timeline ("Send back",
 *  "Decline"). Resolves the trimmed note ("" when left empty), or null on Cancel/Escape. Same host
 *  as confirm — a .ts module, so the dialog is built with createElement rather than JSX. */
export async function promptNote({ title, message, actionText, label }: {
  title: string;
  message: string;
  actionText: string;
  /** omit for the translated "Note (optional)" */
  label?: string;
}): Promise<string | null> {
  const i18n = await getI18nBundle("@confire/ui");
  const noteLabel = label ?? i18n.getText("UI_NOTE_OPTIONAL");
  const cancel = i18n.getText("UI_CANCEL");
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
        h(Label, { for: id, style: { marginTop: "0.5rem" } }, noteLabel),
        h(TextArea, {
          id, rows: 4, maxlength: 2000, growing: true, style: { width: "100%" },
          onInput: (e: { target: { value?: string } }) => { note = e.target.value ?? ""; },
        })),
      footer: h(Bar, {
        design: "Footer",
        endContent: [
          h(Button, { key: "ok", design: "Emphasized", onClick: () => { finish(note.trim()); dialog.close(); } }, actionText),
          h(Button, { key: "cancel", design: "Transparent", onClick: () => { finish(null); dialog.close(); } }, cancel),
        ],
      }),
    });
  });
}

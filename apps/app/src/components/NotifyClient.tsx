import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckBox } from "@ui5/webcomponents-react";
import { orpc } from "../orpc.ts";
import { useI18n } from "../i18n.ts";

const SALES_DOCUMENTS = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

/**
 * The create pages' "Notify the client" (document-mail spec §5.3), for ObjectPage's `createControls`:
 * drawn only for a sales document while the workspace has a mailbox connected, starting at the type's
 * default from Settings → Email. `notify` is undefined while nothing is drawn — the server never
 * defaults it on, so a page without the box sends nothing.
 */
export function useNotifyClient(entity: string) {
  const i18n = useI18n();
  const sales = SALES_DOCUMENTS.has(entity);
  const status = useQuery({ ...orpc.documentMail.status.queryOptions(), enabled: sales });
  const [picked, setPicked] = useState<boolean>();
  const s = status.data;
  if (!sales || !s?.connected) return { control: undefined, notify: undefined };
  const on = picked ?? s.defaults[entity as keyof typeof s.defaults];
  return {
    notify: on,
    control: <CheckBox text={i18n.getText("NOTIFY_CLIENT")} checked={on} onChange={(e) => setPicked(e.target.checked)} />,
  };
}

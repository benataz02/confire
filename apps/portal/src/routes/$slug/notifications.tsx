import { createFileRoute } from "@tanstack/react-router";
import { NotificationSettings } from "@confire/ui/notifications/Notifications.tsx";
import { notifications } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";

// Every seat's own switches (notifications spec §10), viewers included: each project event on the
// bell and by mail.
export const Route = createFileRoute("/$slug/notifications")({ component: Notifications });

function Notifications() {
  const i18n = useI18n();
  return <NotificationSettings api={notifications} getText={i18n.getText.bind(i18n)} intro={i18n.getText("NOTIF_PAGE_INTRO")} />;
}

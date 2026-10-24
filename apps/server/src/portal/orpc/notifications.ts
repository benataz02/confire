import { portalMemberProcedure } from "./base.ts";
import {
  dismiss, DismissZ, listNotifications, markRead, MarkReadZ, preferences, PreferenceZ, setPreference, unreadCount,
} from "../../notifications.ts";

// The portal's bell and Notifications page (notifications spec §9): the staff router's twin, for a
// seat. notifications.ts fences every call on (the path's supplier, the session's user).

export const notificationsRouter = {
  unreadCount: portalMemberProcedure.handler(({ context }) => unreadCount(context.tenantId, context.user.id)),
  list: portalMemberProcedure.handler(({ context }) => listNotifications(context.tenantId, context.user.id)),
  markRead: portalMemberProcedure.input(MarkReadZ).handler(({ input, context }) => markRead(context.tenantId, context.user.id, input.ids)),
  dismiss: portalMemberProcedure.input(DismissZ).handler(({ input, context }) => dismiss(context.tenantId, context.user.id, input.id)),
  settings: portalMemberProcedure.handler(({ context }) => preferences(context.tenantId, context.user.id, "client")),
  setPreference: portalMemberProcedure.input(PreferenceZ)
    .handler(({ input, context }) => setPreference(context.tenantId, context.user.id, "client", input)),
};

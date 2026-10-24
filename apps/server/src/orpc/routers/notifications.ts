import { userProcedure } from "../base.ts";
import {
  dismiss, DismissZ, listNotifications, markRead, MarkReadZ, preferences, PreferenceZ, setPreference, unreadCount,
} from "../../notifications.ts";

// The staff app's bell and Notifications page (notifications spec §9). Each one a thin wrapper:
// notifications.ts fences every call on (tenant, user); the portal's twin is portal/orpc/notifications.ts.

export const notificationsRouter = {
  unreadCount: userProcedure.handler(({ context }) => unreadCount(context.tenantId, context.userId)),
  list: userProcedure.handler(({ context }) => listNotifications(context.tenantId, context.userId)),
  markRead: userProcedure.input(MarkReadZ).handler(({ input, context }) => markRead(context.tenantId, context.userId, input.ids)),
  dismiss: userProcedure.input(DismissZ).handler(({ input, context }) => dismiss(context.tenantId, context.userId, input.id)),
  settings: userProcedure.handler(({ context }) => preferences(context.tenantId, context.userId, "staff")),
  setPreference: userProcedure.input(PreferenceZ)
    .handler(({ input, context }) => setPreference(context.tenantId, context.userId, "staff", input)),
};

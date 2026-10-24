// The notifications components' data source (Notifications.tsx), kept free of UI5 so each app's
// orpc.ts can build it without loading a web component at import time.

type Params = Record<string, string | number | null>;
export type NotificationItem = { id: string; type: string; params: Params; path: string; createdAt: Date; read: boolean };
export type NotificationSetting = { id: string; group: string; bell: boolean; mail: boolean };
export type Preference = { type: string; channel: "bell" | "mail"; enabled: boolean };
export type NotificationsApi = {
  unreadCount: () => Promise<{ count: number }>;
  list: () => Promise<NotificationItem[]>;
  markRead: (input: { ids?: string[] }) => Promise<unknown>;
  dismiss: (input: { id: string }) => Promise<unknown>;
  settings: () => Promise<NotificationSetting[]>;
  setPreference: (input: Preference) => Promise<unknown>;
};

/** `client.notifications` as plain functions — what each app hands Notifications.tsx. An oRPC
 *  client is a Proxy where any property is a procedure: passed as a prop as it is, React's dev
 *  tooling reads its `.name` and coerces it to a string, and every coercion is a request. */
export const notificationsApi = (c: NotificationsApi): NotificationsApi => ({
  unreadCount: () => c.unreadCount(),
  list: () => c.list(),
  markRead: (input) => c.markRead(input),
  dismiss: (input) => c.dismiss(input),
  settings: () => c.settings(),
  setPreference: (input) => c.setPreference(input),
});

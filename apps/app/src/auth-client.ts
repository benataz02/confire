import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

// baseURL defaults to the current origin; auth lives at /api/auth (proxied in dev).
export const authClient = createAuthClient({ plugins: [organizationClient()] });

export type Session = Awaited<ReturnType<typeof authClient.getSession>>["data"];

/** The one session query. Spread it into ensureQueryData/useQuery/fetchQuery — never re-declare it.
 *  disableCookieCache: login's beforeLoad must see a deleted/expired row, not a 5-minute snapshot,
 *  or a 401 interceptor sending us here would bounce straight back to the tenant. */
export const sessionQuery = {
  queryKey: ["session"] as const,
  queryFn: async (): Promise<Session> =>
    (await authClient.getSession({ query: { disableCookieCache: true } })).data ?? null,
  staleTime: 5 * 60_000,
};

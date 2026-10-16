import { createAuthClient } from "better-auth/react";

// The portal's own Better Auth instance (apps/server/src/portal/auth.ts) at /api/auth on this
// origin — proxied to the portal process in dev. No organization plugin: companies are Confire's.
export const authClient = createAuthClient();

export type Session = Awaited<ReturnType<typeof authClient.getSession>>["data"];

/** The one session query (see apps/web/src/auth-client.ts for why the cookie cache is skipped). */
export const sessionQuery = {
  queryKey: ["session"] as const,
  queryFn: async (): Promise<Session> =>
    (await authClient.getSession({ query: { disableCookieCache: true } })).data ?? null,
  staleTime: 5 * 60_000,
};

/** The captcha plugin reads the Turnstile token from this header on sign-up, sign-in and the reset
 *  request. A token is single-use: the page resets the widget after every attempt. */
export const captcha = (token: string) => ({ headers: { "x-captcha-response": token } });

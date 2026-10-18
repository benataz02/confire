import { useQuery } from "@tanstack/react-query";
import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@confire/server/router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { hardRedirect, loginUrl } from "./lib/tenant.ts";

// Same-origin (dev proxy / prod static) → cookies ride along automatically. A function, so the
// module never touches `window` at import time: the pure helpers that sit next to a hook (views.ts,
// metadata.ts, the CFL modules) stay importable from `bun test`.
const link = new RPCLink({
  url: () => `${window.location.origin}/rpc`,
  interceptors: [
    onError((error) => {
      if ((error as { code?: string }).code === "UNAUTHORIZED") void hardRedirect(loginUrl());
    }),
  ],
});
export const client: RouterClient<AppRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

/**
 * Identity on the current tenant subdomain: session + membership + role in one call.
 * `_authed`'s beforeLoad primes it and re-runs on every navigation, so it is cached for the
 * page session — see the note there about why the role is deliberately not revalidated.
 */
export const meQuery = orpc.me.queryOptions({ staleTime: Infinity });

/**
 * The sign-in dispatcher's answer: the user's workspace (null = no company yet; does it still need an
 * agent?) and every supplier portal they have a seat at, each with its URL. Uncached on purpose — a
 * company, an agent row or a seat can appear between visits, and a cached answer would send the user
 * back to a step they already finished.
 */
export const lobbyQuery = orpc.sap.lobby.queryOptions({ staleTime: 0, retry: false });

/**
 * The tenant's B1 local currency, for every money figure in the app. It rides on `me` rather than
 * having a query of its own because B1 gives no way to change a company's local currency once the
 * database exists — so the right staleTime is the Infinity `meQuery` already has, and the right
 * number of fetches is the zero extra this costs.
 *
 * undefined = SAP has never been reachable for this tenant. money() then renders a bare number.
 */
export function useCurrency(): string | undefined {
  return useQuery(meQuery).data?.currency ?? undefined;
}

/** admin/owner: who may open the /b1 pages and the model builder. Hides links only — `_authed`
 *  and the server enforce it. */
export function useIsAdmin(): boolean {
  const role = useQuery(meQuery).data?.role;
  return role === "admin" || role === "owner";
}

export type RouterOutputs = {
  dashboard: { overview: Awaited<ReturnType<typeof client.dashboard.overview>> };
};

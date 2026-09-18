import { useQuery } from "@tanstack/react-query";
import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@confire/server/router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { apexUrl, hardRedirect } from "./lib/tenant.ts";

// Same-origin (dev proxy / prod static) → cookies ride along automatically.
const link = new RPCLink({
  url: `${window.location.origin}/rpc`,
  interceptors: [
    onError((error) => {
      if ((error as { code?: string }).code !== "UNAUTHORIZED") return;
      const q = new URLSearchParams({ redirect: window.location.href });
      void hardRedirect(apexUrl(`/login?${q}`));
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

export type RouterOutputs = {
  dashboard: { overview: Awaited<ReturnType<typeof client.dashboard.overview>> };
};

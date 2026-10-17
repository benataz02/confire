import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { PortalRouter } from "@confire/server/portal-router";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { hardRedirect, loginUrl } from "./lib/host.ts";

// Same-origin (dev proxy / prod static) → the session cookie rides along. A function, so
// the module never touches `window` at import time.
const link = new RPCLink({
  url: () => `${window.location.origin}/rpc`,
  interceptors: [
    onError((error) => {
      if ((error as { code?: string }).code === "UNAUTHORIZED") void hardRedirect(loginUrl());
    }),
  ],
});
export const client: RouterClient<PortalRouter> = createORPCClient(link);
export const orpc = createTanstackQueryUtils(client);

/** Who am I on this supplier's portal — primed by `_authed`'s beforeLoad, cached for the page
 *  session like the internal app's `me`. The server re-checks on every procedure regardless. */
export const meQuery = orpc.me.queryOptions({ staleTime: Infinity, retry: false });

/** Every supplier this user has a seat at — the shell's "Switch supplier". Uncached: a seat can
 *  appear between two visits. */
export const lobbyQuery = orpc.lobby.queryOptions({ staleTime: 0, retry: false });

export type Me = Awaited<ReturnType<typeof client.me>>;

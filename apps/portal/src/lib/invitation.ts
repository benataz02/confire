import type { QueryClient } from "@tanstack/react-query";
import { meQuery } from "../orpc.ts";
import { authUrl, hardRedirect, loginUrl } from "@confire/ui/host.ts";

/** beforeLoad of the two invitation pages (spec §5.2, §5.3): the link and the new-client form. Not
 *  under `_authed` — the invitee has no seat yet. Signed out, it goes to the sign-in host (login or
 *  sign-up), which comes back to the link; the supplier's own staff go to its workspace. */
export async function invitationGuard({ context }: { context: { queryClient: QueryClient } }) {
  const me = await context.queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
    const code = (e as { code?: string }).code;
    if (code === "UNAUTHORIZED") return loginUrl();
    if (code === "NOT_FOUND") return authUrl("/login");
    throw e;
  });
  if (typeof me === "string") return hardRedirect(me);
  if (me.internal) return hardRedirect(me.internalAppUrl!);
  return { me };
}

import type { QueryClient } from "@tanstack/react-query";
import { authClient } from "../auth-client.ts";
import { client, meQuery } from "../orpc.ts";
import { authUrl, hardRedirect, loginUrl } from "@confire/ui/host.ts";

/** beforeLoad of the two invitation pages (spec §5.2, §5.3): the link and the new-client form. Not
 *  under `_authed` — the invitee has no seat yet. Signed out, it goes to the sign-in host — sign-up
 *  when the invited address has no account yet, else sign-in — which comes back to the link; the
 *  supplier's own staff go to its workspace. */
export async function invitationGuard({ context, params }: { context: { queryClient: QueryClient }; params: { invitationId: string } }) {
  // Asked before `me`: its UNAUTHORIZED would reach the oRPC link's interceptor, which sends
  // everyone to plain sign-in.
  const { data: session } = await authClient.getSession();
  if (!session) return hardRedirect(await inviteeSignIn(params.invitationId));
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

/** Sign-up or sign-in with the invited address filled in, then back to this link. An invitation the
 *  server no longer calls open gets plain sign-in: the page says why once signed in. */
async function inviteeSignIn(id: string) {
  const invitee = await client.onboarding.invitee({ id }).catch(() => null);
  const q = new URLSearchParams({ redirect: window.location.href });
  if (invitee) q.set("email", invitee.email);
  return authUrl(`/${invitee?.hasAccount === false ? "signup" : "login"}?${q}`);
}

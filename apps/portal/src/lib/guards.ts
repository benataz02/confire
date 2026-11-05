import type { QueryClient } from "@tanstack/react-query";
import { ORPCError } from "@orpc/client";
import { authClient } from "../auth-client.ts";
import { client, meQuery } from "../orpc.ts";
import { authUrl, guardRedirect, isSlug, loginUrl } from "@confire/ui/host.ts";

/** The part of every portal page's beforeLoad that comes before the seat: a real supplier slug, signed
 *  in, not its staff. `$slug` adds the seat; the `$slug_.*` pages before a seat call this directly.
 *  UX only — the server re-checks every procedure. */
export async function portalMe(queryClient: QueryClient, slug: string, preload: boolean) {
  // A reserved name is never a supplier (and the oRPC link sends no x-tenant for one).
  if (!isSlug(slug)) return guardRedirect(authUrl("/login"), preload);
  const me = await queryClient.ensureQueryData(meQuery).catch((e: unknown) => {
    const code = e instanceof ORPCError ? e.code : undefined;
    if (code === "UNAUTHORIZED") return loginUrl();
    if (code === "NOT_FOUND") return authUrl("/login"); // no such supplier: the user's own places
    throw e;
  });
  if (typeof me === "string") return guardRedirect(me, preload);
  // The supplier's own staff belong in its workspace (staff and customer are exclusive, spec D3).
  if (me.internal) return guardRedirect(me.internalAppUrl!, preload);
  return me;
}

/** beforeLoad of the two invitation pages (spec §5.2, §5.3): the link and the new-client form.
 *  Signed out, it goes to the sign-in host — sign-up when the invited address has no account yet,
 *  else sign-in — which comes back to the link. */
export async function invitationGuard({ context, params, preload }: { context: { queryClient: QueryClient }; params: { slug: string; invitationId: string }; preload: boolean }) {
  // Asked before `me`: its UNAUTHORIZED would reach the oRPC link's interceptor, which sends
  // everyone to plain sign-in.
  const { data: session } = await authClient.getSession();
  if (!session) return guardRedirect(await inviteeSignIn(params.invitationId), preload);
  return { me: await portalMe(context.queryClient, params.slug, preload) };
}

/** Sign-up or sign-in with the invited address filled in, then back to this link. An invitation the
 *  server no longer calls open gets plain sign-in: the page says why once signed in. */
async function inviteeSignIn(id: string) {
  const invitee = await client.onboarding.invitee({ id }).catch(() => null);
  const q = new URLSearchParams({ redirect: window.location.href });
  if (invitee) q.set("email", invitee.email);
  return authUrl(`/${invitee?.hasAccount === false ? "signup" : "login"}?${q}`);
}

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AuthLayout, revealDelay as delay } from "@confire/ui/auth/AuthLayout.tsx";
import { SocialButtons } from "@confire/ui/auth/SocialButtons.tsx";
import { authClient } from "../auth-client.ts";
import { orpc } from "../orpc.ts";
import { authSearch, safeRedirect } from "../lib/host.ts";

/** The portal's split screen. With `slug` (the page's `?t=`, or the host's supplier) the brand panel
 *  wears that supplier's name and logo — display only, nothing trusts it; without one, Confire's. */
export function PortalAuthLayout({ slug, children }: { slug?: string | null; children: ReactNode }) {
  const brand = useQuery({
    ...orpc.branding.queryOptions({ input: { slug: slug ?? "" } }),
    enabled: !!slug,
    staleTime: Infinity,
  });
  // While a supplier's name loads, show nothing rather than flash Confire's.
  const name = slug ? (brand.data?.name ?? "") : "Confire";
  return (
    <AuthLayout
      brand={
        <>
          {brand.data?.logo ? <img className="auth-brand__logo reveal" style={delay(0)} src={brand.data.logo} alt="" /> : null}
          <h1 className={`auth-brand__mark reveal${slug ? " auth-brand__mark--name" : ""}`} style={delay(0)}>{name}</h1>
          <p className="auth-brand__tagline reveal" style={delay(90)}>
            Customer portal<br />
            <em>Requests, quotes and documents in one place.</em>
          </p>
          {slug ? <p className="auth-brand__foot reveal" style={delay(260)}>Powered by Confire</p> : null}
        </>
      }
    >
      {children}
    </AuthLayout>
  );
}

/** Google / Microsoft on the portal apex. Success goes where a password sign-in would (`redirect`,
 *  else the lobby); a failure back to login as ?error=, keeping the supplier's branding. */
export function PortalSocialButtons({ redirect, t }: { redirect?: string; t?: string }) {
  return (
    <SocialButtons
      signIn={(provider) => void authClient.signIn.social({
        provider,
        callbackURL: safeRedirect(redirect) ?? "/",
        errorCallbackURL: `/login${authSearch(redirect, t)}`,
      })}
    />
  );
}

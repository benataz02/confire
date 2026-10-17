import type { ReactNode } from "react";
import { AuthLayout, revealDelay as delay } from "@confire/ui/auth/AuthLayout.tsx";

/** The portal's split screen for the pages a user sees before they have a seat (an invitation, the
 *  invite-only page). It wears the supplier of this host — the tenant `me` resolved from it. */
export function PortalAuthLayout({ tenant, children }: { tenant: { name: string; logo: string | null }; children: ReactNode }) {
  return (
    <AuthLayout
      brand={
        <>
          {tenant.logo ? <img className="auth-brand__logo reveal" style={delay(0)} src={tenant.logo} alt="" /> : null}
          <h1 className="auth-brand__mark reveal auth-brand__mark--name" style={delay(0)}>{tenant.name}</h1>
          <p className="auth-brand__tagline reveal" style={delay(90)}>
            Customer portal<br />
            <em>Requests, quotes and documents in one place.</em>
          </p>
          <p className="auth-brand__foot reveal" style={delay(260)}>Powered by Confire</p>
        </>
      }
    >
      {children}
    </AuthLayout>
  );
}

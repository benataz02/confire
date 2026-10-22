import type { ReactNode } from "react";
import { AuthLayout, revealDelay as delay } from "@confire/ui/auth/AuthLayout.tsx";
import { useI18n } from "../i18n.ts";

/** The portal's split screen for the pages a user sees before they have a seat (an invitation, the
 *  invite-only page). It wears the supplier in the path — the tenant `me` resolved from it. */
export function PortalAuthLayout({ tenant, children }: { tenant: { name: string; logo: string | null }; children: ReactNode }) {
  const i18n = useI18n();
  return (
    <AuthLayout
      brand={
        <>
          {tenant.logo ? <img className="auth-brand__logo reveal" style={delay(0)} src={tenant.logo} alt="" /> : null}
          <h1 className="auth-brand__mark reveal auth-brand__mark--name" style={delay(0)}>{tenant.name}</h1>
          <p className="auth-brand__tagline reveal" style={delay(90)}>
            {i18n.getText("PORTAL_AUTH_TAGLINE")}<br />
            <em>{i18n.getText("PORTAL_AUTH_TAGLINE_SUB")}</em>
          </p>
          <p className="auth-brand__foot reveal" style={delay(260)}>{i18n.getText("PORTAL_AUTH_POWERED")}</p>
        </>
      }
    >
      {children}
    </AuthLayout>
  );
}

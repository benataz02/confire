import type { ReactNode } from "react";
import { MessageStrip } from "@ui5/webcomponents-react";
import { AuthCard, AuthHead, AuthLayout, AuthTile, initials } from "@confire/ui/auth/AuthLayout.tsx";
import { siteUrl } from "@confire/ui/host.ts";
import { useLanguage, useUiI18n } from "@confire/ui/i18n.ts";
import { useI18n } from "../i18n.ts";

type Tenant = { name: string; logo: string | null };

/** The portal's frame for the pages a user sees before they have a seat (an invitation, the
 *  invite-only page). It wears the supplier in the path — the tenant `me` resolved from it — and
 *  Confire only in the footer. */
export function PortalAuthLayout({ tenant, children }: { tenant: Tenant; children: ReactNode }) {
  const i18n = useI18n();
  const ui = useUiI18n();
  const { language } = useLanguage();
  return (
    <AuthLayout
      brand={
        <span className="auth-brand">
          {tenant.logo ? <img src={tenant.logo} alt="" /> : <span className="auth-avatar" aria-hidden="true">{initials(tenant.name)}</span>}
          <span>{tenant.name}</span>
        </span>
      }
      foot={
        <>
          <span className="auth-powered"><img src="/confire-logo.png" alt="" />{i18n.getText("PORTAL_AUTH_POWERED")}</span>
          <a href={siteUrl("/privacy/", language)}>{ui.getText("UI_AUTH_PRIVACY")}</a>
        </>
      }
    >
      {children}
    </AuthLayout>
  );
}

/** Signed in with the wrong address: out, and back to the same link with another one. */
export function SignedInAs({ email, onOtherAccount }: { email: string; onOtherAccount: () => void }) {
  const i18n = useI18n();
  return (
    <p className="auth-alt">
      {i18n.getText("PORTAL_SIGNED_IN_AS", email)}{" "}
      <a href="#" onClick={(e) => { e.preventDefault(); onOtherAccount(); }}>{i18n.getText("PORTAL_OTHER_ACCOUNT")}</a>
    </p>
  );
}

/** An invitation the server refused: why, then the way on — the portal for someone already seated
 *  (`goPortal`), else a new invitation. The accept page and the new-client form both end here. */
export function InvitationUnusable({ tenant, message, email, onOtherAccount, goPortal }: {
  tenant: Tenant;
  message: string;
  email: string;
  onOtherAccount: () => void;
  goPortal?: () => void;
}) {
  const i18n = useI18n();
  return (
    <PortalAuthLayout tenant={tenant}>
      <AuthHead title={i18n.getText("PORTAL_INVITE_UNUSABLE")} />
      <AuthCard center>
        <AuthTile icon="message-error" tone="negative" />
        <MessageStrip design="Negative" hideCloseButton>{message}</MessageStrip>
        {goPortal ? (
          <button type="button" className="auth-btn auth-btn--em" onClick={goPortal}>{i18n.getText("PORTAL_INVITE_GO_PORTAL", tenant.name)}</button>
        ) : (
          <p className="auth-body">{i18n.getText("PORTAL_INVITE_ASK_NEW", tenant.name)}</p>
        )}
      </AuthCard>
      <SignedInAs email={email} onOtherAccount={onOtherAccount} />
    </PortalAuthLayout>
  );
}

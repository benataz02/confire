import { Action, Fine, H1, Layout, P, type Brand } from "./layout.tsx";
import type { Mail } from "./mailer.ts";

// Customer portal mail (spec §12). One typed props object per template (spec §17).

export type InvitationProps = {
  /** the supplier: its name and logo, the portal's own branding (D20) */
  brand: Brand;
  inviterName: string;
  /** the customer company the invitee joins (the B1 business partner's name); null for a new
   *  client, who tells the supplier about their company first (spec §5.3) */
  companyName: string | null;
  url: string;
  expiresAt: Date;
};

export function PortalInvitation({ brand, inviterName, companyName, url, expiresAt }: InvitationProps) {
  const until = expiresAt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return (
    <Layout brand={brand} preview={`${inviterName} invited you to ${brand.name}'s customer portal`}>
      {companyName ? (
        <>
          <H1>Join {companyName} on {brand.name}'s portal</H1>
          <P>{inviterName} invited you to {brand.name}'s customer portal, as part of {companyName}.</P>
        </>
      ) : (
        <>
          <H1>Set up your company on {brand.name}'s portal</H1>
          <P>{inviterName} invited you to {brand.name}'s customer portal. Tell them about your company — name, address and contact — and your account is ready.</P>
        </>
      )}
      <P>There you can request quotes and follow your orders, deliveries and invoices with {brand.name}.</P>
      <Action brand={brand} href={url}>{companyName ? "Accept the invitation" : "Set up your company"}</Action>
      <Fine>Or open this link: {url}</Fine>
      <Fine>The invitation is valid until {until}. Sign in or create an account with this email address to accept it. If you weren't expecting it, you can ignore this email.</Fine>
    </Layout>
  );
}

/** The invitation as a Mail: from the supplier's name, replies to whoever sent it. The key makes a
 *  retried send the original send. */
export const invitationMail = (p: InvitationProps & { id: string; to: string; inviterEmail: string }): Mail => ({
  to: p.to,
  subject: `${p.inviterName} invited you to ${p.brand.name}'s customer portal`,
  fromName: p.brand.name,
  // ponytail: the inviter until P7's portal_settings.replyTo (the tenant's sales address, D13).
  replyTo: p.inviterEmail,
  idempotencyKey: `invite/${p.id}`,
  body: <PortalInvitation brand={p.brand} inviterName={p.inviterName} companyName={p.companyName} url={p.url} expiresAt={p.expiresAt} />,
});

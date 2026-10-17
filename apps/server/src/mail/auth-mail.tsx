import { Action, CONFIRE, Fine, H1, Layout, P, type Brand } from "./layout.tsx";
import { sendMailInBackground } from "./mailer.ts";

// Account mail (spec §12 "fixed", not configurable): verification and password reset. One typed
// props object per template (spec §17), so a future designer can list exactly these variables.

export type AuthMailProps = { brand: Brand; name: string; url: string };

export function VerifyEmail({ brand, name, url }: AuthMailProps) {
  return (
    <Layout brand={brand} preview={`Confirm your email address for ${brand.name}`}>
      <H1>Confirm your email address</H1>
      <P>Hi {name},</P>
      <P>Confirm that this is your email address to finish setting up your {brand.name} account.</P>
      <Action brand={brand} href={url}>Confirm email address</Action>
      <Fine>Or open this link: {url}</Fine>
      <Fine>If you didn't create an account, you can ignore this email.</Fine>
    </Layout>
  );
}

export function ResetPassword({ brand, name, url }: AuthMailProps) {
  return (
    <Layout brand={brand} preview={`Reset your ${brand.name} password`}>
      <H1>Reset your password</H1>
      <P>Hi {name},</P>
      <P>Someone asked to reset the password for your account. The link works once, for one hour.</P>
      <Action brand={brand} href={url}>Choose a new password</Action>
      <Fine>Or open this link: {url}</Fine>
      <Fine>If it wasn't you, ignore this email: your password stays as it is.</Fine>
    </Layout>
  );
}

type User = { name: string; email: string };

/**
 * The two Better Auth senders, always in Confire's colours: the sign-in host serves every tenant, so
 * there is no supplier to brand them with. Both return at once: a send is never awaited by the
 * endpoint, so the response time of sign-up or reset-request cannot tell anyone whether an address
 * has an account.
 */
export function authMail() {
  const send = (subject: string, Template: typeof VerifyEmail) => async ({ user, url }: { user: User; url: string }) => {
    sendMailInBackground({ to: user.email, subject, fromName: CONFIRE.name, body: <Template brand={CONFIRE} name={user.name} url={url} /> });
  };
  return {
    sendVerificationEmail: send("Verify your email address", VerifyEmail),
    sendResetPassword: send("Reset your password", ResetPassword),
  };
}

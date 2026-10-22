import { getI18nBundle } from "@ui5/webcomponents-base/dist/i18nBundle.js";

// Failures that come back to a login page as ?error=<code>: social sign-in (its errorCallbackURL) and
// a verification link (sign-up's callbackURL; Better Auth appends the code). account_not_linked is the
// social one people hit: a password account already owns the email, and Better Auth won't attach a
// provider to one whose owner never confirmed the address. Don't "fix" that: it's what stops someone
// pre-registering a colleague's address and inheriting their Google login.
//
// Not a component, so the bundle is fetched here rather than through useUiI18n. The app registers
// `@confire/ui` before any route module loads, so this wait resolves against that loader.
const i18n = await getI18nBundle("@confire/ui");

export const authErrorMessage = (code: string) =>
  code === "account_not_linked"
    ? i18n.getText("UI_AUTH_LINKED")
    : code === "TOKEN_EXPIRED" || code === "INVALID_TOKEN"
      ? i18n.getText("UI_AUTH_EXPIRED")
      : code === "INVALID_USER" || code === "USER_NOT_FOUND"
        ? i18n.getText("UI_AUTH_OTHER")
        : i18n.getText("UI_AUTH_INCOMPLETE", code);

/** Sign-in refused EMAIL_NOT_VERIFIED: Better Auth has just mailed a fresh link (sendOnSignIn). */
export const notVerifiedMessage = (email: string) => i18n.getText("UI_AUTH_VERIFY", email);

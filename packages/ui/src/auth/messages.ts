// Failures that come back to a login page as ?error=<code>: social sign-in (its errorCallbackURL) and
// a verification link (sign-up's callbackURL; Better Auth appends the code). account_not_linked is the
// social one people hit: a password account already owns the email, and Better Auth won't attach a
// provider to one whose owner never confirmed the address. Don't "fix" that: it's what stops someone
// pre-registering a colleague's address and inheriting their Google login.
export const authErrorMessage = (code: string) =>
  code === "account_not_linked"
    ? "This email already has a password account. Sign in with your password."
    : code === "TOKEN_EXPIRED" || code === "INVALID_TOKEN"
      ? "That confirmation link has expired or was already used. Sign in to get a new one."
      : code === "INVALID_USER" || code === "USER_NOT_FOUND"
        ? "That confirmation link belongs to a different account."
        : `Sign-in didn't complete (${code}).`;

/** Sign-in refused EMAIL_NOT_VERIFIED: Better Auth has just mailed a fresh link (sendOnSignIn). */
export const notVerifiedMessage = (email: string) =>
  `Confirm your email address first. We've sent a new link to ${email}.`;

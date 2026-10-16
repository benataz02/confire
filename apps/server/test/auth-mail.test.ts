import { describe, expect, test } from "bun:test";
import { auth } from "../src/auth.ts";
import { devOutbox, formatFrom } from "../src/mail/mailer.ts";

// The internal instance requires a verified email (spec D13). No RESEND_API_KEY in tests, so every
// mail lands in the console mailer's outbox — which is what these read the links out of.

const uid = () => crypto.randomUUID().slice(0, 8);
const password = "test1234";

/** Sends are fire-and-forget (never on the request path), so a mail arrives a tick after the call. */
async function mailsTo(email: string, atLeast = 1) {
  for (let i = 0; i < 100; i++) {
    const found = devOutbox.filter((m) => m.to === email);
    if (found.length >= atLeast) return found;
    await Bun.sleep(20);
  }
  throw new Error(`no mail #${atLeast} to ${email}`);
}

async function signUp() {
  const email = `v${uid()}@test.local`;
  const res = await auth.api.signUpEmail({ body: { email, password, name: "Vera" } });
  return { email, res };
}

describe("internal email verification", () => {
  test("sign-up opens no session and mails a verification link", async () => {
    const { email, res } = await signUp();
    expect(res.token).toBeNull();
    const [mail] = await mailsTo(email);
    expect(mail!.subject).toBe("Verify your email address");
    expect(mail!.html).toContain("/api/auth/verify-email?token=");
    expect(mail!.text).toContain("/api/auth/verify-email?token=");
    expect(mail!.text).toContain("Vera");
  });

  test("an unverified sign-in is refused and mails a fresh link", async () => {
    const { email } = await signUp();
    await mailsTo(email);
    const err = await auth.api.signInEmail({ body: { email, password } }).catch((e: unknown) => e);
    expect((err as { body?: { code?: string } }).body?.code).toBe("EMAIL_NOT_VERIFIED");
    await mailsTo(email, 2);
  });

  test("a password reset request mails a reset link", async () => {
    const { email } = await signUp();
    await mailsTo(email);
    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } });
    const mails = await mailsTo(email, 2);
    expect(mails[1]!.subject).toBe("Reset your password");
    expect(mails[1]!.html).toContain("/api/auth/reset-password/");
  });
});

describe("formatFrom", () => {
  test("quotes the display name so commas, ampersands and quotes stay one name", () => {
    expect(formatFrom('Müller & "Söhne", GmbH', "notify@mail.example.com"))
      .toBe('"Müller & \\"Söhne\\", GmbH" <notify@mail.example.com>');
  });
});

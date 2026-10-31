import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { demoRoutes } from "../src/demo-request.ts";
import { devOutbox, type Mail, type SendResult } from "../src/mail/mailer.ts";

// The marketing site's demo form (spec 2026-10-30 §9). No RESEND_API_KEY in tests, so the default
// sender is the console mailer and the sent mail lands in devOutbox.

const FIELDS = { name: "Ana", email: " Ana@Firma.ES ", company: "Firma", setup: "SAP Business One + Beas", message: "Conveyors", lang: "es" };

function post(app: ReturnType<typeof demoRoutes>, fields: Record<string, string>, ip = "203.0.113.7",
  referer = "https://confire.ai/es/?utm_source=linkedin&utm_campaign=q4") {
  return app.request("/api/demo-request", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": `${ip}, 10.0.0.1`, referer },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => { process.env.DEMO_INBOX = "owner@example.com"; });
afterEach(() => { delete process.env.DEMO_INBOX; });

test("a valid request mails the inbox and redirects to thanks", async () => {
  const res = await post(demoRoutes(), FIELDS);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/es/thanks/");
  const m = devOutbox.at(-1)!;
  expect(m.to).toBe("owner@example.com");
  expect(m.replyTo).toBe("Ana@Firma.ES");
  expect(m.from).toContain("notify@");
  expect(m.subject).toBe("Demo request: Firma (Ana)");
  expect(m.text).toContain("utm_source: linkedin");
  expect(m.text).toContain("utm_campaign: q4");
  expect(m.text).toContain("SAP Business One + Beas");
});

test("english has no prefix", async () => {
  const res = await post(demoRoutes(), { ...FIELDS, lang: "en" });
  expect(res.headers.get("location")).toBe("/thanks/");
});

test("an unknown lang is english", async () => {
  const res = await post(demoRoutes(), { ...FIELDS, lang: "fr" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/thanks/");
});

test("the honeypot answers thanks and sends nothing", async () => {
  const before = devOutbox.length;
  const res = await post(demoRoutes(), { ...FIELDS, lang: "en", website: "x" });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/thanks/");
  expect(devOutbox.length).toBe(before);
});

test("an invalid address is refused", async () => {
  const app = demoRoutes();
  const before = devOutbox.length;
  for (const email of ["nope", ""]) {
    const res = await post(app, { ...FIELDS, lang: "en", email });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/demo-error/");
  }
  expect(devOutbox.length).toBe(before);
});

test("the sixth request in an hour from one IP is refused", async () => {
  const app = demoRoutes();
  const en = { ...FIELDS, lang: "en" };
  for (let i = 0; i < 5; i++) expect((await post(app, en, "198.51.100.1")).headers.get("location")).toBe("/thanks/");
  expect((await post(app, en, "198.51.100.1")).headers.get("location")).toBe("/demo-error/");
  expect((await post(app, en, "198.51.100.2")).headers.get("location")).toBe("/thanks/");
});

test("a failed send is logged and shows the error page", async () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const send = async (_: Mail): Promise<SendResult> => ({ error: "boom" });
    const res = await post(demoRoutes({ send }), { ...FIELDS, lang: "eu" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/eu/demo-error/");
    expect(error.mock.calls.some((args) => args.join(" ").includes("Ana@Firma.ES") && args.join(" ").includes("boom"))).toBe(true);
  } finally {
    error.mockRestore();
  }
});

test("an unset DEMO_INBOX is a failed send", async () => {
  delete process.env.DEMO_INBOX;
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const before = devOutbox.length;
    const res = await post(demoRoutes(), { ...FIELDS, lang: "en" });
    expect(res.headers.get("location")).toBe("/demo-error/");
    expect(devOutbox.length).toBe(before);
    expect(error.mock.calls.some((args) => args.join(" ").includes("DEMO_INBOX"))).toBe(true);
  } finally {
    error.mockRestore();
  }
});

test("an oversized body is refused before it is parsed, whatever its fields", async () => {
  const before = devOutbox.length;
  const res = await post(demoRoutes(), { ...FIELDS, lang: "en", padding: "x".repeat(200_000) });
  expect(res.headers.get("location")).toBe("/demo-error/");
  expect(devOutbox.length).toBe(before);
});

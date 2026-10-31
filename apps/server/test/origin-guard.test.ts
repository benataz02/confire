import { expect, test } from "bun:test";
import staff from "../src/index.ts";
import portal from "../src/portal/index.ts";
import { makeUser } from "./harness.ts";

// confire.ai (the marketing site, which runs ad scripts after consent) and app.confire.ai are the
// same site, so a SameSite=Lax session cookie rides along on a form POST from the apex (spec
// 2026-10-30 §11.4). serve() refuses a write whose Origin is not its own.

const FOREIGN = "http://localhost:4321";
const form = (origin?: string) => ({
  method: "POST",
  headers: { ...(origin ? { origin } : {}), "content-type": "application/x-www-form-urlencoded" },
  body: "",
});

test("a POST from another origin is refused", async () => {
  const res = await staff.fetch(new Request("http://localhost:3000/api/openapi/me", form(FOREIGN)));
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("Forbidden origin");
  const upload = await portal.fetch(new Request("http://localhost:3001/files/acme/logo", form(FOREIGN)));
  expect(upload.status).toBe(403);
});

test("same origin, no origin, and GET pass the guard", async () => {
  expect((await staff.fetch(new Request("http://localhost:3000/api/openapi/me", form("http://localhost:5173")))).status).not.toBe(403);
  expect((await staff.fetch(new Request("http://localhost:3000/api/openapi/me", form()))).status).not.toBe(403);
  const get = await staff.fetch(new Request("http://localhost:3000/api/openapi/spec.json", { headers: { origin: FOREIGN } }));
  expect(get.status).not.toBe(403);
  expect((await portal.fetch(new Request("http://localhost:3001/api/openapi/me", form("http://localhost:5180")))).status).not.toBe(403);
});

test("Better Auth and the demo form are left to their own checks", async () => {
  const signOut = await staff.fetch(new Request("http://localhost:3000/api/auth/sign-out", form(FOREIGN)));
  expect(await signOut.text()).not.toBe("Forbidden origin");
  const demo = await portal.fetch(new Request("http://localhost:3001/api/demo-request", { ...form(FOREIGN), body: "website=x" }));
  expect(demo.status).toBe(303);
});

test("the session cookie is HttpOnly", async () => {
  const { email } = await makeUser();
  const res = await staff.fetch(new Request("http://localhost:3000/api/auth/sign-in/email", {
    method: "POST",
    headers: { origin: "http://localhost:5173", "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test1234" }),
  }));
  expect(res.status).toBe(200);
  const session = res.headers.getSetCookie().filter((c) => c.includes("session_token"));
  expect(session.length).toBeGreaterThan(0);
  for (const c of session) expect(c.toLowerCase()).toContain("httponly");
});

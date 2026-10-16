import { expect, test } from "bun:test";
import { hosts, slugOf } from "./host.ts";

// Mirrors apps/server/src/tenant.ts (the server re-validates; this is UX and redirect safety).

test("slugOf: one label under the zone's base; apex, reserved, deeper and the sibling zone are not tenants", () => {
  expect(slugOf("acme.portal.lvh.me", "portal.lvh.me")).toBe("acme");
  expect(slugOf("ACME.Portal.lvh.me", "portal.lvh.me")).toBe("acme");
  expect(slugOf("portal.lvh.me", "portal.lvh.me")).toBeNull();
  expect(slugOf("www.portal.lvh.me", "portal.lvh.me")).toBeNull();
  expect(slugOf("a.b.portal.lvh.me", "portal.lvh.me")).toBeNull();
  expect(slugOf("acme.app.lvh.me", "portal.lvh.me")).toBeNull();
});

test("safeRedirect stays inside its own zone", () => {
  const { safeRedirect } = hosts("portal.lvh.me");
  expect(safeRedirect("http://acme.portal.lvh.me:5180/projects?x=1")).toBe("http://acme.portal.lvh.me:5180/projects?x=1");
  expect(safeRedirect("https://portal.lvh.me/")).toBe("https://portal.lvh.me/");
  expect(safeRedirect("http://acme.app.lvh.me:5173/")).toBeNull(); // the internal zone is another app
  expect(safeRedirect("https://evil.com/?portal.lvh.me")).toBeNull();
  expect(safeRedirect("https://portal.lvh.me.evil.com/")).toBeNull();
  expect(safeRedirect("javascript:alert(1)//portal.lvh.me")).toBeNull();
  expect(safeRedirect("/relative")).toBeNull();
  expect(safeRedirect(undefined)).toBeNull();
});

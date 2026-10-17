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

test("safeRedirect accepts the sign-in host and both zones under it, nothing else", () => {
  const { safeRedirect } = hosts("portal.lvh.me", "http://lvh.me:5173");
  expect(safeRedirect("http://acme.portal.lvh.me:5180/projects?x=1")).toBe("http://acme.portal.lvh.me:5180/projects?x=1");
  expect(safeRedirect("http://acme.app.lvh.me:5173/")).toBe("http://acme.app.lvh.me:5173/"); // the sign-in host sends to both
  expect(safeRedirect("http://lvh.me:5173/login")).toBe("http://lvh.me:5173/login");
  expect(safeRedirect("https://evil.com/?lvh.me")).toBeNull();
  expect(safeRedirect("https://lvh.me.evil.com/")).toBeNull();
  expect(safeRedirect("https://evillvh.me/")).toBeNull();
  expect(safeRedirect("javascript:alert(1)//lvh.me")).toBeNull();
  expect(safeRedirect("/relative")).toBeNull();
  expect(safeRedirect(undefined)).toBeNull();
});

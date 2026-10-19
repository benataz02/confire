import { expect, test } from "bun:test";
import { origins, safeRedirect, slugOf, tenantPath } from "./host.ts";

// Mirrors apps/server/src/tenant.ts (the server re-validates; this is UX and redirect safety).

test("slugOf: the first path segment, when it is one lowercase label and not an app page or route", () => {
  expect(slugOf("/acme")).toBe("acme");
  expect(slugOf("/acme/")).toBe("acme");
  expect(slugOf("/acme/projects/1")).toBe("acme");
  expect(slugOf("/")).toBeNull();
  expect(slugOf("")).toBeNull();
  expect(slugOf("/login")).toBeNull();
  expect(slugOf("/reset-password/x")).toBeNull();
  expect(slugOf("/files/acme/x")).toBeNull();
  expect(slugOf("/assets/index.js")).toBeNull();
  expect(slugOf("/confire-logo.png")).toBeNull();
  expect(slugOf("/ACME/")).toBeNull();
});

test("tenantPath: the path under the slug, `/` for the tenant's home", () => {
  expect(tenantPath("/acme")).toBe("/");
  expect(tenantPath("/acme/")).toBe("/");
  expect(tenantPath("/acme/configs/1")).toBe("/configs/1");
});

test("origins: app.<domain> and portal.<domain> from either one; any other host is dev's two ports", () => {
  const prod = { auth: "https://app.confire.ai", portal: "https://portal.confire.ai" };
  expect(origins({ protocol: "https:", hostname: "app.confire.ai" })).toEqual(prod);
  expect(origins({ protocol: "https:", hostname: "portal.confire.ai" })).toEqual(prod);
  expect(origins({ protocol: "http:", hostname: "localhost" })).toEqual({ auth: "http://localhost:5173", portal: "http://localhost:5180" });
});

test("safeRedirect accepts the sign-in host's and the portal's origins, nothing else", () => {
  const dev = { protocol: "http:", hostname: "localhost" };
  const ok = (url: string | undefined, loc = dev) => safeRedirect(url, loc);
  expect(ok("http://localhost:5180/acme/projects?x=1")).toBe("http://localhost:5180/acme/projects?x=1");
  expect(ok("http://localhost:5173/acme/")).toBe("http://localhost:5173/acme/");
  expect(ok("http://localhost:5174/acme/")).toBeNull(); // another port is another origin
  expect(ok("https://localhost:5173/")).toBeNull();
  expect(ok("https://evil.com/?localhost:5173")).toBeNull();
  expect(ok("http://localhost.evil.com:5173/")).toBeNull();
  expect(ok("javascript:alert(1)//localhost:5173")).toBeNull();
  expect(ok("/relative")).toBeNull();
  expect(ok(undefined)).toBeNull();

  const prod = { protocol: "https:", hostname: "app.confire.ai" };
  expect(ok("https://portal.confire.ai/acme/", prod)).toBe("https://portal.confire.ai/acme/");
  expect(ok("https://confire.ai/", prod)).toBeNull(); // the cookie's domain, but not an app
  expect(ok("https://x.confire.ai/", prod)).toBeNull();
});

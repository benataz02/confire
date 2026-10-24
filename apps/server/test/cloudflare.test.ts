import { afterEach, expect, test } from "bun:test";
import { agentHost, cloudflareConfig, provisionAgent, type CloudflareConfig } from "../src/cloudflare.ts";

// Provisioning against a stubbed Cloudflare API (spec 2026-10-21 §5, §10): the route exists before
// the name points at it, a retry reuses what a failed attempt left, and every other tunnel of the
// tenant is retired last — secret first, so its cloudflared cannot reconnect before the delete.

const c: CloudflareConfig = { token: "t", accountId: "acct", zoneId: "zone", agentDomain: "confire.app" };
const host = "abcde12345.confire.app";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Tunnel = { id: string; name: string; status: string };

/** A Cloudflare that holds `tunnels` and `records`, logging `METHOD path` per call. */
function stub(tunnels: Tunnel[], records: { id: string }[] = []) {
  const log: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    log.push(`${method} ${path}`);
    const ok = (result: unknown) => Response.json({ success: true, result });
    if (method === "GET" && path === "/accounts/acct/cfd_tunnel") {
      expect(url.searchParams.get("include_prefix")).toBe("confire-abcde12345-");
      return ok(tunnels);
    }
    if (method === "POST" && path === "/accounts/acct/cfd_tunnel") {
      const body = JSON.parse(String(init!.body)) as { name: string; config_src: string };
      expect(body.name.startsWith("confire-abcde12345-acme-")).toBe(true);
      expect(body.config_src).toBe("cloudflare");
      return ok({ id: "new", name: body.name, status: "inactive", token: "token-from-create" });
    }
    if (method === "PUT" && path.endsWith("/configurations")) {
      expect(JSON.parse(String(init!.body))).toEqual({
        config: { ingress: [{ hostname: host, service: "http://localhost:4000" }, { service: "http_status:404" }] },
      });
      return ok({});
    }
    if (method === "GET" && path === "/zones/zone/dns_records") return ok(records);
    if (path.startsWith("/zones/zone/dns_records")) {
      expect(JSON.parse(String(init!.body))).toMatchObject({ type: "CNAME", name: host, proxied: true });
      return ok({});
    }
    if (method === "GET" && path.endsWith("/token")) return ok("token-from-get");
    return ok({});
  }) as typeof fetch;
  return log;
}

test("first pairing: a tunnel, its route, then its name; nothing to retire", async () => {
  const log = stub([]);
  expect(await provisionAgent(c, { slug: "acme", host, port: 4000, oldTunnelId: null }))
    .toEqual({ agentUrl: `https://${host}`, tunnelId: "new", token: "token-from-create" });
  expect(log).toEqual([
    "GET /accounts/acct/cfd_tunnel",
    "POST /accounts/acct/cfd_tunnel",
    "PUT /accounts/acct/cfd_tunnel/new/configurations",
    "GET /zones/zone/dns_records",
    "POST /zones/zone/dns_records",
  ]);
});

test("re-pair: the name moves to the new tunnel, then the old one is retired, secret first", async () => {
  const log = stub([{ id: "old", name: "confire-abcde12345-acme-1", status: "healthy" }], [{ id: "rec" }]);
  const r = await provisionAgent(c, { slug: "acme", host, port: 4000, oldTunnelId: "old" });
  expect(r.tunnelId).toBe("new");
  expect(log.slice(2)).toEqual([
    "PUT /accounts/acct/cfd_tunnel/new/configurations",
    "GET /zones/zone/dns_records",
    "PUT /zones/zone/dns_records/rec",
    "PATCH /accounts/acct/cfd_tunnel/old",
    "DELETE /accounts/acct/cfd_tunnel/old/connections",
    "DELETE /accounts/acct/cfd_tunnel/old",
  ]);
});

test("a retry reuses the never-run tunnel a failed attempt left, and still retires the old box", async () => {
  const log = stub([
    { id: "old", name: "confire-abcde12345-acme-1", status: "healthy" },
    { id: "left", name: "confire-abcde12345-acme-2", status: "inactive" },
  ]);
  const r = await provisionAgent(c, { slug: "acme", host, port: 4000, oldTunnelId: "old" });
  expect(r).toEqual({ agentUrl: `https://${host}`, tunnelId: "left", token: "token-from-get" });
  expect(log.some((l) => l === "POST /accounts/acct/cfd_tunnel")).toBe(false);
  expect(log.filter((l) => l.startsWith("DELETE"))).toEqual([
    "DELETE /accounts/acct/cfd_tunnel/old/connections", "DELETE /accounts/acct/cfd_tunnel/old",
  ]);
  expect(log.at(-1)).toBe("GET /accounts/acct/cfd_tunnel/left/token");
});

test("a Cloudflare error stops the walk before anything is retired", async () => {
  stub([{ id: "old", name: "confire-abcde12345-acme-1", status: "healthy" }]);
  const stubbed = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).includes("dns_records") && init?.method === "POST"
      ? Response.json({ success: false, errors: [{ message: "quota" }] }, { status: 400 })
      : stubbed(input, init)) as typeof fetch;
  await expect(provisionAgent(c, { slug: "acme", host, port: 4000, oldTunnelId: "old" })).rejects.toThrow("quota");
});

test("the host label: kept once stored, otherwise the same for the same tenant", () => {
  expect(agentHost(c, "t1", `https://${host}`)).toBe(host);
  const derived = agentHost(c, "t1", "http://localhost:4000");
  expect(derived).toMatch(/^[a-z0-9]{10}\.confire\.app$/);
  expect(agentHost(c, "t1", null)).toBe(derived);
  expect(agentHost(c, "t2", null)).not.toBe(derived);
});

test("unset CF_API_TOKEN is dev; a half-configured one is refused", () => {
  expect(cloudflareConfig({})).toBeNull();
  expect(() => cloudflareConfig({ CF_API_TOKEN: "x" })).toThrow("CF_ACCOUNT_ID is required");
});

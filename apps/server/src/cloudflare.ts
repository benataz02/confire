import { createHmac, randomBytes } from "node:crypto";

// The Cloudflare half of pairing (spec 2026-10-21 §5): a tunnel, its route and its DNS name per
// tenant, created through the API so nobody opens the dashboard per customer. What guards those
// names is not created here: the one wildcard Access application on `*.<AGENT_DOMAIN>` exists before
// any hostname does, and CF_API_TOKEN has no Access permission — so this module, or whoever owns
// the server, cannot open a customer machine to the world (DEPLOY.md §8).
//
// Unset CF_API_TOKEN is dev, the same seam as mail: `cloudflareConfig()` is null and pairing answers
// with a localhost URL instead.

export type CloudflareConfig = { token: string; accountId: string; zoneId: string; agentDomain: string };

export function cloudflareConfig(env = process.env): CloudflareConfig | null {
  if (!env.CF_API_TOKEN) return null;
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required when CF_API_TOKEN is set (DEPLOY.md §8)`);
    return v;
  };
  return { token: env.CF_API_TOKEN, accountId: need("CF_ACCOUNT_ID"), zoneId: need("CF_ZONE_ID"), agentDomain: need("AGENT_DOMAIN") };
}

type Tunnel = { id: string; name: string; status: string; token?: string };

async function cf<T>(c: CloudflareConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !json?.success)
    throw new Error(`Cloudflare ${method} ${path.replace(/^\/(accounts|zones)\/[^/]+/, "")}: ${json?.errors?.map((e) => e.message).join("; ") || res.status}`);
  return json.result as T;
}

/** The tenant's own tunnels: every name starts `confire-<label>-`, and a label is fixed-length, so
 *  one tenant's prefix is never another's. */
const prefixOf = (host: string) => `confire-${host.split(".")[0]}-`;

/**
 * Make `host` reach `http://localhost:<port>` on the box that will run the returned token, and cut
 * every other box of this tenant off. Steps in this order, each safe to repeat:
 *  1. the tunnel — a fresh one, or one a failed attempt left behind that never connected — and its
 *     ingress (`host` → the agent, everything else 404);
 *  2. the proxied CNAME `host` → the tunnel, updated in place when it exists;
 *  3. every other tunnel of the tenant retired, `oldTunnelId` included: its secret rotated (so its
 *     cloudflared cannot reconnect), its connections dropped, the tunnel deleted. Last, so a failure
 *     before it leaves the old box serving and the code still valid for a retry.
 *  4. the token, which only the new box will hold.
 */
export async function provisionAgent(c: CloudflareConfig, o: { slug: string; host: string; port: number; oldTunnelId: string | null }) {
  const acct = `/accounts/${c.accountId}/cfd_tunnel`;
  const prefix = prefixOf(o.host);
  const mine = await cf<Tunnel[]>(c, "GET", `${acct}?is_deleted=false&per_page=100&include_prefix=${encodeURIComponent(prefix)}`);

  // A leftover of an attempt that failed after creating it: never run, not the current box's.
  const leftover = mine.find((t) => t.status === "inactive" && t.id !== o.oldTunnelId);
  const tunnel = leftover ?? await cf<Tunnel>(c, "POST", acct, {
    name: `${prefix}${o.slug}-${Date.now().toString(36)}`, config_src: "cloudflare",
  });
  await cf(c, "PUT", `${acct}/${tunnel.id}/configurations`, {
    config: { ingress: [{ hostname: o.host, service: `http://localhost:${o.port}` }, { service: "http_status:404" }] },
  });

  const zone = `/zones/${c.zoneId}/dns_records`;
  const record = { type: "CNAME", name: o.host, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, comment: `confire ${o.slug}` };
  const [existing] = await cf<{ id: string }[]>(c, "GET", `${zone}?type=CNAME&name.exact=${encodeURIComponent(o.host)}`);
  await (existing ? cf(c, "PUT", `${zone}/${existing.id}`, record) : cf(c, "POST", zone, record));

  const retire = new Set([...mine.map((t) => t.id), ...(o.oldTunnelId ? [o.oldTunnelId] : [])]);
  retire.delete(tunnel.id);
  for (const id of retire) await retireTunnel(c, id);

  const token = tunnel.token ?? await cf<string>(c, "GET", `${acct}/${tunnel.id}/token`);
  return { agentUrl: `https://${o.host}`, tunnelId: tunnel.id, token };
}

/** A tunnel nobody may use again. Deleting alone is not enough: Cloudflare refuses while a connection
 *  is up, and a running cloudflared reconnects in seconds — so its secret goes first. A tunnel that
 *  is already gone counts as retired. */
async function retireTunnel(c: CloudflareConfig, id: string) {
  const t = `/accounts/${c.accountId}/cfd_tunnel/${id}`;
  try {
    await cf(c, "PATCH", t, { tunnel_secret: randomBytes(32).toString("base64") });
  } catch (e) {
    if (/not found|does not exist/i.test(String(e))) return;
    throw e;
  }
  await cf(c, "DELETE", `${t}/connections`);
  await cf(c, "DELETE", t);
}

/** `<label>.<agentDomain>`: 10 lowercase letters and digits, opaque so DNS does not list the
 *  customers. Kept once stored (it is the agentUrl); before that, derived from the tenant id under
 *  the server's secret, so a first pairing that failed half-way retries under the same name and
 *  finds the tunnel it left behind. */
export function agentHost(c: CloudflareConfig, tenantId: string, currentUrl: string | null): string {
  const kept = currentUrl ? new URL(currentUrl).hostname : null;
  if (kept && kept.endsWith(`.${c.agentDomain}`) && /^[a-z0-9]{10}$/.test(kept.split(".")[0]!)) return kept;
  const mac = createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "").update(`agent-host:${tenantId}`).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `${[...mac.subarray(0, 10)].map((b) => alphabet[b % alphabet.length]).join("")}.${c.agentDomain}`;
}

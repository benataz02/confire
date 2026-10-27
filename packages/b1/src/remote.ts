import { B1Error } from "./errors.ts";
import type { B1Requester } from "./types.ts";

/** Everything needed to reach one tenant's agent. Shared by the transports and the non-transport
 *  routes (print, health), so the bearer/CF-Access/company/timeout handling exists exactly once. */
export type AgentTarget = {
  /** http://localhost:<port> in dev, https://<label>.<AGENT_DOMAIN> in production. A row in
   *  sap_connection — which is the whole reason the tunnel is deployment config and not code. */
  agentUrl: string;
  /** Bearer secret the agent checks on every request. */
  secret: string;
  /** Cloudflare Access service token — absent in dev, present in production. */
  accessClientId?: string | null;
  accessClientSecret?: string | null;
  /** The company this call is built against, sent as X-Confire-Company: an agent serving another one
   *  answers 409 COMPANY_CHANGED before it touches SAP. */
  companyDb?: string | null;
  /** Told the agent's company when it answered COMPANY_CHANGED, before the call fails. */
  onCompanyChanged?: (companyDb: string) => Promise<void>;
  /** Bound on the cloud -> agent hop, independent of the agent -> SL bound. */
  timeoutMs?: number;
};

export const COMPANY_CHANGED = "COMPANY_CHANGED";

/** Wire shape of the agent's reply. */
type WireError = { status: number; code: string | number | null; message: string; companyDb?: string; call?: string; body?: string };
type Wire = { error: WireError } | Record<string, unknown>;

/**
 * One call to the agent: a POST with `body`, a GET without (`/health`). `route` is the full agent
 * path — `/b1/request`, `/print`.
 *
 * Never throws a bare Error: an unreachable agent is a 503 B1Error so toOrpcError can tell it
 * apart from a SAP rejection.
 */
export async function agentPost(o: AgentTarget, route: string, body?: unknown): Promise<unknown> {
  // One server-log entry per call — `[agent] /beas/request GET https://sap:8080/beas/Items?$top=1 →
  // 200 84ms`, then SAP's whole answer on a failure — so what reached SAP, and what it said, is
  // readable without the agent's own log. That call is the agent's (it alone knows SAP's base, and a
  // failed login is a POST to Login, not the request); an older agent sends none, and the path
  // stands in. /health is polled during pairing, so it is logged only when it fails.
  const started = Date.now();
  const r = body as { method?: string; path?: string } | undefined;
  const log = (status: number | string, call?: string, error?: string) => {
    if (body === undefined && !error) return;
    const what = call ?? (r?.method ? `${r.method} ${r.path}` : body === undefined ? "" : JSON.stringify(body));
    console.log(`[agent] ${route} ${what} → ${status} ${Date.now() - started}ms${error ? `\n${error}` : ""}`);
  };
  let res: Response;
  try {
    res = await fetch(`${o.agentUrl.replace(/\/+$/, "")}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        Authorization: `Bearer ${o.secret}`,
        ...(o.companyDb ? { "X-Confire-Company": o.companyDb } : {}),
        ...(o.accessClientId && o.accessClientSecret
          ? { "CF-Access-Client-Id": o.accessClientId, "CF-Access-Client-Secret": o.accessClientSecret }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 70_000),
    });
  } catch (e) {
    // Unreachable agent, DNS, TLS, or our own timeout — never a B1 status.
    const msg = `Agent unreachable at ${o.agentUrl}: ${e instanceof Error ? e.message : String(e)}`;
    log("unreachable", undefined, msg);
    throw new B1Error(503, null, msg);
  }

  const text = await res.text();
  let wire: Wire | null = null;
  try { wire = text ? (JSON.parse(text) as Wire) : null; } catch { /* fall through */ }
  if (wire && "error" in wire) {
    const err = wire.error as WireError;
    log(err.status, err.call, err.body || err.message);
    if (err.code === COMPANY_CHANGED && err.companyDb) {
      await o.onCompanyChanged?.(err.companyDb);
      throw new B1Error(409, COMPANY_CHANGED, `SAP company changed to ${err.companyDb} — try again.`);
    }
    throw new B1Error(err.status, err.code, err.message);
  }
  if (!res.ok || !wire) {
    // Not the agent's answer — Cloudflare's or cloudflared's HTML page: its <title> says which.
    const msg = `Agent error ${res.status}: ${/<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? text.slice(0, 500)}`;
    log(res.status, undefined, text || msg);
    throw new B1Error(res.status, null, msg);
  }
  const ok = wire as { status?: number; call?: string };
  log(ok.status ?? res.status, ok.call);
  return wire;
}

/** The cloud's half of a Service Layer call: DirectTransport builds the path, the agent sends it. */
export const agentRequester = (o: AgentTarget, service: "b1" | "beas"): B1Requester =>
  async (r) => (await agentPost(o, `/${service}/request`, r)) as { status: number; data: unknown };

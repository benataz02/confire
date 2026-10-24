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
type WireError = { status: number; code: string | number | null; message: string; companyDb?: string };
type Wire = { error: WireError } | Record<string, unknown>;

/**
 * One call to the agent: a POST with `body`, a GET without (`/health`). `route` is the full agent
 * path — `/b1/request`, `/print`.
 *
 * Never throws a bare Error: an unreachable agent is a 503 B1Error so toOrpcError can tell it
 * apart from a SAP rejection.
 */
export async function agentPost(o: AgentTarget, route: string, body?: unknown): Promise<unknown> {
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
    throw new B1Error(503, null, `Agent unreachable at ${o.agentUrl}: ${e instanceof Error ? e.message : String(e)}`);
  }

  const text = await res.text();
  let wire: Wire | null = null;
  try { wire = text ? (JSON.parse(text) as Wire) : null; } catch { /* fall through */ }
  if (wire && "error" in wire) {
    const err = wire.error as WireError;
    if (err.code === COMPANY_CHANGED && err.companyDb) {
      await o.onCompanyChanged?.(err.companyDb);
      throw new B1Error(409, COMPANY_CHANGED, `SAP company changed to ${err.companyDb} — try again.`);
    }
    throw new B1Error(err.status, err.code, err.message);
  }
  if (!res.ok || !wire) throw new B1Error(res.status, null, `Agent error ${res.status}: ${text.slice(0, 500)}`);
  return wire;
}

/** The cloud's half of a Service Layer call: DirectTransport builds the path, the agent sends it. */
export const agentRequester = (o: AgentTarget, service: "b1" | "beas"): B1Requester =>
  async (r) => (await agentPost(o, `/${service}/request`, r)) as { status: number; data: unknown };

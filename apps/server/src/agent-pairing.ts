import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { and, eq, gt, like } from "drizzle-orm";
import { db, organization, sapConnection, verification } from "@confire/db";
import { agentPost } from "@confire/b1";
import { adoptCompany, agentTarget, tenantConnector } from "./b1.ts";
import { agentHost, cloudflareConfig, provisionAgent } from "./cloudflare.ts";
import { encryptSecret } from "./crypto.ts";
import { readCapped } from "./files.ts";
import { domainOf } from "./tenant.ts";

// Pairing (spec 2026-10-21 §4): Confire shows a one-time code, the Go agent on the SAP server
// redeems it for its secret and tunnel token. Nobody copies a secret, and the SAP credentials never
// leave the box — the agent sends its company's name and nothing else.

const CODE_TTL_MS = 60 * 60_000;
/** Crockford base32: no I, L, O or U, so nothing on the screen reads as something else. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX = "agent-pair:";

/** Crockford's decoding: any case, I and L read as 1, O as 0, hyphens and spaces ignored. */
export const normalizeCode = (raw: string) =>
  raw.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");

const codeKey = (code: string) => `${PREFIX}${createHash("sha256").update(normalizeCode(code)).digest("hex")}`;

/** A fresh code, `XXXX-XXXX`, valid an hour, in Better Auth's `verification` table (identifier =
 *  the code's hash, value = the tenant) — no table of its own. It replaces the tenant's earlier
 *  ones, so only the code on the screen works.
 *  ponytail: no rate limit on redeem. 40 bits against a handful of live codes is ~10¹¹ guesses on
 *  average; add a per-IP limit if codes ever live longer or get shorter. */
export async function issuePairingCode(tenantId: string) {
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await db.transaction(async (tx) => {
    await tx.delete(verification).where(and(like(verification.identifier, `${PREFIX}%`), eq(verification.value, tenantId)));
    await tx.insert(verification).values({ id: crypto.randomUUID(), identifier: codeKey(raw), value: tenantId, expiresAt });
  });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

export const PairBody = z.object({
  code: z.string().max(32),
  port: z.number().int().min(1).max(65535),
  version: z.string().max(64),
  companyDb: z.string().trim().min(1).max(100),
});

/** A refusal the agent shows its user as is. */
export class PairingError extends Error {
  constructor(readonly status: 400 | 404 | 503, message: string) {
    super(message);
  }
}

/**
 * Redeem a code: the tunnel (or, in dev, a localhost URL), a new agent secret, the row, the company.
 * The code is claimed by deleting it — two concurrent redeems cannot both get the row — and put back
 * if anything after that fails, so the agent can simply retry: provisioning is safe to repeat.
 * A re-pair replaces the secret and retires the old tunnel, so a forgotten old server stops serving.
 */
export async function redeemPairing(body: z.infer<typeof PairBody>) {
  const cf = cloudflareConfig();
  // DOMAIN without Cloudflare is a misconfigured deployment: never store a localhost URL there.
  if (!cf && domainOf(process.env.DOMAIN))
    throw new PairingError(503, "This Confire server cannot pair agents yet (CF_API_TOKEN is not set).");

  const [claimed] = await db.delete(verification).where(eq(verification.identifier, codeKey(body.code))).returning();
  if (!claimed || claimed.expiresAt < new Date())
    throw new PairingError(404, "This pairing code is wrong or has expired. Create a new one in Confire.");
  const tenantId = claimed.value;
  try {
    const [org] = await db.select({ slug: organization.slug }).from(organization).where(eq(organization.id, tenantId)).limit(1);
    if (!org) throw new PairingError(404, "This workspace no longer exists.");
    const [current] = await db.select({ agentUrl: sapConnection.agentUrl, tunnelId: sapConnection.tunnelId })
      .from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    const net = cf
      ? await provisionAgent(cf, {
        slug: org.slug, host: agentHost(cf, tenantId, current?.agentUrl ?? null), port: body.port,
        oldTunnelId: current?.tunnelId ?? null,
      })
      : { agentUrl: `http://localhost:${body.port}`, tunnelId: null, token: null };

    const secret = randomBytes(32).toString("base64url");
    const row = {
      tenantId, agentUrl: net.agentUrl, secret: encryptSecret(secret), tunnelId: net.tunnelId,
      status: "ok" as const, lastError: null,
    };
    await db.insert(sapConnection).values(row).onConflictDoUpdate({ target: sapConnection.tenantId, set: row });
    await adoptCompany(tenantId, body.companyDb);
    return { slug: org.slug, agentUrl: net.agentUrl, secret, tunnelToken: net.token };
  } catch (e) {
    await db.insert(verification).values(claimed).catch(() => {});
    throw e;
  }
}

// ---- The bundled build -------------------------------------------------------------------------
// CI builds the Windows exe into the image beside its VERSION (apps/server/Dockerfile); dev has
// neither, so the download is a 404 and nothing is ever "behind".

const DIST = new URL("../../agent/dist/", import.meta.url).pathname;

export const bundledAgentVersion: string | null = (() => {
  try { return readFileSync(`${DIST}VERSION`, "utf8").trim() || null; } catch { return null; }
})();

/** `a` is a later build than `b`. Versions are `YYYY.MM.DD.<CI run>`; `dev` is never behind. */
export function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) => (v && /^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

type Health = {
  ok: boolean; version: string; companyDb: string;
  services: { b1: boolean; beas: boolean; print: string[] };
};

/**
 * Is the agent there, and does SAP answer through it? `/health` first (version, company, what is
 * configured), then the CompanyService_GetAdminInfo read `tenantCurrency` makes, so green means B1
 * itself answered — and the local currency is filled while at it. The onboarding page polls this
 * instead of trusting that a row exists.
 */
export async function agentStatus(tenantId: string) {
  const [row] = await db.select({ lastOkAt: sapConnection.lastOkAt, companyDb: sapConnection.companyDb })
    .from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
  // A code on screen that no agent has redeemed yet: Settings watches it turn false.
  const [pending] = await db.select({ id: verification.id }).from(verification)
    .where(and(like(verification.identifier, `${PREFIX}%`), eq(verification.value, tenantId), gt(verification.expiresAt, new Date())))
    .limit(1);
  const base = {
    latestVersion: bundledAgentVersion, version: null as string | null, companyDb: row?.companyDb ?? null,
    services: null as Health["services"] | null, pairingPending: !!pending,
  };
  if (!row) return { ...base, paired: false, connected: false, updateAvailable: false, lastOkAt: null, error: null };

  let health: Health | null = null;
  try {
    health = (await agentPost(await agentTarget(tenantId), "/health")) as Health;
    if (health.companyDb) await adoptCompany(tenantId, health.companyDb);
    const { data } = await (await tenantConnector(tenantId)).b1.readEntitySet("CompanyService_GetAdminInfo");
    const cur = (data as { LocalCurrency?: unknown } | null)?.LocalCurrency;
    const lastOkAt = new Date();
    await db.update(sapConnection)
      .set({ status: "ok", lastOkAt, lastError: null, ...(typeof cur === "string" && cur ? { localCurrency: cur } : {}) })
      .where(eq(sapConnection.tenantId, tenantId));
    return {
      ...base, paired: true, connected: true, version: health.version, companyDb: health.companyDb, services: health.services,
      updateAvailable: isNewer(bundledAgentVersion, health.version), lastOkAt, error: null,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await db.update(sapConnection).set({ status: "error", lastError: error }).where(eq(sapConnection.tenantId, tenantId));
    return {
      ...base, paired: true, connected: false, version: health?.version ?? null, services: health?.services ?? null,
      updateAvailable: isNewer(bundledAgentVersion, health?.version), lastOkAt: row.lastOkAt, error,
    };
  }
}

/** The staff process's two routes for the agent. Plain Hono, like files.ts: the caller of `pair` is
 *  the Go agent, not a browser, and the code is its only credential; the download is a link and
 *  public (the exe holds no secret). */
export function agentRoutes(): Hono {
  const app = new Hono();

  app.post("/api/agent/pair", async (c) => {
    const raw = await readCapped(c.req.raw, 4096);
    let json: unknown = null;
    try { json = raw ? JSON.parse(raw.toString("utf8")) : null; } catch { /* refused below */ }
    const body = PairBody.safeParse(json);
    if (!body.success) return c.json({ message: "Not a pairing request." }, 400);
    try {
      return c.json(await redeemPairing(body.data));
    } catch (e) {
      if (e instanceof PairingError) return c.json({ message: e.message }, e.status);
      console.error("[agent pair]", e);
      Sentry.captureException(e);
      return c.json({ message: "Pairing failed on the Confire server. The code is still valid — try again in a minute." }, 500);
    }
  });

  app.get("/download/confire-agent.exe", async (c) => {
    const exe = Bun.file(`${DIST}confire-agent.exe`);
    if (!(await exe.exists())) return c.text("No agent build on this server.", 404);
    return new Response(exe, {
      headers: {
        "Content-Type": "application/vnd.microsoft.portable-executable",
        "Content-Disposition": `attachment; filename="confire-agent.exe"`,
        "Cache-Control": "no-cache",
      },
    });
  });

  return app;
}

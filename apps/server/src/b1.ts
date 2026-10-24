import { ORPCError } from "@orpc/server";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, configMasterdata, configMasterdataRow, configProject, entityMeta, sapConnection } from "@confire/db";
import {
  agentRequester, B1Error, COMPANY_CHANGED, DirectTransport, nextLinkOf, rowsOrThrow,
  type AgentTarget, type B1Transport, type Connector,
} from "@confire/b1";
import { decryptSecret } from "./crypto.ts";
import { forgetEntityList } from "./entity-meta.ts";
import { bumpMasterdata, DEFAULT_PAGE, type QueryRunner } from "./lookups.ts";

export const SAP_UNAVAILABLE =
  "No SAP agent is paired with this workspace yet. An admin pairs one in Settings → SAP agent.";

export type { Connector };

/** The tenant's agent, as plain config. One PK select — nothing here is worth caching. Printing
 *  needs this without a transport, so the row->config mapping lives here rather than inline.
 *
 *  The Access service token is one for every tenant (DEPLOY.md §8): the `*.<AGENT_DOMAIN>` Access
 *  application lets it through and nothing else. Unset in dev, where nothing stands in front. */
export async function agentTarget(tenantId: string): Promise<AgentTarget> {
  const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
  if (!row) throw new ORPCError("SERVICE_UNAVAILABLE", { message: SAP_UNAVAILABLE });
  return {
    agentUrl: row.agentUrl,
    secret: decryptSecret(row.secret),
    accessClientId: process.env.CF_ACCESS_CLIENT_ID || null,
    accessClientSecret: process.env.CF_ACCESS_CLIENT_SECRET || null,
    companyDb: row.companyDb,
    onCompanyChanged: async (companyDb) => { await adoptCompany(tenantId, companyDb); },
  };
}

/**
 * Follow a company switch made on the SAP server (spec 2026-10-21 §6.2): the agent is the authority
 * on which company it serves, and Confire adopts its answer — from a 409 COMPANY_CHANGED, a health
 * check or a pairing. Once, however many calls hit the 409 together: the `is distinct from` update
 * is what only one of them wins. The winner clears every cache of the old company's data, each of
 * which refills on its own: the local currency on the next `me`, entity schemas on the next read,
 * masterdata rows through their TTL (synced_at null = stale).
 *
 * Quotations posted before companies were recorded (dev only — spec A15) get the first company
 * adopted. `portal_settings.leadSeries` is a setting, not a cache: it names a series of the old
 * company and is left for an admin to re-pick.
 */
export async function adoptCompany(tenantId: string, companyDb: string): Promise<boolean> {
  const adopted = await db.transaction(async (tx) => {
    const [row] = await tx.update(sapConnection).set({ companyDb, localCurrency: null })
      .where(and(eq(sapConnection.tenantId, tenantId), sql`${sapConnection.companyDb} is distinct from ${companyDb}`))
      .returning({ tenantId: sapConnection.tenantId });
    if (!row) return false;
    await tx.update(configProject).set({ b1Company: companyDb })
      .where(and(eq(configProject.tenantId, tenantId), isNotNull(configProject.b1DocEntry), isNull(configProject.b1Company)));
    await tx.delete(entityMeta).where(eq(entityMeta.tenantId, tenantId));
    await tx.delete(configMasterdataRow).where(eq(configMasterdataRow.tenantId, tenantId));
    await tx.update(configMasterdata).set({ syncedAt: null, rowCount: 0 })
      .where(and(eq(configMasterdata.tenantId, tenantId), eq(configMasterdata.kind, "query")));
    return true;
  });
  if (adopted) {
    // The in-process halves: the entity list, and (through the version) the lookup and row caches.
    forgetEntityList(tenantId);
    bumpMasterdata(tenantId);
  }
  return adopted;
}

/** The tenant's on-prem agent, as a pair of transports. They hold nothing but config, so there is
 *  nothing worth caching. Beas is always built: an agent without it answers 503. */
export async function tenantConnector(tenantId: string): Promise<Connector> {
  const a = await agentTarget(tenantId);
  return {
    b1: new DirectTransport(agentRequester(a, "b1")), beas: new DirectTransport(agentRequester(a, "beas")),
    companyDb: a.companyDb ?? null,
  };
}

/** The company the tenant's SAP reads are in now — for what a page shows. A decision that leads to a
 *  SAP call takes `Connector.companyDb` instead. */
export async function tenantCompany(tenantId: string): Promise<string | null> {
  const [row] = await db.select({ companyDb: sapConnection.companyDb }).from(sapConnection)
    .where(eq(sapConnection.tenantId, tenantId)).limit(1);
  return row?.companyDb ?? null;
}

/** The project's quotation is in this company: a DocEntry means nothing in another one. */
export const quotationIn = (p: { b1DocEntry: number | null; b1Company: string | null }, companyDb: string | null) =>
  p.b1DocEntry !== null && p.b1Company === companyDb;

/** The tenant's B1 local currency — what every money figure in the app is denominated in.
 *
 *  Read through `sap_connection.localCurrency`: B1 offers no way to change a company's local
 *  currency once the database exists, so one successful read is cached forever and there is no
 *  TTL to get wrong. Populated lazily rather than at sign-in, because better-auth has no sign-in
 *  hook and, more to the point, logging in must not depend on the customer's agent being up.
 *
 *  Never throws, for the same reason: `me` calls this on every cold load, and a tenant whose
 *  tunnel is down still has to get its app shell. null just means unsymbolled numbers.
 *
 *  No new transport method: CompanyService_GetAdminInfo is a plain GET directly under the Service
 *  Layer base, which is exactly the URL readEntitySet builds when there are no query options. It
 *  answers with a single object, not a collection, so there is no `rowsOf` here. */
export async function tenantCurrency(tenantId: string): Promise<string | null> {
  const [row] = await db
    .select({ localCurrency: sapConnection.localCurrency })
    .from(sapConnection)
    .where(eq(sapConnection.tenantId, tenantId))
    .limit(1);
  if (!row) return null;
  if (row.localCurrency) return row.localCurrency;
  try {
    const { data } = await (await tenantConnector(tenantId)).b1.readEntitySet("CompanyService_GetAdminInfo");
    const cur = (data as { LocalCurrency?: unknown } | null)?.LocalCurrency;
    if (typeof cur !== "string" || !cur) return null;
    await db.update(sapConnection).set({ localCurrency: cur }).where(eq(sapConnection.tenantId, tenantId));
    return cur;
  } catch {
    return null;
  }
}

export const transportFor = (c: Connector, target: "b1" | "beas"): B1Transport =>
  target === "beas" ? c.beas : c.b1;

/** Map a B1Error to the closest ORPCError. Status + code come off the wire intact, so this is a
 *  lookup rather than a regex over a message. Agent-auth 401 is the exception: it never reached
 *  SAP, so it must not be phrased as a SAP rejection. Anything else is rethrown untouched. */
export function toOrpcError(e: unknown): unknown {
  if (e instanceof ORPCError) return e;
  if (!(e instanceof B1Error)) return e;
  const message = e.message;
  switch (true) {
    case e.status === 503:
      return new ORPCError("SERVICE_UNAVAILABLE", { message });
    case e.status === 401 && message === "Bad agent secret":
      return new ORPCError("BAD_GATEWAY", {
        message: "The SAP agent rejected Confire's secret: another workspace or server paired since. Pair it again in Settings → SAP agent.",
      });
    case e.code === COMPANY_CHANGED:
      return new ORPCError("CONFLICT", { message });
    case e.code === "AGENT_REFUSED": // the agent's allowlist (apps/agent/allow.go), not SAP
      return new ORPCError("FORBIDDEN", { message });
    case e.status === 401 || e.status === 403:
      return new ORPCError("BAD_GATEWAY", { message: `SAP rejected the request: ${message}` });
    case e.status === 404:
      return new ORPCError("NOT_FOUND", { message });
    case e.status === 409 || e.status === 412:
      return new ORPCError("CONFLICT", { message: `The SAP document changed since it was read: ${message}` });
    case e.status === 400:
      return new ORPCError("BAD_REQUEST", { message });
    default:
      return new ORPCError("BAD_GATEWAY", { message });
  }
}

/** Wrap a live-SAP hop so handlers stay one-liners. */
export async function viaB1<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toOrpcError(e);
  }
}

/** The production QueryRunner: turns a model's structured query into transport calls.
 *  `$select` is derived here from the source's declared columns — the model never stores one.
 *
 *  One page per call, always. The masterdata sync walks a table by following `nextSkip` and
 *  inserting each page as it lands, so there is no multi-page branch here to hide an unbounded
 *  read behind — see packages/b1's note on why there is no `readAll`. */
export function runnerFor(conn: Connector): QueryRunner {
  return (target, query, columns, opts) =>
    viaB1(async () => {
      const t = transportFor(conn, target);
      const base = {
        filter: query.filter,
        orderby: query.orderby,
        ...(columns.length ? { select: columns } : {}),
      };

      // The caller may ask for less than a page (the masterdata editor's preview reads five rows);
      // DEFAULT_PAGE stays the ceiling, so `size` can only ever shrink the read.
      const size = Math.min(opts?.top ?? DEFAULT_PAGE, DEFAULT_PAGE);
      // Page size is `Prefer: odata.maxpagesize`, not `$top`: `$top` bounds the whole result set,
      // so B1 stops emitting `@odata.nextLink` once it is exhausted and the value help would page
      // exactly once. `$skip` stays the cursor here — see the note in CLAUDE.md; the entity list
      // uses the nextLink itself, but a value help's cursor must stay a plain offset.
      const res = await t.readEntitySet(query.entitySet, { ...base, maxPageSize: size, skip: opts?.skip });
      const rows = rowsOrThrow(res.data, `Lookup ${target} ${query.entitySet}`);
      // @odata.nextLink is B1's own "there is more", so paging no longer depends on the page it
      // returned matching the $top we asked for. The cursor stays a plain $skip offset.
      return { rows, ...(nextLinkOf(res.data) ? { nextSkip: (opts?.skip ?? 0) + rows.length } : {}) };
    });
}

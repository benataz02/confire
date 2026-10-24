import { db, sapConnection } from "@confire/db";
import { encryptSecret } from "../src/crypto.ts";

// A stand-in for the on-prem agent: its wire (`POST /b1/request` with `{ method, path }`, `/print`,
// `/health`) over a tiny in-memory B1. Real enough to exercise the whole cloud hop — DirectTransport
// over agentPost, the bearer check, the company check, the wire error envelope — without a Service
// Layer. Each request is parsed back into an operation (`/entity-set`, `/create`, …) for `calls`,
// which is what the tests assert on.

export type MockStore = Record<string, Record<string, unknown>[]>;

const SECRET = "test-agent-secret";

export type MockAgent = {
  url: string;
  store: MockStore;
  /** EDMX served by /metadata; set it to make entities.schema work */
  metadata: { xml: string };
  /** every {route, body} the cloud sent, in order */
  calls: { route: string; body: Record<string, unknown> }[];
  /** entity sets whose UDFs are "not defined in this company" — filtering on one 400s, as B1 does */
  missingUdf: Set<string>;
  /** the company agent.json names; a call built for another one answers 409 COMPANY_CHANGED */
  company: { db: string };
  stop: () => void;
};

/** `5` → 5, `'C1'` → "C1": the key literal query.ts' buildKeyValue wrote. */
const keyOf = (raw: string): string | number =>
  raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : Number(raw);

/** A request path back into the operation the old wire named, and its arguments. */
function operationOf(method: string, path: string, headers: Record<string, string>, data: unknown): { route: string; body: Record<string, any> } {
  const [target = "", qs = ""] = path.split(/\?(.*)/s);
  const params = Object.fromEntries(qs.split("&").filter(Boolean).map((kv) => {
    const at = kv.indexOf("=");
    return [kv.slice(0, at), decodeURIComponent(kv.slice(at + 1))];
  }));
  const query = {
    ...(params.$filter ? { filter: params.$filter } : {}),
    ...(params.$select ? { select: params.$select.split(",") } : {}),
    ...(params.$orderby ? { orderby: params.$orderby } : {}),
    ...(params.$top ? { top: Number(params.$top) } : {}),
    ...(params.$skip ? { skip: Number(params.$skip) } : {}),
  };
  if (target.startsWith("$metadata")) return { route: "/metadata", body: {} };
  const cj = /^\$crossjoin\((.*)\)$/.exec(target);
  if (cj) return { route: "/cross-join", body: { entities: cj[1]!.split(","), filter: params.$filter } };
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?(?:\/([A-Za-z_]+))?$/.exec(target);
  if (!m) return { route: `/unknown ${method} ${target}`, body: {} };
  const [, entitySet, rawKey, action] = m;
  const key = rawKey === undefined ? undefined : keyOf(rawKey);
  if (method === "GET") return key === undefined ? { route: "/entity-set", body: { entitySet, query } } : { route: "/entity", body: { entitySet, key, query } };
  if (method === "POST" && action) return { route: "/action", body: { entitySet, key, name: action } };
  if (method === "POST") return { route: "/create", body: { entitySet, data, prefer: headers.Prefer } };
  if (method === "PATCH")
    return { route: "/update", body: { entitySet, key, data, etag: headers["If-Match"], replaceCollections: headers["B1S-ReplaceCollectionsOnPatch"] === "true" } };
  return { route: "/delete", body: { entitySet, key, etag: headers["If-Match"] } };
}

/** `Field eq 'value'`, optionally `and Field ne <number>` — the only shapes the mock understands,
 *  which is all the dedup check-then-create (and its re-quote variant) needs. Anything else
 *  matches nothing. */
function applyFilter(rows: Record<string, unknown>[], filter: string | undefined): Record<string, unknown>[] {
  if (!filter) return rows;
  const m = /^([A-Za-z_][A-Za-z0-9_]*) eq '(.*?)'(?: and ([A-Za-z_][A-Za-z0-9_]*) ne (\d+))?$/.exec(filter);
  if (!m) return [];
  return rows.filter((r) => String(r[m[1]!] ?? "") === m[2]!.replace(/''/g, "'") && (!m[3] || r[m[3]] !== Number(m[4])));
}

export function startMockAgent(store: MockStore = {}): MockAgent {
  const calls: MockAgent["calls"] = [];
  const company = { db: "SBODEMO" };
  const missingUdf = new Set<string>();
  const metadata = { xml: "" };
  let nextDocEntry = 1;
  let nextEtag = 1000; // clear of any etag a fixture hand-writes

  const fail = (status: number, code: number | null, message: string) =>
    Response.json({ error: { status, code, message } }, { status: status === 401 ? 401 : 502 });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/health")
        return Response.json({ ok: true, version: "test", companyDb: company.db, services: { b1: true, beas: false, print: ["Quotations"] } });
      if (req.headers.get("authorization") !== `Bearer ${SECRET}`) return fail(401, null, "Bad agent secret");
      // Before anything touches the store, as the real agent checks before it touches SAP.
      if (req.headers.get("x-confire-company") !== company.db)
        return Response.json({ error: { status: 409, code: "COMPANY_CHANGED", message: `This agent serves ${company.db}`, companyDb: company.db } }, { status: 409 });

      const wire = (await req.json()) as Record<string, any>;
      const { route, body } = pathname === "/print" ? { route: "/print", body: wire }
        : operationOf(wire.method, wire.path, wire.headers ?? {}, wire.body);
      calls.push({ route, body });
      const rows = (store[body.entitySet] ??= []);

      switch (route) {
        case "/entity-set": {
          const filter: string | undefined = body.query?.filter;
          // B1 answers a filter on a UDF that does not exist in the company with a 400.
          if (filter && missingUdf.has(body.entitySet) && /U_[A-Za-z0-9_]+/.test(filter))
            return fail(400, -1000, `Property '${/U_[A-Za-z0-9_]+/.exec(filter)![0]}' of '${body.entitySet}' is invalid`);
          return Response.json({ status: 200, data: { value: applyFilter(rows, filter).slice(0, body.query?.top ?? 20) } });
        }
        case "/create": {
          // A service action (SeriesService_GetDocumentSeries) answers with its fixture rows.
          if (/Service_/.test(body.entitySet)) return Response.json({ status: 200, data: { value: rows } });
          // A business partner sent without a CardCode is numbered, as B1 does from its series.
          if (body.entitySet === "BusinessPartners") {
            const bp = { CardCode: `L${String(nextDocEntry++).padStart(5, "0")}`, ...body.data };
            rows.push(bp);
            return Response.json({ status: 201, data: bp });
          }
          // A new document is open, as B1 makes it.
          const row = { DocEntry: nextDocEntry, DocNum: 900 + nextDocEntry, DocumentStatus: "bost_Open", "@odata.etag": `W/"${nextEtag++}"`, ...body.data };
          nextDocEntry++;
          rows.push(row);
          return Response.json({ status: 201, data: row });
        }
        case "/entity": {
          // Key by whichever field the set is actually keyed on. DocEntry for documents, a string
          // key (CardCode, ItemCode) for master data, SalesEmployeeCode for SalesPersons.
          const found = rows.find((r) => r.DocEntry === body.key || r.CardCode === body.key || r.ItemCode === body.key
            || r.SalesEmployeeCode === body.key);
          // The cloud lifts @odata.etag out of the body (DirectTransport).
          return found
            ? Response.json({ status: 200, data: found })
            : fail(404, -2028, "No matching records found");
        }
        case "/update": {
          const found = rows.find((r) => r.DocEntry === body.key);
          if (!found) return fail(404, -2028, "No matching records found");
          // The whole point of If-Match: a stale tag means someone else got there first.
          if (body.etag && body.etag !== found["@odata.etag"])
            return fail(412, -2039, "Precondition failed");
          // ponytail: unverified (spec §16) — the code and text a live B1 gives a PATCH on a closed
          // quotation. Record the real one here once it has been seen.
          if (found.DocumentStatus === "bost_Close") return fail(400, -5002, "Document is already closed");
          Object.assign(found, body.data, { "@odata.etag": `W/"${nextEtag++}"` });
          return Response.json({ status: 204, data: null });
        }
        case "/action": {
          const found = rows.find((r) => r.DocEntry === body.key);
          if (!found) return fail(404, -2028, "No matching records found");
          if (body.name !== "Close") return fail(400, null, `Unknown action '${body.name}'`);
          if (found.DocumentStatus === "bost_Close") return fail(400, -5002, "Document is already closed");
          Object.assign(found, { DocumentStatus: "bost_Close", "@odata.etag": `W/"${nextEtag++}"` });
          return Response.json({ status: 204, data: null });
        }
        case "/cross-join": {
          // Enough to prove the walk wires up: pair each document of the leading entity with each
          // of its own lines, and let the caller's assertions do the rest. The mock does not
          // parse the $filter — the filter's shape is asserted by doc-chain.test.ts, which is
          // pure and does not need a server.
          const [lead] = body.entities as string[];
          const docs = store[lead!] ?? [];
          const value = docs.flatMap((d) =>
            ((d.DocumentLines as Record<string, unknown>[] | undefined) ?? [{}]).map((l) => ({
              [lead!]: d, [`${lead}/DocumentLines`]: l,
            })));
          return Response.json({ status: 200, data: { value } });
        }
        case "/print": {
          if (!["Quotations", "Orders", "DeliveryNotes", "Invoices"].includes(body.entity))
            return fail(400, null, `No print layout configured for '${body.entity}'`);
          return Response.json({
            // "%PDF-1.4\n" — enough for a caller to prove it decoded the base64 it was given.
            pdf: Buffer.from(`%PDF-1.4\n${body.entity}:${body.docEntry}`).toString("base64"),
            fileName: `${body.entity}-${body.docEntry}.pdf`,
          });
        }
        case "/metadata":
          return Response.json({ status: 200, data: metadata.xml });
        default:
          return fail(404, null, `Unknown operation '${route}'`);
      }
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    store, calls, missingUdf, metadata, company,
    stop: () => void server.stop(true),
  };
}

/** Point a tenant at the mock agent — the same row pairing writes. */
export async function connectTenant(tenantId: string, agent: MockAgent): Promise<void> {
  const row = { tenantId, agentUrl: agent.url, secret: encryptSecret(SECRET), companyDb: agent.company.db };
  await db.insert(sapConnection).values(row).onConflictDoUpdate({ target: sapConnection.tenantId, set: row });
}

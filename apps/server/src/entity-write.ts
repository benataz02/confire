import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, portalCompany } from "@confire/db";
import { coerceKey, type B1EntitySchema, type B1Field, type B1Transport, type Key } from "@confire/b1";
import { entitySchema } from "./entity-meta.ts";
import { missingRequired, pickEditable, profileOf, type EntityProfile } from "./entity-profiles.ts";
import { buildCopy, COPY_SELECT, CopyHeaderZ, findFlow } from "./doc-copy.ts";
import { viaB1 } from "./b1.ts";
import { bad } from "./entity-read.ts";
import { t } from "./i18n/index.ts";

// The B1 write bodies, once (b1-tools spec §5.0): create, update and copy for the pages' procedures
// (entities.*) and the tools' (b1.*). Each write is two steps — `prepareWrite` checks everything and
// reads what it needs, `postWrite` sends it — so a tool can stop between them and answer a proposal,
// and `b1.post` re-runs the same check on what the user saw before it posts.
//
// The field rule is the caller's, set on the server, never by the client:
//   profile — the pages': the profile's fields only (pickEditable), as ever.
//   schema  — the tools': every field of the cached schema, collections and their lines included; a
//             name not in the schema is refused, naming it — never dropped and read as "empty".
// Both rules first require a curated entity (`curated`). That one check is what opening writes to
// every entity later changes (spec §5.4).

export type FieldRule = "profile" | "schema";
export type WriteCtx = { tenantId: string; b1: B1Transport };

export const EntityZ = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an entity set name");
export const KeyZ = z.union([z.string(), z.number(), z.record(z.string(), z.union([z.string(), z.number()]))]);

export const CopyZ = z.object({
  sourceEntity: EntityZ,
  targetEntity: EntityZ,
  // ponytail: one read per source through the agent; 50 caps the burst, batch if lists merge more.
  docEntries: z.array(z.number().int()).min(1).max(50),
});
export const CopyInputZ = CopyZ.extend({
  header: CopyHeaderZ.optional(),
  lines: z.array(z.object({ baseEntry: z.number().int(), baseLine: z.number().int(), quantity: z.number().positive() })).min(1).optional(),
});
export type CopyInput = z.infer<typeof CopyInputZ>;

/** Writes are curated-only. */
export const curated = (entity: string): EntityProfile => {
  const p = profileOf(entity);
  if (!p) throw new ORPCError("FORBIDDEN", { message: t("ENTITY_READ_ONLY", entity) });
  return p;
};

/** A copy's flow and its source documents, read from B1 — for the draft and for the post alike. */
export async function copySources(b1: B1Transport, input: z.infer<typeof CopyZ>) {
  const flow = findFlow(input.sourceEntity, input.targetEntity);
  if (!flow)
    throw new ORPCError("BAD_REQUEST", { message: t("COPY_NO_FLOW", input.sourceEntity, input.targetEntity) });
  const read = await Promise.all([...new Set(input.docEntries)].map((n) =>
    viaB1(() => b1.readEntity(flow.source, n, { select: COPY_SELECT }))));
  return { flow, sources: read.map((r) => r.data as Record<string, unknown>) };
}

// --- names ---------------------------------------------------------------------------------------

/** The real names closest to a wrong one: the same name in another case, else names it starts or
 *  ends inside, else a shared stem. A guess costs the model one retry, not a schema read up front. */
export function closestNames(wrong: string, names: string[], max = 5): string[] {
  const w = wrong.toLowerCase();
  const exact = names.filter((n) => n.toLowerCase() === w);
  if (exact.length) return exact;
  const near = names.filter((n) => { const l = n.toLowerCase(); return l.startsWith(w) || w.startsWith(l) || l.includes(w); });
  if (near.length) return near.slice(0, max);
  const stem = w.slice(0, Math.max(3, Math.ceil(w.length / 2)));
  return names.filter((n) => n.toLowerCase().startsWith(stem)).slice(0, max);
}

/** "Not on Orders: Foo (did you mean FooBar?), Baz. See b1_schema." */
export function unknownNames(entity: string, wrong: { name: string; among: string[] }[]): ORPCError<"BAD_REQUEST", unknown> {
  const parts = wrong.map(({ name, among }) => {
    const leaf = name.replace(/^.*\./, "");
    const close = closestNames(leaf, among);
    return close.length ? t("ENTITY_FIELD_CLOSEST", name, close.join(", ")) : name;
  });
  return new ORPCError("BAD_REQUEST", { message: t("ENTITY_FIELDS_UNKNOWN", entity, parts.join("; ")) });
}

/** The schema rule: every name the data uses is the schema's, a collection's lines included. */
function checkSchemaNames(schema: B1EntitySchema, data: Record<string, unknown>): void {
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const all = [...byName.keys()];
  const wrong: { name: string; among: string[] }[] = [];
  for (const [k, v] of Object.entries(data)) {
    const f = byName.get(k);
    if (!f) { wrong.push({ name: k, among: all }); continue; }
    if (f.kind !== "collection") continue;
    if (!Array.isArray(v) || v.some((l) => !l || typeof l !== "object" || Array.isArray(l)))
      throw new ORPCError("BAD_REQUEST", { message: t("ENTITY_LINES_SHAPE", k) });
    const lineNames = (f.fields ?? []).map((x) => x.name);
    const lineSet = new Set(lineNames);
    const seen = new Set<string>();
    for (const line of v as Record<string, unknown>[])
      for (const lk of Object.keys(line))
        if (!lineSet.has(lk) && !seen.has(lk)) { seen.add(lk); wrong.push({ name: `${k}.${lk}`, among: lineNames }); }
  }
  if (wrong.length) throw unknownNames(schema.name, wrong);
}

/** The data as the field rule lets it through: the profile's allowlist, or every schema name. */
function ruled(rule: FieldRule, profile: EntityProfile, schema: B1EntitySchema, entity: string, data: Record<string, unknown>, create: boolean) {
  if (create) {
    const missing = missingRequired(profile, data);
    if (missing.length) throw new ORPCError("BAD_REQUEST", { message: t("ENTITY_NEEDS", entity, missing.join(", ")) });
  }
  if (rule === "schema") {
    checkSchemaNames(schema, data);
    return data;
  }
  const { payload, rejected } = pickEditable(profile, data, { create });
  if (rejected.length)
    throw new ORPCError("BAD_REQUEST", { message: t(create ? "ENTITY_NOT_SETTABLE" : "ENTITY_NOT_EDITABLE", entity, rejected.join(", ")) });
  return payload;
}

// --- prepare / post -------------------------------------------------------------------------------

export type WriteRequest =
  | { op: "create"; entity: string; data: Record<string, unknown> }
  | { op: "update"; entity: string; key: Key; etag?: string; data: Record<string, unknown> }
  | { op: "copy"; input: CopyInput };

/** A checked write, ready to post. `before` is the row now (an update read for its changes). */
export type Prepared =
  | { op: "create"; entity: string; keys: string[]; payload: Record<string, unknown> }
  | { op: "update"; entity: string; keys: string[]; key: Key; etag: string; payload: Record<string, unknown>; before?: Record<string, unknown> }
  | { op: "copy"; entity: string; keys: string[]; input: CopyInput; payload: Record<string, unknown> };

const schemaOf = (ctx: WriteCtx, entity: string) => viaB1(() => entitySchema(ctx.tenantId, ctx.b1, entity)).catch(bad);

/**
 * Check a write and gather what posting it needs. `readBefore`: read the record now (an update),
 * for its changes and its ETag — the model's `etag`, when given, must still be the current one, so a
 * decision made on an older read answers CONFLICT here rather than after a click.
 */
export async function prepareWrite(ctx: WriteCtx, rule: FieldRule, w: WriteRequest, o: { readBefore?: boolean } = {}): Promise<Prepared> {
  if (w.op === "copy") {
    // A copy keeps its header allowlist (CopyHeaderZ) under either rule: its targets include
    // DeliveryNotes and Invoices, which are not curated.
    const { flow, sources } = await copySources(ctx.b1, w.input);
    let payload: Record<string, unknown>;
    try {
      payload = buildCopy(flow, sources, { header: w.input.header, lines: w.input.lines });
    } catch (e) {
      return bad(e);
    }
    return { op: "copy", entity: flow.target, keys: ["DocEntry"], input: w.input, payload };
  }

  const profile = curated(w.entity);
  const schema = await schemaOf(ctx, w.entity);
  if (w.op === "create") return { op: "create", entity: w.entity, keys: schema.keys, payload: ruled(rule, profile, schema, w.entity, w.data, true) };

  const payload = ruled(rule, profile, schema, w.entity, w.data, false);
  if (!Object.keys(payload).length) throw new ORPCError("BAD_REQUEST", { message: t("ENTITY_NOTHING_TO_UPDATE") });
  let key: Key;
  try { key = coerceKey(schema, w.key); } catch (e) { return bad(e); }
  let before: Record<string, unknown> | undefined;
  let etag = w.etag;
  if (o.readBefore) {
    const now = await viaB1(() => ctx.b1.readEntity(w.entity, key));
    before = now.data as Record<string, unknown>;
    if (etag && now.etag && etag !== now.etag) throw new ORPCError("CONFLICT", { message: t("ENTITY_CHANGED_SINCE_READ", w.entity) });
    etag ??= now.etag;
  }
  // No If-Match is a silent overwrite of a concurrent edit, and there is no force path.
  if (!etag) throw new ORPCError("BAD_REQUEST", { message: t("ENTITY_NO_ETAG", w.entity) });
  return { op: "update", entity: w.entity, keys: schema.keys, key, etag, payload, ...(before ? { before } : {}) };
}

export type Posted = { entity: string; key: Key | null; row: Record<string, unknown>; etag: string | null };

const keyOfRow = (keys: string[], row: Record<string, unknown>): Key | null => {
  const vals = keys.map((k) => row[k]);
  if (!keys.length || vals.some((v) => typeof v !== "string" && typeof v !== "number")) return null;
  return keys.length === 1 ? (vals[0] as string | number) : Object.fromEntries(keys.map((k, i) => [k, vals[i] as string | number]));
};

/** Send a prepared write. An update carries If-Match (a stale one is B1's 412 → CONFLICT) and is
 *  read again for its new ETag; a create answers the document (`prefer: representation`). */
export async function postWrite(ctx: WriteCtx, p: Prepared): Promise<Posted> {
  if (p.op !== "update") {
    const res = await viaB1(() => ctx.b1.createEntity(p.entity, p.payload, { prefer: "representation" }));
    const row = res.data as Record<string, unknown>;
    return { entity: p.entity, key: keyOfRow(p.keys, row), row, etag: res.etag ?? null };
  }
  await viaB1(() => ctx.b1.updateEntity(p.entity, p.key, p.payload, { etag: p.etag }));
  // B1's PATCH answers 204; re-read so the caller gets the new ETag rather than a stale one.
  const fresh = await viaB1(() => ctx.b1.readEntity(p.entity, p.key));
  const row = fresh.data as Record<string, unknown>;
  // A portal company keeps its BP's language for its mail: an edit here is one of the reads that
  // keep the copy current. No row = the BP is not on the portal, and nothing changes.
  if (p.entity === "BusinessPartners" && typeof row.CardCode === "string") {
    await db.update(portalCompany)
      .set({ languageCode: typeof row.LanguageCode === "number" ? row.LanguageCode : null })
      .where(and(eq(portalCompany.tenantId, ctx.tenantId), eq(portalCompany.cardCode, row.CardCode)));
  }
  return { entity: p.entity, key: p.key, row, etag: fresh.etag ?? null };
}

/** A collection's fields, for b1.schema. */
export const collectionOf = (schema: B1EntitySchema, name: string): B1Field | undefined =>
  schema.fields.find((f) => f.name === name && f.kind === "collection");

import { and, eq } from "drizzle-orm";
import { db, entityMeta } from "@confire/db";
import {
  parseEntityList, parseEntitySchema, type B1EntityRef, type B1EntitySchema, type B1Transport,
} from "@confire/b1";

// B1's $metadata, cached. The full EDMX is ~1.7 MB; both reads here use the scoped query the
// Service Layer already supports, so a schema costs one entity's worth of XML, not the lot.

const LIST_TTL_MS = 24 * 60 * 60_000;

/** Bump this whenever metadata.ts changes what a parsed schema looks like. A row parsed by the
 *  old code is stale however fresh it is, and this is now the *only* thing that expires one — a
 *  stored schema is otherwise kept until someone presses Refresh, because B1 metadata changes
 *  when an admin adds a UDF, not on a clock. Without this every tenant would keep serving the old
 *  shape forever, which is how BoYesNoEnum kept rendering as a tYES/tNO dropdown after it became
 *  a boolean. */
//  Must be a past timestamp: `Math.min` with process start so a future one can only ever be a
//  no-op, never a re-read of $metadata on every single request.
const PARSER_EPOCH = Math.min(Date.parse("2026-08-28T07:55:00Z"), Date.now());

/** The entity list is small and shared by every browse page — a per-process cache is enough,
 *  and it self-heals on restart. The per-entity schemas go to Postgres because there are ~420
 *  of them and they outlive a deploy. */
const listCache = new Map<string, { at: number; list: Promise<B1EntityRef[]> }>();

export function entityList(tenantId: string, b1: B1Transport, refresh = false): Promise<B1EntityRef[]> {
  const hit = listCache.get(tenantId);
  if (!refresh && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.list;
  const list = b1
    .metadata({ scope: "entityset", annotation: "labelWithTable" })
    .then(parseEntityList);
  list.catch(() => listCache.delete(tenantId)); // a failed fetch must not poison the key for a day
  listCache.set(tenantId, { at: Date.now(), list });
  return list;
}

/** Reject an entity name the tenant's B1 does not expose, before it can reach a URL. */
export async function assertEntity(tenantId: string, b1: B1Transport, name: string): Promise<B1EntityRef> {
  const found = (await entityList(tenantId, b1)).find((e) => e.name === name);
  if (!found) throw new Error(`Unknown entity set '${name}'`);
  return found;
}

/** Value helps B1's own $metadata does not declare.
 *
 *  A NavigationProperty's ReferentialConstraint is what normally yields one (see the parser note in
 *  packages/b1/src/metadata.ts). B1 declares none for DocCurrency, so without this the quote page's
 *  currency is a free-text box — and a typo in it reaches SAP.
 *
 *  Keyed by field name rather than by entity on purpose: DocCurrency is the same column on every
 *  B1 marketing document, so one entry covers Quotations, Orders, DeliveryNotes and Invoices. */
const FIELD_LOOKUPS: Record<string, { entitySet: string; keyField: string }> = {
  DocCurrency: { entitySet: "Currencies", keyField: "Code" },
};

/** Overlay FIELD_LOOKUPS. Applied on *read* rather than before the row is written, so the schemas
 *  already sitting in entity_meta pick it up without a refresh — nothing else would have retired
 *  them, since a stored schema has no TTL. B1's own constraint wins where it declared one, the
 *  same precedence metadata.ts applies. */
function withFieldLookups(schema: B1EntitySchema): B1EntitySchema {
  if (!schema.fields.some((f) => !f.lookup && FIELD_LOOKUPS[f.name])) return schema;
  return {
    ...schema,
    fields: schema.fields.map((f) => {
      const extra = f.lookup ? undefined : FIELD_LOOKUPS[f.name];
      return extra ? { ...f, lookup: extra } : f;
    }),
  };
}

export async function entitySchema(
  tenantId: string,
  b1: B1Transport,
  name: string,
  refresh = false,
): Promise<B1EntitySchema> {
  if (!refresh) {
    const [row] = await db
      .select()
      .from(entityMeta)
      .where(and(eq(entityMeta.tenantId, tenantId), eq(entityMeta.entityName, name)))
      .limit(1);
    // A hit returns before assertEntity on purpose: the row only exists because the name was
    // checked against the entity list when it was written, so a stored schema costs one Postgres
    // read and no agent call at all — which is the whole point of storing it.
    if (row && row.fetchedAt.getTime() >= PARSER_EPOCH) return withFieldLookups(row.json);
  }
  await assertEntity(tenantId, b1, name);

  // dependency=true pulls the ComplexTypes and EnumTypes this entity's properties reference,
  // which is what makes one scoped call enough to render a whole form.
  const xml = await b1.metadata({
    scope: "entityset",
    annotation: "labelWithField,labelWithTable",
    entityset: name,
    dependency: true,
  });
  const schema = parseEntitySchema(xml, name, await entityList(tenantId, b1, refresh));
  const fetchedAt = new Date();
  await db
    .insert(entityMeta)
    .values({ tenantId, entityName: name, json: schema, fetchedAt })
    .onConflictDoUpdate({
      target: [entityMeta.tenantId, entityMeta.entityName],
      set: { json: schema, fetchedAt },
    });
  return withFieldLookups(schema);
}

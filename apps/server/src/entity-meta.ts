import { and, eq } from "drizzle-orm";
import { db, entityMeta } from "@confire/db";
import {
  parseEntityList, parseEntitySchemas,
  type B1EntityRef, type B1EntitySchema, type B1Field, type B1FieldKind, type B1Transport,
} from "@confire/b1";
import type { EntityProfile } from "./entity-profiles.ts";

// B1's $metadata, cached. The full EDMX is ~1.7 MB; both reads here use the scoped query, so a
// schema costs one entity's worth of XML, not the lot — on 10.0 FP2608 and later. An older Service
// Layer ignores every $metadata option and answers the whole unannotated document (verified
// 2026-10-24): the parse still finds the entity, minus labels (the browser's catalog names fields).
// ponytail: an old SL pays ~1.5 MB per entity's first read and per day's entity list; keep one
// full document per tenant if that read shows up.

const LIST_TTL_MS = 24 * 60 * 60_000;

/** Bump this whenever metadata.ts changes what a parsed schema looks like. A row parsed by the
 *  old code is stale however fresh it is, and this is now the *only* thing that expires one — a
 *  stored schema is otherwise kept until someone presses Refresh, because B1 metadata changes
 *  when an admin adds a UDF, not on a clock. Without this every tenant would keep serving the old
 *  shape forever, which is how BoYesNoEnum kept rendering as a tYES/tNO dropdown after it became
 *  a boolean. */
//  Must be a past timestamp: `Math.min` with process start so a future one can only ever be a
//  no-op, never a re-read of $metadata on every single request.
const PARSER_EPOCH = Math.min(Date.parse("2026-10-24T14:00:00Z"), Date.now());

/** The entity list is small and shared by every browse page — a per-process cache is enough,
 *  and it self-heals on restart. The per-entity schemas go to Postgres because there are ~420
 *  of them and they outlive a deploy. Beas' whole schema set sits here too: its $metadata has no
 *  scoped read, so one ~220 KB document is every schema at once (`b1:`/`beas:` keys). */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function daily<T>(key: string, refresh: boolean, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value as Promise<T>;
  const value = load();
  // A failed fetch must not poison the key for a day — nor drop a newer one that replaced it.
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** A company switch (b1.ts adoptCompany): both belong to the old company — Beas maps fields onto
 *  the company's own UDF columns. */
export const forgetEntityList = (tenantId: string) => { cache.delete(`b1:${tenantId}`); cache.delete(`beas:${tenantId}`); };

export const entityList = (tenantId: string, b1: B1Transport, refresh = false): Promise<B1EntityRef[]> =>
  daily(`b1:${tenantId}`, refresh, () => b1.metadata({ scope: "entityset", annotation: "labelWithTable" }).then(parseEntityList));

/** Every Beas entity set's schema: no labels, enums or navigations — Beas' EDMX carries none. */
export const beasSchemas = (tenantId: string, beas: B1Transport, refresh = false): Promise<B1EntitySchema[]> =>
  daily(`beas:${tenantId}`, refresh, () => beas.metadata().then(parseEntitySchemas));

/** Reject an entity name the tenant's B1 does not expose, before it can reach a URL. */
export async function assertEntity(tenantId: string, b1: B1Transport, name: string): Promise<B1EntityRef> {
  const found = (await entityList(tenantId, b1)).find((e) => e.name === name);
  if (!found) throw new Error(`Unknown entity set '${name}'`);
  return found;
}

// --- constraints -------------------------------------------------------------------------------
// The browser's view of an entity, in the shape the Beas client reads from /api/metadata/{Entity}:
// per-field constraints that a *declared* page config is merged with. Metadata never creates a
// field, a section or a column here — the feature does — it only says what a declared one is.
// No value helps: those are declared CFLs on the web side, as in Beas.

export type FieldConstraint = {
  Type: B1FieldKind;
  EdmType: string;
  Label?: string;
  MaxLength?: number;
  /** requiredOnCreate */
  Required?: boolean;
  /** the write allowlist says a user may change it — the same rule entities.update enforces */
  Editable?: boolean;
  Options?: { value: string; label: string }[];
  /** a tenant's own `U_` field */
  Udf?: boolean;
  /** a collection's own fields (document lines) */
  Fields?: Record<string, FieldConstraint>;
};

export type EntityConstraints = {
  name: string;
  label: string;
  keys: string[];
  /** has a curated profile: the page may offer Edit/Create at all */
  writable: boolean;
  fields: Record<string, FieldConstraint>;
};

/** "bost_Open" -> "Open", "cCustomer" -> "Customer": B1's member names carry a lowercase type
 *  prefix that means nothing to a reader. */
const memberLabel = (name: string): string => name.replace(/^[a-z]+_?(?=[A-Z0-9])/, "") || name;

function constraintOf(f: B1Field, rule: { editable: boolean; required: boolean; lines: boolean }): FieldConstraint {
  return {
    Type: f.kind,
    EdmType: f.edmType,
    ...(f.label ? { Label: f.label } : {}),
    ...(f.maxLength ? { MaxLength: f.maxLength } : {}),
    ...(rule.required ? { Required: true } : {}),
    ...(rule.editable ? { Editable: true } : {}),
    // B1 carries an enum on the wire as its member NAME — `DocumentStatus eq 'bost_Open'` and
    // `CardType eq 'cCustomer'` are the forms verified against a live b1s/v2. The parser keeps the
    // ValidValue code as `value`; that is the
    // database column's spelling, not the Service Layer's, so the name is what an option sends.
    ...(f.options ? { Options: f.options.map((o) => ({ value: o.label, label: memberLabel(o.label) })) } : {}),
    ...(f.isUDF ? { Udf: true } : {}),
    ...(f.kind === "collection"
      ? {
          Fields: Object.fromEntries((f.fields ?? []).map((x) => [
            x.name,
            constraintOf(x, { editable: rule.lines, required: false, lines: false }),
          ])),
        }
      : {}),
  };
}

/**
 * One cached schema + the entity's write profile -> what the browser merges into its declared
 * fields. Applied on read, so the schemas already sitting in entity_meta stay valid: nothing in
 * here is stored. `profile` absent = read-only (no Editable anywhere, `writable: false`).
 */
export function toConstraints(schema: B1EntitySchema, profile: EntityProfile | undefined): EntityConstraints {
  const editable = new Set(profile?.editable ?? []);
  const required = new Set(profile?.requiredOnCreate ?? []);
  const lines = new Set(profile?.editableCollections ?? []);
  return {
    name: schema.name,
    label: schema.label,
    keys: schema.keys,
    writable: !!profile,
    fields: Object.fromEntries(schema.fields.map((f) => [
      f.name,
      constraintOf(f, {
        // pickEditable's rule, restated as data: the profile's fields, a writable entity's own U_
        // columns, and the collections whose lines it may write.
        editable: editable.has(f.name) || (!!profile && f.name.startsWith("U_")) || lines.has(f.name),
        required: required.has(f.name),
        lines: lines.has(f.name),
      }),
    ])),
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
    if (row && row.fetchedAt.getTime() >= PARSER_EPOCH) return row.json;
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
  const schema = parseEntitySchemas(xml, await entityList(tenantId, b1, refresh)).find((s) => s.name === name);
  if (!schema) throw new Error(`EntitySet '${name}' not found in metadata`);
  const fetchedAt = new Date();
  await db
    .insert(entityMeta)
    .values({ tenantId, entityName: name, json: schema, fetchedAt })
    .onConflictDoUpdate({
      target: [entityMeta.tenantId, entityMeta.entityName],
      set: { json: schema, fetchedAt },
    });
  return schema;
}

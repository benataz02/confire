import {
  parseEntityList, parseEntitySchemas,
  type B1EntityRef, type B1EntitySchema, type B1Field, type B1FieldKind, type B1Transport,
} from "@confire/b1";
import type { EntityProfile } from "./entity-profiles.ts";
import { t } from "./i18n/index.ts";
import { cached, entry, isFresh, put } from "./sap-cache.ts";

// B1's $metadata, kept in sap_cache. The full EDMX is ~1.7 MB; both reads here use the scoped query,
// so a schema costs one entity's worth of XML, not the lot — on 10.0 FP2608 and later. An older
// Service Layer ignores every $metadata option and answers the whole unannotated document (verified
// 2026-10-24): the parse still finds the entity, minus labels (the browser's catalog names fields).
// That answer holds every schema, so a miss stores them all (b1-tools spec §4): no version check —
// the answer's size is the signal — and an old SL sends the document once, not once per entity,
// until a Refresh or a company switch (adoptCompany forgets the tenant's cache).
// The entity list and Beas' whole schema set (its $metadata has no scoped read, so one ~220 KB
// document is every schema at once) are entries too, a day each (sap-cache.ts LIFETIME_MS).

/** Each entry is written under the company the transport's calls carry. */
const companyOf = (tr: B1Transport) => tr.companyDb ?? null;

export const entityList = (tenantId: string, b1: B1Transport, refresh = false): Promise<B1EntityRef[]> =>
  cached(tenantId, "entity_list", "", async () => ({
    company: companyOf(b1),
    data: parseEntityList(await b1.metadata({ scope: "entityset", annotation: "labelWithTable" })),
  }), { refresh });

/** Every Beas entity set's schema: no labels, enums or navigations — Beas' EDMX carries none. */
export const beasSchemas = (tenantId: string, beas: B1Transport, refresh = false): Promise<B1EntitySchema[]> =>
  cached(tenantId, "beas_schemas", "", async () => ({ company: companyOf(beas), data: parseEntitySchemas(await beas.metadata()) }), { refresh });

/** Reject an entity name the tenant's B1 does not expose, before it can reach a URL. */
export async function assertEntity(tenantId: string, b1: B1Transport, name: string): Promise<B1EntityRef> {
  const found = (await entityList(tenantId, b1)).find((e) => e.name === name);
  if (!found) throw new Error(t("ENTITY_SET_UNKNOWN", name));
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
 * fields. Applied on read, so the schemas already sitting in sap_cache stay valid: nothing in
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
    const stored = await entry<B1EntitySchema>(tenantId, "schema", name);
    // A hit returns before assertEntity on purpose: the entry only exists because the name was
    // checked against the entity list when it was written, so a stored schema costs one Postgres
    // read and no agent call at all — which is the whole point of storing it.
    if (isFresh("schema", stored)) return stored!.data!;
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
  const all = parseEntitySchemas(xml, await entityList(tenantId, b1, refresh));
  const schema = all.find((s) => s.name === name);
  if (!schema) throw new Error(t("ENTITY_SET_NOT_IN_METADATA", name));
  // One entity on FP2608+; every one of them (~360) on an older Service Layer.
  await put(tenantId, "schema", all.map((s) => ({ key: s.name, data: s })), { company: companyOf(b1) });
  return schema;
}

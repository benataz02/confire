import { useQuery } from "@tanstack/react-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "@confire/server/router";
import { orpc } from "../orpc.ts";
import type { FilterField, FormField, ListColumn, Section } from "./types.ts";

// Beas' FieldConstraintsService + ii/Jo/Zo + rg (LIST-REPORT-OBJECT-PAGE.md §7.1). The server
// answers entities.metadata from the cached $metadata plus the write profile; this module merges
// that into fields and columns a feature already declared. Metadata never creates a field, a
// section or a column — except the UDFs, which is the one place Beas lets the backend add them.

export type EntityConstraints = Awaited<ReturnType<RouterClient<AppRouter>["entities"]["metadata"]>>;
export type FieldConstraint = EntityConstraints["fields"][string];
export type Constraints = Record<string, FieldConstraint>;

/** One entity's constraints. A day in the browser cache costs nothing: the server reads them from
 *  entity_meta in Postgres and only re-reads $metadata on an explicit refresh. */
export function useFieldConstraints(entity: string | undefined) {
  return useQuery({
    ...orpc.entities.metadata.queryOptions({ input: { entity: entity ?? "" } }),
    enabled: !!entity,
    retry: false,
    staleTime: 24 * 60 * 60_000,
  });
}

// --- Jo: exact key first, then case-insensitive -------------------------------------------------
const lowerKeys = new WeakMap<Constraints, Map<string, string>>();

/** The metadata entry for a declared key and the key in metadata's casing. */
export function findConstraint(key: string, c: Constraints | undefined): [string, FieldConstraint] | undefined {
  if (!c) return undefined;
  const exact = c[key];
  if (exact) return [key, exact];
  let m = lowerKeys.get(c);
  if (!m) {
    m = new Map(Object.keys(c).map((k) => [k.toLowerCase(), k]));
    lowerKeys.set(c, m);
  }
  const hit = m.get(key.toLowerCase());
  return hit ? [hit, c[hit]!] : undefined;
}

const isYesNoType = (edm: string) => /BoYesNoEnum$/.test(edm);
/** B1's integers are keys, document numbers and codes; its amounts and quantities are Edm.Double. */
export const isIntegerType = (edm: string | undefined) => /^Edm\.(Int\d+|S?Byte)$/.test(edm ?? "");

// --- ii/Zo: one field ---------------------------------------------------------------------------
/**
 * A declared field merged with its metadata. The key is rewritten to the metadata casing (so
 * `formData[key]` reads the real property); MaxLength becomes `validators.maxLength`; Required
 * becomes `required` unless the field declared a function (a dynamic rule always wins); Type,
 * Options and Label fill in only what the field left out. Returns the same object when nothing
 * changes, so memoized children keep their identity.
 */
export function resolveField(field: FormField, c: Constraints | undefined): FormField {
  const found = findConstraint(field.key, c);
  const children = field.fields?.map((f) => resolveField(f, c));
  if (!found) return children ? { ...field, fields: children } : field;
  const [key, m] = found;
  return {
    ...field,
    key,
    label: field.label ?? m.Label ?? key,
    type: field.type ?? m.Type,
    ...(field.options ?? m.Options ? { options: field.options ?? m.Options } : {}),
    ...(m.MaxLength ? { validators: { maxLength: m.MaxLength, ...field.validators } } : {}),
    required: typeof field.required === "function" ? field.required : (field.required ?? !!m.Required),
    metaEditable: !!m.Editable,
    metaRequired: !!m.Required,
    ...(m.Udf ? { udf: true } : {}),
    ...(isYesNoType(m.EdmType) ? { yesNo: true } : {}),
    ...(isIntegerType(m.EdmType) ? { integer: true } : {}),
    ...(children ? { fields: children } : {}),
  };
}

/**
 * Editability, the one rule: edit mode, the server's allowlist (Editable; on create also Required,
 * because entities.create accepts requiredOnCreate), and the field's own `readonly` — or, for an
 * `editableOnCreate` field, only while creating. A field metadata has never heard of is not
 * editable: there is nothing the server would accept for it.
 */
export function isFieldEditable(f: FormField, isEditMode: boolean, isNew: boolean): boolean {
  if (!isEditMode) return false;
  const allowed = isNew ? !!(f.metaEditable || f.metaRequired) : !!f.metaEditable;
  return allowed && (f.editableOnCreate ? isNew : !f.readonly);
}

/** A column's label/type/options/maxLength from metadata, when the column left them out. A small
 *  deviation from Beas, whose grid ignores /api/metadata — it saves hand-typing ~60 labels. */
export function resolveColumns(columns: ListColumn[], c: Constraints | undefined): ListColumn[] {
  if (!c) return columns;
  return columns.map((col) => {
    const found = findConstraint(col.key, c);
    if (!found) return col;
    const [key, m] = found;
    return {
      ...col,
      key,
      label: col.label ?? m.Label ?? key,
      type: col.type ?? m.Type,
      ...(col.options ?? m.Options ? { options: col.options ?? m.Options } : {}),
      ...(m.MaxLength ? { maxLength: m.MaxLength } : {}),
      metaEditable: !!m.Editable,
      ...(m.Udf ? { udf: true } : {}),
      ...(isYesNoType(m.EdmType) ? { yesNo: true } : {}),
      ...(isIntegerType(m.EdmType) ? { integer: true } : {}),
    };
  });
}

/** A filter field's label/type/options from metadata, for a filter on a field the list does not
 *  show as a column. */
export function resolveFilters(fields: FilterField[], c: Constraints | undefined): FilterField[] {
  if (!c) return fields;
  return fields.map((f) => {
    const found = findConstraint(f.key, c);
    if (!found) return f;
    const [key, m] = found;
    return {
      ...f,
      key,
      label: f.label ?? m.Label ?? key,
      type: f.type ?? m.Type,
      ...(f.options ?? m.Options ? { options: f.options ?? m.Options } : {}),
    };
  });
}

// --- rg: every field of a section tree ----------------------------------------------------------
/** rg(): fields, groups, subsections and fieldGroup children resolved in place; a table's columns
 *  against its collection's own `Fields`. */
export function resolveSections(sections: Section[], c: Constraints | undefined): Section[] {
  if (!c) return sections;
  const fields = (fs: FormField[] | undefined) => fs?.map((f) => resolveField(f, c));
  return sections.map((s) => ({
    ...s,
    ...(s.fields ? { fields: fields(s.fields) } : {}),
    ...(s.groups ? { groups: s.groups.map((g) => ({ ...g, fields: fields(g.fields)! })) } : {}),
    ...(s.subsections
      ? { subsections: s.subsections.map((sub) => ({ ...sub, groups: sub.groups.map((g) => ({ ...g, fields: fields(g.fields)! })) })) }
      : {}),
    ...(s.table ? { table: { ...s.table, columns: resolveColumns(s.table.columns, findConstraint(s.table.key, c)?.[1].Fields) } } : {}),
  }));
}

/** Every leaf field of a section tree, in render order. Spacers and fieldGroup shells are not
 *  fields; their children are. */
export function sectionFields(s: Section): FormField[] {
  const flat = (fs: FormField[] | undefined): FormField[] =>
    (fs ?? []).flatMap((f) => (f.controlType === "fieldGroup" ? flat(f.fields) : [f]));
  return [
    ...flat(s.fields),
    ...(s.groups ?? []).flatMap((g) => flat(g.fields)),
    ...(s.subsections ?? []).flatMap((sub) => sub.groups.flatMap((g) => flat(g.fields))),
  ];
}

// --- UDFs (§7.3) --------------------------------------------------------------------------------
const udfEntries = (c: Constraints | undefined) =>
  Object.entries(c ?? {}).filter(([, m]) => m.Udf && m.Type !== "collection");

/** Every UDF as a hidden column: offered in the settings dialog and, being a column, as a hidden
 *  filter in Adapt Filters. */
export const udfColumns = (c: Constraints | undefined, declared: string[] = []): ListColumn[] =>
  udfEntries(c)
    .filter(([key]) => !declared.includes(key))
    .map(([key, m]) => ({
      key, label: m.Label ?? key, type: m.Type, ...(m.Options ? { options: m.Options } : {}), hidden: true, udf: true,
      ...(isIntegerType(m.EdmType) ? { integer: true } : {}),
    }));

/** The auto "User-defined fields" section, or null when the entity has none left undeclared. */
export function udfSection(c: Constraints | undefined, declaredKeys: string[]): Section | null {
  const fields = udfEntries(c).filter(([key]) => !declaredKeys.includes(key)).map(([key]) => ({ key }));
  return fields.length ? resolveSections([{ id: "udf", label: "User-defined fields", fields }], c)[0]! : null;
}

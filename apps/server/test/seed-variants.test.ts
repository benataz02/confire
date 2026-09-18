import { expect, test } from "bun:test";
import { ENTITY_PROFILES } from "../src/entity-profiles.ts";
import { entityVariantDefs } from "../src/seed-variants.ts";

// entityVariantDefs is pure — no db call, so this needs no harness.

test("the object header is a superset of the profile's write allowlist", () => {
  // The object page projects its form through the applied view. If a seeded view could omit a field
  // `editable` names, Edit would offer a save the user cannot reach the field for — and create mode
  // would be unable to send a requiredOnCreate field at all. The web side has a runtime fallback
  // (applyObjectDef's `always`); this keeps the seed from ever needing it.
  for (const [entity, profile] of Object.entries(ENTITY_PROFILES)) {
    const header = new Set(entityVariantDefs(entity).object.header.map((f) => f.name));
    const missing = profile.editable.filter((f) => !header.has(f));
    expect({ entity, missing }).toEqual({ entity, missing: [] });
  }
});

test("the list view stays narrow while the object view widens", () => {
  const { list, object } = entityVariantDefs("Quotations");
  expect(list.select).toEqual(["DocNum", "CardCode", "CardName", "DocDueDate", "NumAtCard"]);
  expect(object.header.length).toBeGreaterThan(list.select.length);
  // Only DocumentLines is laid out, and only with the columns a reader wants.
  expect(object.sections.map((s) => s.id)).toEqual(["DocumentLines"]);
  expect(object.sections[0]!.fields.map((f) => f.name))
    .toEqual(["VisOrder", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"]);
});

test("a non-document entity has no duplicate header fields", () => {
  // titleField/subtitleFields overlap `editable` on most master-data entities — the dedup is why
  // BusinessPartners does not render CardName twice.
  const header = entityVariantDefs("BusinessPartners").object.header.map((f) => f.name);
  expect(header).toEqual([...new Set(header)]);
  expect(header[0]).toBe("CardName");
});

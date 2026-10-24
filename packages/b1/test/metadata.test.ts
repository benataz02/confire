import { expect, test } from "bun:test";
import { parseEntitySchema } from "../src/metadata.ts";

// What a Service Layer before 10.0 FP2608 answers to a scoped, annotated $metadata read: the whole
// document, no Common.Label, no SAPB1.ValidValue (verified on a live b1s/v2, 2026-10-24).
const BARE = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EnumType IsFlags="false" Name="BoStatus" UnderlyingType="Edm.Int32">
    <Member Name="bost_Open" Value="0"/>
    <Member Name="bost_Close" Value="1"/>
  </EnumType>
  <EntityType Name="Document"><Key><PropertyRef Name="DocEntry"/></Key>
    <Property Name="DocEntry" Type="Edm.Int32"/>
    <Property Name="DocumentStatus" Type="SAPB1.BoStatus"/>
  </EntityType>
  <EntityContainer Name="ServiceLayer"><EntitySet EntityType="SAPB1.Document" Name="Quotations"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

test("an unannotated enum keeps its members, so a status still draws as a choice", () => {
  const s = parseEntitySchema(BARE, "Quotations");
  expect(s.fields.find((f) => f.name === "DocumentStatus")?.options).toEqual([
    { value: "0", label: "bost_Open" },
    { value: "1", label: "bost_Close" },
  ]);
  expect(s.fields.find((f) => f.name === "DocEntry")?.label).toBeUndefined();
});

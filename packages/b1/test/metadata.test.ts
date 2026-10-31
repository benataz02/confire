import { expect, test } from "bun:test";
import { parseEntitySchemas } from "../src/metadata.ts";

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
  const [s] = parseEntitySchemas(BARE);
  expect(s!.fields.find((f) => f.name === "DocumentStatus")?.options).toEqual([
    { value: "0", label: "bost_Open" },
    { value: "1", label: "bost_Close" },
  ]);
  expect(s!.fields.find((f) => f.name === "DocEntry")?.label).toBeUndefined();
});

// Beas' $metadata, cut down from hera's (2026-10-30): EDMX 1.0, a lowercase `<key>`, flat primitive
// properties, no labels, enums or navigations, and a set without a key.
const BEAS = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices m:DataServiceVersion="1.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><Schema Namespace="bsl" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
<EntityType Name="WareHouse"><key><PropertyRef Name="WhsCode" /></key><Property Name="WhsCode" Type="Edm.String" Nullable="false" MaxLength="20" Unicode="true" /><Property Name="Active" Type="Edm.Boolean" /><Property Name="OnHand" Type="Edm.Decimal" /></EntityType>
<EntityType Name="System"><Property Name="Version" Type="Edm.String" /></EntityType>
<EntityContainer Name="bslEntities" m:IsDefaultEntityContainer="true"><EntitySet Name="WareHouse" EntityType="bsl.WareHouse"/><EntitySet Name="System" EntityType="bsl.System"/><EntitySet Name="Gone" EntityType="bsl.Gone"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

test("Beas: one parse yields every set, keys from its lowercase <key>, a set without a type left out", () => {
  const all = parseEntitySchemas(BEAS);
  expect(all.map((s) => s.name)).toEqual(["WareHouse", "System"]);
  const wh = all[0]!;
  expect(wh.keys).toEqual(["WhsCode"]);
  expect(wh.fields.map((f) => [f.name, f.kind])).toEqual([["WhsCode", "string"], ["Active", "boolean"], ["OnHand", "number"]]);
  expect(all[1]!.keys).toEqual([]);
});

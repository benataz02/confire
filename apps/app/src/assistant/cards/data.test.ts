import { expect, test } from "bun:test";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { configItems, documentItems, openAllOf, requestItems } from "./data.ts";

// Tool output → card rows (pure). A row links only where its reader may go, and "Open all" carries
// the filters the list can show.

const t = (k: string) => k;
const row = (p: Partial<{ id: string; name: string; status: string; customerName: string; modelName: string }> = {}) =>
  ({ id: "p1", name: "ACME – Bracket", status: "draft", customerName: "ACME", modelName: "Bracket", updatedAt: new Date(0), ...p });

test("configuration rows: status text and state, link, total", () => {
  const d = configItems({ rows: [row({ status: "in_review" })] as never, total: 40, nextSkip: 20 }, t);
  expect(d.items[0]).toMatchObject({
    title: "ACME – Bracket", description: "ACME · Bracket", info: "UI_STATUS_IN_REVIEW",
    infoState: PROJECT_STATUS.in_review.state, link: { to: "/configs/p1" },
  });
  expect(d.total).toBe(40);
});

test("request rows open the configuration process page", () => {
  const d = requestItems({ rows: [{ id: "r1", name: "Kabel", status: "submitted", cardName: "Kunde", modelName: "Cable" }] as never, total: 1, nextSkip: undefined }, t);
  expect(d.items[0]).toMatchObject({ title: "Kabel", description: "Kunde · Cable", link: { to: "/configs/r1" } });
});

test("document items link only where the reader may open them", () => {
  const out = { rows: [{ DocEntry: 7, DocNum: 1007, CardName: "ACME", DocTotal: 1200, DocCurrency: "EUR", DocumentStatus: "bost_Open" }], total: 1 };
  expect(documentItems("Quotations", out, () => true, t).items[0]!.link).toEqual({ to: "/b1/Quotations/7" });
  expect(documentItems("Quotations", out, () => false, t).items[0]!.link).toBeUndefined();
  expect(documentItems("Quotations", out, () => true, t).items[0]).toMatchObject({ title: "1007", infoState: "Information" });
  const bp = documentItems("BusinessPartners", { rows: [{ CardCode: "C 1", CardName: "ACME" }] }, () => true, t).items[0]!;
  expect(bp).toMatchObject({ title: "ACME", description: "C 1", link: { to: "/b1/BusinessPartners/C%201" } });
});

test("open all carries eq and in filters", () => {
  expect(openAllOf("/b1/Quotations", { filter: [
    { field: "CardCode", op: "eq", value: "C1" }, { field: "DocumentStatus", op: "in", value: ["bost_Open"] },
    { field: "CardName", op: "contains", value: "AC" },
  ], orderby: [], select: [] })).toEqual({ to: "/b1/Quotations", search: { CardCode: "C1", DocumentStatus: "bost_Open" } });
  expect(openAllOf("/configs", { filter: [], orderby: [], select: [], search: "acme" })).toEqual({ to: "/configs", search: { search: "acme" } });
});

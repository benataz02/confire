import { expect, test } from "bun:test";
import type { CrossJoinSpec } from "@confire/b1";
import { furthestSteps } from "../src/doc-chain.ts";

// The portal home's batched walk: one set of crossjoins for many quotations, each document credited
// back to a quotation only through a line base that points into the set asked for.

const doc = (DocEntry: number, DocDate: string, bases: [number, number][]) => ({
  DocEntry, DocNum: DocEntry, DocDate, DocTotal: 0, DocumentStatus: "bost_Open", CardCode: "C1",
  DocumentLines: bases.map(([BaseType, BaseEntry]) => ({ BaseType, BaseEntry })),
});
const STORE: Record<string, ReturnType<typeof doc>[]> = {
  Orders: [doc(10, "2026-10-01", [[23, 1]]), doc(11, "2026-10-02", [[23, 2]]), doc(12, "2026-10-03", [[23, 3]]), doc(19, "2026-10-09", [[23, 99]])],
  DeliveryNotes: [doc(20, "2026-10-05", [[17, 10]])],
  Invoices: [doc(30, "2026-10-07", [[15, 20]]), doc(31, "2026-10-08", [[17, 12]])],
};

/** Answers as mock-agent's /cross-join does: every document of the lead entity paired with each of its
 *  lines, the $filter ignored — so attribution, not the filter, has to keep strangers out. */
const fake = (store = STORE) => {
  let calls = 0;
  return {
    get calls() { return calls; },
    crossJoin: async (spec: CrossJoinSpec) => {
      calls++;
      const lead = spec.entities[0]!;
      const value = (store[lead] ?? []).flatMap((d) => d.DocumentLines.map((l) => ({ [lead]: d, [`${lead}/DocumentLines`]: l })));
      return { status: 200, data: { value } };
    },
  };
};

test("furthestSteps: invoiced via delivery, via order directly, ordered only, nothing", async () => {
  const b1 = fake();
  const r = await furthestSteps(b1, [1, 2, 3, 4]);
  expect(Object.fromEntries(r)).toEqual({
    1: { step: "invoiced", entity: "Invoices", docEntry: 30, docNum: 30, at: "2026-10-07" },
    2: { step: "ordered", entity: "Orders", docEntry: 11, docNum: 11, at: "2026-10-02" },
    3: { step: "invoiced", entity: "Invoices", docEntry: 31, docNum: 31, at: "2026-10-08" },
  });
  expect(b1.calls).toBe(3); // exactly three keys above: order 19 (base 99, never asked for) is attributed to nothing
});

test("furthestSteps: no quotations, no SAP call", async () => {
  const b1 = fake();
  expect((await furthestSteps(b1, [])).size).toBe(0);
  expect(b1.calls).toBe(0);
});

test("furthestSteps: DocEntry is per document type — an unrelated delivery 10 never dates order 10", async () => {
  const b1 = fake({ Orders: [doc(10, "2026-10-01", [[23, 1]])], DeliveryNotes: [doc(10, "2026-12-31", [[17, 77]])] });
  expect(Object.fromEntries(await furthestSteps(b1, [1]))).toEqual({ 1: { step: "ordered", entity: "Orders", docEntry: 10, docNum: 10, at: "2026-10-01" } });
});

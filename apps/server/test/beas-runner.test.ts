import { describe, expect, test } from "bun:test";
import { DirectTransport, type B1Request } from "@confire/b1";
import { runnerFor } from "../src/b1.ts";

// runnerFor's Beas branch: Beas pages only with $top+$skip+$orderby, pads its char columns, and an
// unsorted read cannot be paged at all — so one that is cut short must fail, not cache a stub.
const beasAnswering = (data: unknown) => {
  const calls: B1Request[] = [];
  const beas = new DirectTransport(async (r) => { calls.push(r); return { status: 200, data }; });
  return { calls, run: runnerFor({ b1: beas, beas, companyDb: null }) };
};

describe("runnerFor over Beas", () => {
  test("a sorted read pages with $top, $skip and $orderby, and trims what Beas pads", async () => {
    const { calls, run } = beasAnswering({ value: [{ ResourceId: "ACA_ACABADO         " }] });
    const page = await run("beas", { entitySet: "Resource", orderby: "ResourceId" }, [], { top: 1 });
    expect(calls[0]!.path).toContain("$top=1");
    expect(calls[0]!.path).toContain("$skip=0");
    expect(calls[0]!.path).toContain("$orderby=ResourceId");
    expect(page).toEqual({ rows: [{ ResourceId: "ACA_ACABADO" }], nextSkip: 1 });
  });
  test("an unsorted read that Beas cut short is refused, never cached as the whole table", async () => {
    const { run } = beasAnswering({ value: [{ OperationId: "A" }], "@odata.nextLink": "OperationsCatalog?$skip=1" });
    expect(run("beas", { entitySet: "OperationsCatalog" }, [], {})).rejects.toThrow("Beas sent only part of OperationsCatalog");
  });
  test("an unsorted read Beas answered whole is the table", async () => {
    const { run } = beasAnswering({ value: [{ OperationId: "A" }] });
    expect(await run("beas", { entitySet: "OperationsCatalog" }, [], {})).toEqual({ rows: [{ OperationId: "A" }] });
  });
});

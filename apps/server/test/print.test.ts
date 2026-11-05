import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, sapConnection } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { adoptCompany } from "../src/b1.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// Printing (print spec §5.1): the document's default layout from B1, per customer and document
// type, cached 2 h per company, and the workspace's engine — all on the `/print` the agent gets.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`);

let agent: MockAgent;
beforeAll(() => {
  agent = startMockAgent({
    Quotations: [
      { DocEntry: 1, CardCode: "C1", DocType: "dDocument_Items" },
      { DocEntry: 2, CardCode: "C2", DocType: "dDocument_Items" },
      { DocEntry: 3, CardCode: "C1", DocType: "dDocument_Service" },
    ],
  });
});
afterAll(() => agent.stop());

/** A fresh tenant per test: the layout cache is per tenant, so no test sees another's lookups. */
async function setup() {
  agent.company.db = "SBODEMO";
  for (const k of Object.keys(agent.defaultLayouts)) delete agent.defaultLayouts[k];
  agent.pldLayouts.clear();
  agent.calls.length = 0;
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  const member = await makeUser("member", t.tenantId);
  const print = (docEntry: number) =>
    call(router.entities.print, { entity: "Quotations", docEntry }, { context: { headers: tenantHeaders(t.slug, member.cookie) } });
  return { ...t, print };
}

const printCalls = () => agent.calls.filter((c) => c.route === "/print").map((c) => c.body);
const defaultCalls = () => agent.calls.filter((c) => c.body.entitySet === "ReportLayoutsService_GetDefaultReport").map((c) => c.body.data);

test("prints with the document's default layout and the workspace's engine", async () => {
  const s = await setup();
  agent.defaultLayouts.QUT2 = "QUT20009";
  expect((await s.print(1)).fileName).toBe("Quotations-1.pdf");
  expect(printCalls().at(-1)).toEqual({ entity: "Quotations", docEntry: 1, layout: "QUT20009", engine: "gateway" });
  expect(defaultCalls().at(-1)).toEqual({ ReportParams: { ReportCode: "QUT2", CardCode: "C1" } });
});

test("a customer's own default wins", async () => {
  const s = await setup();
  agent.defaultLayouts.QUT2 = "QUT20009";
  agent.defaultLayouts["QUT2|C2"] = "QUT20011";
  await s.print(2);
  expect(printCalls().at(-1)!.layout).toBe("QUT20011");
});

test("a service document prints with its service layout", async () => {
  const s = await setup();
  await s.print(3);
  expect(defaultCalls().at(-1)).toEqual({ ReportParams: { ReportCode: "QUT1", CardCode: "C1" } });
  expect(printCalls().at(-1)!.layout).toBe("QUT10001");
});

test("the layout is looked up once per 2 hours", async () => {
  const s = await setup();
  try {
    await s.print(1);
    await s.print(1);
    expect(defaultCalls()).toHaveLength(1);
    setSystemTime(new Date(Date.now() + 2 * 3600_000 + 1));
    await s.print(1);
    expect(defaultCalls()).toHaveLength(2);
  } finally {
    setSystemTime();
  }
});

test("a company switch looks the layout up again", async () => {
  const s = await setup();
  await s.print(1);
  agent.company.db = "OTHER";
  await adoptCompany(s.tenantId, "OTHER");
  await s.print(1);
  expect(defaultCalls()).toHaveLength(2);
});

test("a default that is not Crystal is refused, naming it", async () => {
  const s = await setup();
  agent.defaultLayouts.QUT2 = "QUT20009";
  agent.pldLayouts.add("QUT20009");
  const refused = await codeOf(s.print(1));
  expect(refused).toStartWith("PRECONDITION_FAILED: ");
  expect(refused).toContain("QUT20009");
  expect(printCalls()).toHaveLength(0);
});

test("the workspace's engine choice is sent", async () => {
  const s = await setup();
  await db.update(sapConnection).set({ printEngine: "crystal" }).where(eq(sapConnection.tenantId, s.tenantId));
  await s.print(1);
  expect(printCalls().at(-1)!.engine).toBe("crystal");
});

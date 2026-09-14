import { db, configModel, configProject, organization, user } from "@confire/db";
import { eq } from "drizzle-orm";

const [org] = await db.select().from(organization).where(eq(organization.slug, "alumigraf")).limit(1);
const tenantId = org!.id;

const definition = {
  name: "Call-count demo",
  parameters: [
    { key: "size", label: "Size", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S" }, { value: "M" }, { value: "L" }] } } },
    { key: "grade", label: "Grade", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "A" }, { value: "B" }] } } },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "Dimensions", params: ["size", "grade"] }] }] },
  computed: [], constraints: [],
  bom: [{ id: "body", itemCode: '"BODY"', qty: 'size == "S" ? 1 : 2', price: "3", scrapPct: 0 }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "1", ratePerHour: "60" }],
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "BOX" },
  batchDefaults: [10],
};

const [m] = await db.insert(configModel)
  .values({ tenantId, name: definition.name, definition: definition as never })
  .returning({ id: configModel.id });
const [p] = await db.insert(configProject).values({
  tenantId, modelId: m!.id, name: "Call-count demo project", batches: [10],
  customer: { cardCode: "C0001", cardName: "Demo customer" },
  createdBy: (await db.select({ id: user.id }).from(user).where(eq(user.email, "dev@alumigraf.test")).limit(1))[0]!.id,
}).returning({ id: configProject.id });

console.log(`PROJECT ${p!.id}`);
process.exit(0);

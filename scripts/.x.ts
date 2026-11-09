import { db, configModel } from "@confire/db";
import type { ModelDef } from "@confire/config-engine";
import { router } from "../apps/server/src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "../apps/server/test/harness.ts";
const opt = (k: string) => ({ key: k, label: k.toUpperCase(), type: "string" as const, ui: "select" as const,
  domain: { kind: "options" as const, ref: { source: "manual" as const, options: [{ value: "a" }, { value: "b" }] } } });
const keys = ["p1","p2","p3","p4","p5","p6","p7","p8","p9"];
const def: ModelDef = {
  name: "Tall", parameters: keys.map((k) => ({ ...opt(k), mandatory: true, ...(k === "p4" ? {} : { defaultExpr: "\"a\"" }) })),
  structure: { sections: [0,1,2].map((s) => ({ key: `s${s}`, title: `Sec ${s}`, groups: [{ key: `g${s}`, title: "G", params: keys.slice(s*3, s*3+3) }] })) },
  computed: [], constraints: [], bom: [],
  routing: [{ resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" }],
  pricing: { margin: 50, quoteItemCode: "CFG", priceList: 1 }, batchDefaults: [100, 500],
};
const { tenantId, slug } = await makeTenant();
const admin = await makeUser("admin", tenantId);
const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
const [m] = await db.insert(configModel).values({ tenantId, name: def.name, definition: def }).returning({ id: configModel.id });
const { id } = await call(router.configs.create, { modelId: m!.id, name: "Probe", customer: { cardCode: "C1", cardName: "Acme" } }, ctx);
console.log(JSON.stringify({ slug, id, cookie: admin.cookie }));
process.exit(0);

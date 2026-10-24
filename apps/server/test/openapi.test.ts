import { expect, test } from "bun:test";
import { Hono } from "hono";
import { call, type Router } from "@orpc/server";
import { db, configModel, configProject } from "@confire/db";
import { auth } from "../src/auth.ts";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { serve } from "../src/serve.ts";
import { makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// The procedures as plain HTTP under /api/openapi (serve.ts): the docs and spec for signed-in users
// only, and every procedure behind the same builder it has on /rpc.

const app = (r: Router<{ headers: Headers }>) =>
  serve({ auth, router: r, title: "test", routes: new Hono(), spaDist: "/nonexistent", port: 0 });
const req = (a: ReturnType<typeof app>, path: string, init?: RequestInit) =>
  a.fetch(new Request(`http://localhost${path}`, init));

test("spec and docs: signed-in only, and every procedure of both routers converts", async () => {
  const { cookie } = await makeUser();
  for (const [r, path] of [[router, "/configs/calculate"], [portalRouter, "/projects/submit"]] as const) {
    const a = app(r);
    expect((await req(a, "/api/openapi/spec.json")).status).toBe(404); // unmatched, as if not mounted
    expect((await req(a, "/api/openapi")).status).toBe(404);
    const res = await req(a, "/api/openapi/spec.json", { headers: { cookie } });
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { servers: { url: string }[]; paths: Record<string, Record<string, unknown>> };
    expect(spec.servers).toEqual([{ url: "/api/openapi" }]);
    expect(Object.keys(spec.paths[path] ?? {})).toEqual(["post"]);
    const docs = await req(a, "/api/openapi", { headers: { cookie } });
    expect([docs.status, docs.headers.get("content-type")?.startsWith("text/html")]).toEqual([200, true]);
    expect(await docs.text()).toContain("@scalar/api-reference@1.76.0/"); // pinned, never the CDN's newest
  }
});

test("a procedure over HTTP keeps its builder: session, then the membership join", async () => {
  const { tenantId, slug } = await makeTenant();
  const { userId, cookie } = await makeUser("admin", tenantId);
  const other = await makeTenant();
  const a = app(router);
  const me = (headers: Headers) => req(a, "/api/openapi/me", { method: "POST", headers });

  const ok = await me(tenantHeaders(slug, cookie));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toMatchObject({ tenantId, role: "admin", user: { id: userId } });
  expect((await me(tenantHeaders(slug))).status).toBe(401);
  expect((await me(tenantHeaders(other.slug, cookie))).status).toBe(403);
});

// The view is what a future MCP client reads too, so it has to survive JSON as it is: a Set or a
// Map in it would come out of the RPC client and the HTTP API as two different things.
test("a configuration's view is plain JSON: get over /api/openapi is get over RPC", async () => {
  const { tenantId, slug } = await makeTenant();
  const { userId, cookie } = await makeUser("admin", tenantId);
  const [m] = await db.insert(configModel).values({ tenantId, name: TEST_MODEL.name, definition: TEST_MODEL }).returning({ id: configModel.id });
  const [p] = await db.insert(configProject).values({
    tenantId, modelId: m!.id, name: "Plain", customer: { cardCode: "C1", cardName: "Acme" },
    entries: { material: "steel" }, batches: [100, 500], createdBy: userId,
  }).returning({ id: configProject.id });
  const headers = tenantHeaders(slug, cookie);
  await call(router.configs.get, { id: p!.id }, { context: { headers } }); // the first read calculates
  const rpc = await call(router.configs.get, { id: p!.id }, { context: { headers } });
  expect(rpc.candidates.rows.length).toBeGreaterThan(0);
  expect(rpc.form.fields.coated!.defaulted).toBe(true); // what used to be a Set

  headers.set("content-type", "application/json");
  const res = await req(app(router), "/api/openapi/configs/get", { method: "POST", headers, body: JSON.stringify({ id: p!.id }) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(JSON.parse(JSON.stringify(rpc)));
});

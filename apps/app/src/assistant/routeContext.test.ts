import { expect, test } from "bun:test";
import { routeContext } from "./routeContext.ts";

// What the panel tells the server about where it is: the deepest route match, and a configuration
// only on the configuration's own pages.

const m = (routeId: string, params: Record<string, string> = {}) => ({ routeId, params });

test("the deepest match wins", () => {
  expect(routeContext([m("__root__"), m("/$slug", { slug: "acme" }), m("/$slug/requests", { slug: "acme" })]))
    .toEqual({ routeId: "/$slug/requests", params: { slug: "acme" }, projectId: null });
});

test("a configuration's page and its quote page carry the configuration", () => {
  expect(routeContext([m("/$slug"), m("/$slug/configs/$id", { id: "p1" })]).projectId).toBe("p1");
  expect(routeContext([m("/$slug"), m("/$slug/configs/$id_/quote", { id: "p1" })]).projectId).toBe("p1");
});

test("lists and the model builder carry none", () => {
  expect(routeContext([m("/$slug/configs/")]).projectId).toBeNull();
  expect(routeContext([m("/$slug/assistant/")]).projectId).toBeNull();
  expect(routeContext([m("/$slug/assistant/$id", { id: "t1" })]).projectId).toBeNull(); // a chat, not a configuration
  expect(routeContext([m("/$slug/models/$id", { id: "m1" })]).projectId).toBeNull();
  expect(routeContext([])).toEqual({ routeId: "/", params: {}, projectId: null });
});

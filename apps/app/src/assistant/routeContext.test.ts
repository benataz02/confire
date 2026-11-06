import { expect, test } from "bun:test";
import { routeContext, threadInput } from "./routeContext.ts";

// What the panel tells the server about where it is: the deepest route match, and a configuration
// only on the configuration's own pages.

const m = (routeId: string, params: Record<string, string> = {}) => ({ routeId, params });

test("the deepest match wins", () => {
  expect(routeContext([m("__root__"), m("/$slug", { slug: "acme" }), m("/$slug/requests", { slug: "acme" })]))
    .toEqual({ routeId: "/$slug/requests", params: { slug: "acme" }, projectId: null });
});

test("a configuration's page, its form page and its quote page carry the configuration", () => {
  expect(routeContext([m("/$slug"), m("/$slug/configs/$id", { id: "p1" })]).projectId).toBe("p1");
  expect(routeContext([m("/$slug"), m("/$slug/configs/$id_/configuration", { id: "p1" })]).projectId).toBe("p1");
  expect(routeContext([m("/$slug"), m("/$slug/configs/$id_/quote", { id: "p1" })]).projectId).toBe("p1");
});

test("lists and the model builder carry none", () => {
  expect(routeContext([m("/$slug/configs/")]).projectId).toBeNull();
  expect(routeContext([m("/$slug/reports/$id", { id: "r1" })]).projectId).toBeNull();
  expect(routeContext([m("/$slug/models/$id", { id: "m1" })]).projectId).toBeNull();
  expect(routeContext([])).toEqual({ routeId: "/", params: {}, projectId: null });
});

test("a chat picked in the drawer wins over the page's", () => {
  expect(threadInput({ picked: "t9", projectId: "p1", reportId: null, reportThread: undefined })).toEqual({ id: "t9" });
});
test("a configuration's page opens its configuration's chat", () => {
  expect(threadInput({ picked: null, projectId: "p1", reportId: null, reportThread: undefined })).toEqual({ projectId: "p1" });
});
test("a report's page opens its report's chat, and waits while the report loads", () => {
  expect(threadInput({ picked: null, projectId: null, reportId: "r1", reportThread: "t1" })).toEqual({ id: "t1" });
  expect(threadInput({ picked: null, projectId: null, reportId: "r1", reportThread: undefined })).toBeNull();
});
test("a report that cannot be read, or any other page, opens the latest general chat", () => {
  expect(threadInput({ picked: null, projectId: null, reportId: "r1", reportThread: null })).toEqual({});
  expect(threadInput({ picked: null, projectId: null, reportId: null, reportThread: undefined })).toEqual({});
});

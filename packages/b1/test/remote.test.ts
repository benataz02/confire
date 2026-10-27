import { afterAll, expect, test } from "bun:test";
import { agentPost } from "../src/remote.ts";

// What the tunnel hands back: the agent's 424 envelope untouched, or Cloudflare's own HTML page.
const server = Bun.serve({
  port: 0,
  fetch: (req) => new URL(req.url).pathname === "/beas/request"
    ? Response.json({ error: {
      status: 401, code: 401, message: "Login Fail: Wrong user, wrong password, wrong station passord",
      call: "POST https://sap:8080/beas/Login", body: `{"error":{"code":401,"message":{"lang":"en-us","value":"Login Fail: …"}}}`,
    } }, { status: 424 })
    : new Response(`<!DOCTYPE html><html><head><title>confire.app | 502: Bad gateway</title></head><body>…</body></html>`, { status: 502, headers: { "Content-Type": "text/html" } }),
});
afterAll(() => server.stop());
const target = { agentUrl: server.url.href, secret: "s" };

test("a SAP failure arrives as SAP's own status and sentence", async () => {
  await expect(agentPost(target, "/beas/request", { method: "GET", path: "Items" })).rejects
    .toMatchObject({ status: 401, message: "Login Fail: Wrong user, wrong password, wrong station passord" });
});

test("an HTML error page is its title, not the page", async () => {
  await expect(agentPost(target, "/b1/request", { method: "GET", path: "Items" })).rejects
    .toMatchObject({ status: 502, message: "Agent error 502: confire.app | 502: Bad gateway" });
});

/**
 * Dev only: pair a real SAP server with the dev server. The box has to reach Confire once — for
 * `POST /api/agent/pair`, and to download the exe; after that every call goes from the dev server
 * out through the box's own tunnel. This opens exactly those two routes, which production serves
 * publicly anyway, on 127.0.0.1:3999, for a Cloudflare quick tunnel to publish for the minutes it
 * takes:
 *
 *   bun scripts/pair-relay.ts          and   cloudflared tunnel --url http://localhost:3999
 *   on the SAP server: https://<the trycloudflare.com URL>/download/confire-agent.exe, then in an
 *   administrator prompt:  confire-agent.exe setup --server https://<the trycloudflare.com URL>
 *
 * Stop both once the wizard says "Tunnel… ✓ connected". The dev server needs the CF_* env of
 * DEPLOY.md §8, or it pairs the box with a localhost URL it cannot use.
 */
const OPEN = new Set(["POST /api/agent/pair", "GET /download/confire-agent.exe"]);

Bun.serve({
  hostname: "127.0.0.1",
  port: 3999,
  idleTimeout: 120, // provisioning the tunnel takes a few Cloudflare calls
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (!OPEN.has(`${req.method} ${pathname}`)) return new Response("Not here.\n", { status: 404 });
    console.log(new Date().toISOString(), req.method, pathname);
    return fetch(`http://localhost:3000${pathname}`, {
      method: req.method,
      headers: { "Content-Type": req.headers.get("content-type") ?? "application/json" },
      body: req.method === "POST" ? await req.text() : undefined,
    });
  },
});
console.log("pair relay on http://127.0.0.1:3999 → :3000 (pairing and download only)");

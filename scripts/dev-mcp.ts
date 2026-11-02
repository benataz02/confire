// Dev only (`bun run dev`): the MCP connector address is http://mcp.localhost (tenant.ts `mcpUrl`), which
// is port 80; this forwards it, Host kept, to the staff server on :3000, which serves MCP on that host
// (mcp.ts). Production needs none of it: Caddy's mcp.<DOMAIN> site proxies to the staff process.
const forward = (req: Request) => {
  const to = new URL(req.url);
  to.protocol = "http:";
  to.hostname = "127.0.0.1";
  to.port = "3000";
  return fetch(new Request(to, req), { redirect: "manual" });
};

try {
  // mcp.localhost resolves to ::1 and 127.0.0.1; listen on both, and on nothing else.
  for (const hostname of ["127.0.0.1", "::1"]) Bun.serve({ hostname, port: 80, fetch: forward });
  console.log("[mcp] http://mcp.localhost -> http://127.0.0.1:3000");
} catch (e) {
  console.log(`[mcp] cannot listen on port 80 (${(e as Error).message}), so http://mcp.localhost is down. Once:
  echo net.ipv4.ip_unprivileged_port_start=80 | sudo tee /etc/sysctl.d/50-unprivileged-port-80.conf && sudo sysctl --system`);
}

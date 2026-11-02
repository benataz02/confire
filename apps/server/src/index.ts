import { auth } from "./auth.ts";
import { router } from "./orpc/router.ts";
import { authUrl } from "./tenant.ts";
import { serve } from "./serve.ts";
import { fileRoutes } from "./files.ts";
import { agentRoutes } from "./agent-pairing.ts";
import { assistantFileRoutes } from "./assistant/files.ts";
import { assistantRoutes } from "./assistant/route.ts";
import { isMcpHost, mcpHost, oauthDiscoveryRoutes } from "./mcp.ts";

// The internal app's process (app.<domain>), which also answers the MCP host (mcp.<domain>, mcp.ts) —
// split off first, so a request for it never reaches the staff app. The customer portal is portal/index.ts.
const app = serve({
  auth,
  router,
  title: "Confire staff API",
  routes: fileRoutes("internal").route("/", agentRoutes()).route("/", assistantFileRoutes()).route("/", assistantRoutes()).route("/", oauthDiscoveryRoutes()),
  spaDist: "../app/dist",
  port: 3000,
  origin: authUrl,
});

export default { ...app, fetch: (req: Request) => (isMcpHost(req) ? mcpHost.fetch(req) : app.fetch(req)) };

import { Hono } from "hono";
import { auth } from "../auth.ts";
import { portalRouter } from "./orpc/router.ts";
import { portalUrl } from "../tenant.ts";
import { serve } from "../serve.ts";
import { fileRoutes } from "../files.ts";
import { demoRoutes } from "../demo-request.ts";

// The customer portal's process (portal.<domain>, spec §3): its own event loop, so external traffic
// never shares one with internal users. Same image as the internal server, a second CMD. It mounts
// the one Better Auth instance too, so a portal page signs out against its own origin. It also takes
// the marketing site's demo form (demo-request.ts): Caddy sends the apex's /api/demo-request here.
export default serve({
  auth,
  router: portalRouter,
  title: "Confire portal API",
  routes: new Hono().route("/", fileRoutes("external")).route("/", demoRoutes()),
  spaDist: "../portal/dist",
  port: 3001,
  origin: portalUrl,
});

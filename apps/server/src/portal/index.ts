import { auth } from "../auth.ts";
import { portalRouter } from "./orpc/router.ts";
import { serve } from "../serve.ts";
import { fileRoutes } from "../files.ts";

// The customer portal's process (portal.<domain>, spec §3): its own event loop, so external traffic
// never shares one with internal users. Same image as the internal server, a second CMD. It mounts
// the one Better Auth instance too, so a portal page signs out against its own origin.
export default serve({
  auth,
  router: portalRouter,
  title: "Confire portal API",
  routes: fileRoutes("external"),
  spaDist: "../portal/dist",
  port: 3001,
});

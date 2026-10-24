import { auth } from "./auth.ts";
import { router } from "./orpc/router.ts";
import { serve } from "./serve.ts";
import { fileRoutes } from "./files.ts";
import { agentRoutes } from "./agent-pairing.ts";

// The internal app's process (app.<domain>). The customer portal is portal/index.ts.
export default serve({
  auth,
  router,
  title: "Confire staff API",
  routes: fileRoutes("internal").route("/", agentRoutes()),
  spaDist: "../app/dist",
  port: 3000,
});

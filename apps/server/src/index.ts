import { auth } from "./auth.ts";
import { router } from "./orpc/router.ts";
import { serve } from "./serve.ts";
import { fileRoutes } from "./files.ts";

// The internal app's process (app.<domain>). The customer portal is portal/index.ts.
export default serve({
  auth,
  router,
  files: fileRoutes("internal"),
  spaDist: "../app/dist",
  port: 3000,
});

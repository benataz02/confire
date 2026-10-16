import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Router } from "@orpc/server";
import { RPCHandler, BodyLimitPlugin } from "@orpc/server/fetch";

/**
 * One process's HTTP surface: Better Auth on /api/auth, oRPC on /rpc, the built SPA on everything
 * else. The internal server (index.ts) and the customer portal (portal/index.ts) are the same shape
 * over their own auth instance, router and SPA — one function, so the body cap cannot drift apart.
 */
export function serve({ auth, router, spaDist, port }: {
  auth: { handler: (request: Request) => Promise<Response> };
  router: Router<any, { headers: Headers }>;
  /** the built SPA. In dev the SPA runs on Vite and proxies /rpc + /api here instead. */
  spaDist: string;
  port: number;
}) {
  const app = new Hono();
  // Streams the body and rejects (PAYLOAD_TOO_LARGE) as soon as the running byte count
  // crosses the cap — before the request body is ever fully buffered/parsed.
  const rpc = new RPCHandler(router, { plugins: [new BodyLimitPlugin({ maxBodySize: 2 * 1024 * 1024 })] });

  // Layer 1 identity — Better Auth owns /api/auth/*.
  app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

  // oRPC — browser session procedures.
  app.use("/rpc/*", async (c, next) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: { headers: c.req.raw.headers },
    });
    if (matched) return c.newResponse(response.body, response);
    await next();
  });

  app.use("/*", serveStatic({ root: spaDist }));
  app.get("/*", serveStatic({ path: `${spaDist}/index.html` }));

  return { port, fetch: app.fetch };
}

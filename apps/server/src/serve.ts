import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { onError, ORPCError, type Router } from "@orpc/server";
import { RPCHandler, BodyLimitPlugin } from "@orpc/server/fetch";
import * as Sentry from "@sentry/bun";

/**
 * One process's HTTP surface: Better Auth on /api/auth, oRPC on /rpc, the built SPA on everything
 * else. The internal server (index.ts) and the customer portal (portal/index.ts) are the same shape
 * over their own auth instance, router and SPA — one function, so the body cap cannot drift apart.
 */
export function serve({ auth, router, routes, spaDist, port }: {
  auth: { handler: (request: Request) => Promise<Response> };
  router: Router<any, { headers: Headers }>;
  /** plain routes: /files/* (files.ts) — uploads past the RPC body cap, downloads as attachments —
   *  and on the staff process the agent's /api/agent/pair and /download (agent-pairing.ts) */
  routes: Hono;
  /** the built SPA. In dev the SPA runs on Vite and proxies /rpc + /api here instead. */
  spaDist: string;
  port: number;
}) {
  const app = new Hono();
  // Streams the body and rejects (PAYLOAD_TOO_LARGE) as soon as the running byte count
  // crosses the cap — before the request body is ever fully buffered/parsed.
  const rpc = new RPCHandler(router, {
    plugins: [new BodyLimitPlugin({ maxBodySize: 2 * 1024 * 1024 })],
    // The raw error, before oRPC flattens it into a response that logs nothing. An ORPCError below 500
    // is an answer (UNAUTHORIZED, NOT_FOUND, a validation BAD_REQUEST); anything else is a bug or an
    // outage — B1/agent failures arrive as BAD_GATEWAY/SERVICE_UNAVAILABLE (b1.ts toOrpcError).
    interceptors: [onError((e) => {
      if (!(e instanceof ORPCError) || e.status >= 500) Sentry.captureException(e);
    })],
  });

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

  app.route("/", routes);

  app.use("/*", serveStatic({ root: spaDist }));
  app.get("/*", serveStatic({ path: `${spaDist}/index.html` }));

  return { port, fetch: app.fetch };
}

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { COMMON_ERROR_STATUS_MAP, onError, ORPCError, type Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestLimitHandlerPlugin } from "@orpc/server/plugins";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins";
import * as Sentry from "@sentry/bun";
import type { auth as Auth } from "./auth.ts";
import { TENANT_HEADER } from "./tenant.ts";

/** The HTTP status an ORPCError answers with: the handlers' default map (v2 dropped `error.status`;
 *  a code missing from the map answers 400). */
export const errorStatus = (e: ORPCError<string, unknown>): number =>
  COMMON_ERROR_STATUS_MAP[e.code as keyof typeof COMMON_ERROR_STATUS_MAP] ?? 400;

const MAX_BODY = 2 * 1024 * 1024;
const OPENAPI_PREFIX = "/api/openapi";

/**
 * One process's HTTP surface: Better Auth on /api/auth, oRPC on /rpc (and as plain HTTP under
 * /api/openapi), the built SPA on everything else. The internal server (index.ts) and the customer
 * portal (portal/index.ts) are the same shape over their own router and SPA — one function, so the
 * body cap cannot drift apart.
 */
export function serve({ auth, router, title, routes, spaDist, port }: {
  auth: typeof Auth;
  router: Router<{ headers: Headers }>;
  /** the OpenAPI document's title */
  title: string;
  /** plain routes: /files/* (files.ts) — uploads past the RPC body cap, downloads as attachments —
   *  and on the staff process the agent's /api/agent/pair and /download (agent-pairing.ts) */
  routes: Hono;
  /** the built SPA. In dev the SPA runs on Vite and proxies /rpc + /api here instead. */
  spaDist: string;
  port: number;
}) {
  const app = new Hono();
  // The raw error, before oRPC flattens it into a response that logs nothing. An ORPCError below 500
  // is an answer (UNAUTHORIZED, NOT_FOUND, a validation BAD_REQUEST); anything else is a bug or an
  // outage — B1/agent failures arrive as BAD_GATEWAY/SERVICE_UNAVAILABLE (b1.ts toOrpcError).
  const report = (e: unknown) => {
    if (!(e instanceof ORPCError) || errorStatus(e) >= 500) Sentry.captureException(e);
  };
  // Streams the body and rejects (PAYLOAD_TOO_LARGE) as soon as the running byte count
  // crosses the cap — before the request body is ever fully buffered/parsed. One per handler.
  const rpc = new RPCHandler(router, {
    plugins: [new RequestLimitHandlerPlugin({ maxBodySize: MAX_BODY })],
    interceptors: [onError(report)],
  });

  // The same procedures as plain HTTP, for people reading or trying the API: `configs.calculate` is
  // POST /api/openapi/configs/calculate with a JSON body, and the docs page (Scalar) is the prefix
  // itself. Same builders, same session cookie + x-tenant, so it reaches nothing /rpc does not.
  // The docs and spec are for signed-in users only; the procedures guard themselves as always.
  // It also parses form bodies, which a cross-site <form> could POST — but the session cookie is
  // SameSite=Lax (Better Auth's default), so such a request arrives signed out.
  // ponytail: router-derived paths and no API keys; a public REST API (curated `openapi({ path })`
  // routes, per-tenant keys) builds on this handler when an outside caller exists.
  const generator = new OpenAPIGenerator();
  const openapi = new OpenAPIHandler(router, {
    plugins: [
      new RequestLimitHandlerPlugin({ maxBodySize: MAX_BODY }),
      new OpenAPIReferenceHandlerPlugin({
        spec: () => generator.generate(router, {
          base: {
            info: { title, version: process.env.SENTRY_RELEASE ?? "dev" },
            servers: [{ url: OPENAPI_PREFIX }],
            components: {
              securitySchemes: {
                session: { type: "apiKey", in: "cookie", name: "better-auth.session_token",
                  description: "Better Auth's session cookie: sign in to the app in this browser." },
                tenant: { type: "apiKey", in: "header", name: TENANT_HEADER,
                  description: "The workspace (staff) or supplier (portal) slug: the page's first path segment." },
              },
            },
            security: [{ session: [], tenant: [] }],
          },
        }),
        allow: async ({ context }) => (await auth.api.getSession({ headers: context.headers })) !== null,
        // The docs page runs on this origin, as the signed-in user: the plugin's default is whatever
        // @scalar/api-reference is newest on the CDN, so pin a version (npm never republishes one).
        // ponytail: CDN-hosted; serve the bundle ourselves (@scalar/api-reference's
        // dist/browser/standalone.js) if a third-party host on this origin ever becomes unacceptable.
        providerScriptUrl: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js",
      }),
    ],
    interceptors: [onError(report)],
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
  app.use(`${OPENAPI_PREFIX}/*`, async (c, next) => {
    const { matched, response } = await openapi.handle(c.req.raw, {
      prefix: OPENAPI_PREFIX,
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

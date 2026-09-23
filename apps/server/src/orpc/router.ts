import { variantsRouter } from "./routers/variants.ts";
import { modelsRouter } from "./routers/models.ts";
import { masterdataRouter } from "./routers/masterdata.ts";
import { configsRouter } from "./routers/configs.ts";
import { portalClientsRouter, portalRouter } from "./routers/portal.ts";
import { dashboardRouter } from "./routers/dashboard.ts";
import { entitiesRouter } from "./routers/entities.ts";
import { sapRouter } from "./routers/sap.ts";
import { sessionProcedure, membershipFromHost } from "./base.ts";
import { tenantCurrency } from "../b1.ts";

export const router = {
  // Who am I on this tenant subdomain? One call answers all three questions the app shell asks:
  // signed in (UNAUTHORIZED), member of this workspace (FORBIDDEN — the membership join IS the
  // check), and with what role. sessionProcedure, not userProcedure: portal (client-role)
  // accounts need this too, and userProcedure fences them out.
  //
  // `currency` rides along because it answers a fourth shell-wide question — what unit is every
  // money figure in — and this is the one call already primed in _authed.beforeLoad and cached
  // staleTime: Infinity. It is null when SAP has never been reachable; tenantCurrency never throws,
  // so an agent that is down costs a symbol, not the app shell.
  me: sessionProcedure.handler(async ({ context }) => {
    const membership = await membershipFromHost(context.headers, context.user.id);
    return { ...membership, user: context.user, currency: await tenantCurrency(membership.tenantId) };
  }),
  variants: variantsRouter,
  models: modelsRouter,
  masterdata: masterdataRouter,
  configs: configsRouter,
  portal: portalRouter,
  portalClients: portalClientsRouter,
  dashboard: dashboardRouter,
  entities: entitiesRouter,
  sap: sapRouter,
};

export type AppRouter = typeof router;

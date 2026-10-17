import "@confire/ui/global.css";
import "@ui5/webcomponents-react/dist/Assets.js";
import "@ui5/webcomponents-icons/dist/AllIcons.js"; // ponytail: the whole icon set, as in apps/web — per-icon imports if bundle size bites
import { Modals, ThemeProvider } from "@ui5/webcomponents-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { RouteError, RouteNotFound } from "@confire/ui/Boundaries.tsx";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { UiSourceProvider, type UiSource } from "@confire/ui/source.tsx";
import { routeTree } from "./routeTree.gen.ts";
import { client, meQuery, orpc } from "./orpc.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => (err as { code?: string }).code !== "UNAUTHORIZED" && n < 3,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: RouteNotFound,
});

// What the @confire/ui shells read and write, over the portal's own procedures (spec P1's seam): the
// configurator's value help pages `projects.queryPage` (fenced to the client's models), and views
// are the portal's — personal only.
// ponytail: no B1 entity source until P5's documents; the stub answers every entity read with an
// error, and nothing in P4 asks (the configurator's value helps are masterdata sources).
const noEntities = createTanstackQueryUtils({
  entities: Object.fromEntries(["metadata", "one", "create", "update", "rows", "neighbor"].map((k) => [k, () => {
    throw new Error("SAP documents arrive on the portal with P5");
  }])),
} as never) as unknown as { entities: UiSource["orpc"]["entities"] & UiSource["client"]["entities"] };

const uiSource: UiSource = {
  client: { entities: noEntities.entities, configs: { queryPage: client.projects.queryPage } },
  orpc: { entities: noEntities.entities, views: orpc.views },
  useRole: () => useQuery(meQuery).data?.company?.role,
  useCurrency: () => useQuery(meQuery).data?.currency ?? undefined,
};

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Modals />
      <QueryClientProvider client={queryClient}>
        <UiSourceProvider value={uiSource}>
          <RouterProvider router={router} />
        </UiSourceProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

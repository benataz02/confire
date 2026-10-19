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
// configurator's value help pages `projects.queryPage` (fenced to the client's models), views are
// the portal's — personal only — and the B1 entity reads are `docs.*` (§13.1), the company's own
// documents cut to the tenant's field list. The shapes mirror entities.*, so ListReport, ObjectPage
// and useDetailView run unchanged; nothing on the portal writes to SAP.
const readOnly = () => { throw new Error("Documents are read-only on the portal"); };
const docsClient = {
  metadata: client.docs.metadata, one: client.docs.one, rows: client.docs.rows, print: client.docs.print,
  create: readOnly, update: readOnly, neighbor: readOnly,
};
// The client side is called directly (PrintActions, record navigation); the orpc side builds query
// options and keys. Cast: docs.one takes a number key where entities.one takes any Key.
const docs = createTanstackQueryUtils({ entities: docsClient } as never) as unknown as { entities: UiSource["orpc"]["entities"] };

const uiSource: UiSource = {
  client: { entities: docsClient as unknown as UiSource["client"]["entities"], configs: { queryPage: client.projects.queryPage } },
  orpc: { entities: docs.entities, views: orpc.views },
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

import "@confire/ui/global.css";
import "@ui5/webcomponents-react/dist/Assets.js";
import "@ui5/webcomponents-icons/dist/AllIcons.js"; // registers the SAP-icons-v5 glyph loader (horizon); Assets.js only loads icon i18n. ponytail: AllIcons pulls the whole set — switch to per-icon imports if bundle size bites
import "./i18n.ts"; // registers the texts and restores the chosen language before UI5 renders anything
import { Modals, ThemeProvider } from "@ui5/webcomponents-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";
import { RouteError, RouteNotFound } from "@confire/ui/Boundaries.tsx";
import { UiSourceProvider, type UiSource } from "@confire/ui/source.tsx";
import { client, meQuery, orpc, useCurrency } from "./orpc.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => (err as { code?: string }).code !== "UNAUTHORIZED" && n < 3,
    },
  },
});

const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  // Router-wide floor; a route can still set its own errorComponent/notFoundComponent.
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: RouteNotFound,
});

// What the List Report / Object Page / value-help shells in @confire/ui read and write: this app's
// own router, so their query keys are the ones the rest of the app seeds and invalidates.
const uiSource: UiSource = { client, orpc, useRole: () => useQuery(meQuery).data?.role, useCurrency };

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      {/* Host for the imperative Modals.showToast / showMessageBox helpers (confirm.ts, toast.ts). */}
      <Modals />
      <QueryClientProvider client={queryClient}>
        <UiSourceProvider value={uiSource}>
          <RouterProvider router={router} />
        </UiSourceProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

// Bare root: the apex auth pages render full-bleed; the supplier shell lives in `_authed`.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

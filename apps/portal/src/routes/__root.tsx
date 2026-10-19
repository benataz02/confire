import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

// Bare root: the pages before a seat (an invitation, the invite-only page) render full-bleed; the
// supplier shell lives in `_authed`.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

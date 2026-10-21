import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";

export interface RouterContext {
  queryClient: QueryClient;
}

// Bare shell so auth screens (login/signup/onboarding) can render full-bleed; the workspace's chrome
// and its auth gate are the `$slug` route.
export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />
});

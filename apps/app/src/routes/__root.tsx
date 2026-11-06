import { createRootRouteWithContext, HeadContent, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { title } from "../head.ts";

export interface RouterContext {
  queryClient: QueryClient;
}

// Bare shell so auth screens (login/signup/onboarding) can render full-bleed; the workspace's chrome
// and its auth gate are the `$slug` route. HeadContent draws the deepest route's `head` title; React
// hoists it into <head> ahead of index.html's static one, which only shows before the bundle runs.
export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => title(),
  component: () => (
    <>
      <HeadContent />
      <Outlet />
    </>
  ),
});

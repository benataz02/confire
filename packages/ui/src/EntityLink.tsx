import { useCallback, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Link } from "@ui5/webcomponents-react";
import { useUiSource } from "./source.tsx";
import { canOpenRoute, entityPath } from "./navigation.ts";

/** Whether this user may open a route — `/b1/*` is every staff member's, not a portal seat's. */
export function useCanOpen(): (route: string) => boolean {
  const role = useUiSource().useRole();
  return useCallback((route: string) => canOpenRoute(route, role), [role]);
}

/** Navigate to a route a page declares (`/b1/Quotations`), or its record by key — every shell's way
 *  to a page. Declared routes are the tenant's, so the path goes under `/$slug`, which the router
 *  fills from the current params. Built at runtime, so the typed route tree cannot check it. */
export function useEntityNav() {
  const navigate = useNavigate();
  return useCallback((route: string, key?: unknown, hash?: string) => {
    void navigate({ to: `/$slug${key === undefined ? route : entityPath(route, key)}` as string, hash });
  }, [navigate]);
}

/**
 * The key-navigation link: the `navigation-right-arrow` cue, then the value. The click stops
 * propagating, so inside a list row it opens the referenced record, not the row's own.
 */
export function EntityLink({ route, target, action, value, children }: {
  route?: string;
  /** the key the route opens */
  target: string;
  action?: (value: unknown) => void;
  value?: unknown;
  children: ReactNode;
}) {
  const go = useEntityNav();
  const open = (e: { stopPropagation: () => void; preventDefault?: () => void }) => {
    e.stopPropagation();
    e.preventDefault?.();
    if (action) action(value);
    else if (route) go(route, target);
  };
  return (
    <Link icon="navigation-right-arrow" wrappingType="None" className="confire-entity-link"
      onClick={open} onKeyDown={(e) => { if (e.key === "Enter") open(e); }}>
      {children}
    </Link>
  );
}

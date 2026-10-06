import { useCallback, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Link } from "@ui5/webcomponents-react";
import { meQuery } from "../orpc.ts";
import { canOpenRoute, entityPath } from "./navigation.ts";

/** Whether this user may open a route — `/b1/*` is admin-only. */
export function useCanOpen(): (route: string) => boolean {
  const role = useQuery(meQuery).data?.role;
  return useCallback((route: string) => canOpenRoute(route, role), [role]);
}

/** Navigate to an entity's detail page by route + key. `href`, not `to`: the path is built at
 *  runtime, which the typed route tree cannot check — the blockers still see it. */
export function useEntityNav() {
  const navigate = useNavigate();
  return useCallback((route: string, key?: unknown) => {
    void navigate({ href: key === undefined ? route : entityPath(route, key) });
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

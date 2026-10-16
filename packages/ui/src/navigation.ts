import type { LinkConfig, Row } from "./types.ts";

// NavigationService (VALUE-HELP-AND-KEY-NAVIGATION.md §7). Every link, list row click, record
// navigation and create-then-view builds its path here, so the convention — the detail route is
// `<listRoute>/<key>` — lives in one place.

/** `/<route>/<key>`. A string key is trimmed; a composite key travels as JSON so one route param
 *  carries every half (the detail route's parseKeyParam reads it back). */
export function entityPath(route: string, key: unknown): string {
  const seg = key !== null && typeof key === "object" ? JSON.stringify(key) : String(key ?? "").trim();
  return `${route.replace(/\/$/, "")}/${encodeURIComponent(seg)}`;
}

/** The value a link opens: `row[idField]` when the link names one, else the value itself. */
export function linkValue(value: unknown, link: LinkConfig, row?: Row): string {
  const v = link.idField ? row?.[link.idField] : value;
  return v === null || v === undefined ? "" : String(v).trim();
}

/**
 * When a key field shows its link (§7a): a link is configured, it has somewhere to go (an action,
 * or a route of its own or the value help's), the value is non-empty, and the value is not one the
 * existence probe already found missing. Multi-select fields never get here.
 */
export function showLink(o: {
  link: true | LinkConfig | undefined;
  dialogRoute?: string;
  value: unknown;
  row?: Row;
  missingValue?: unknown;
  canOpen?: (route: string) => boolean;
}): { route?: string; action?: LinkConfig["action"]; target: string } | null {
  if (!o.link) return null;
  const cfg: LinkConfig = o.link === true ? {} : o.link;
  const route = cfg.route ?? o.dialogRoute;
  if (!cfg.action && !route) return null;
  if (!cfg.action && route && o.canOpen && !o.canOpen(route)) return null;
  const target = linkValue(o.value, cfg, o.row);
  if (!target) return null;
  if (o.missingValue !== undefined && o.missingValue !== null && String(o.value ?? "").trim() === String(o.missingValue).trim())
    return null;
  return { route, action: cfg.action, target };
}

/** `/b1/*` is admin/owner only (the _authed guard), so a link into it is hidden for everyone else
 *  rather than drawn and bounced. */
export const canOpenRoute = (route: string, role: string | undefined): boolean =>
  !route.startsWith("/b1") || role === "admin" || role === "owner";

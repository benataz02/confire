// Where the panel is (assistant spec §4.3): the deepest route match, sent with every message so the
// server picks the page's tools and prompt. Only a configuration's own pages carry it; a report's `$id` is
// a report, whose chat the panel finds through it (`threadInput`).

export type RouteContext = { routeId: string; params: Record<string, string>; projectId: string | null };

/** The routes whose `$id` is a configuration. */
const CONFIGURATION = new Set(["/$slug/configs/$id", "/$slug/configs/$id_/configuration", "/$slug/configs/$id_/quote"]);

export function routeContext(matches: { routeId: string; params: Record<string, string> }[]): RouteContext {
  const deepest = matches.at(-1);
  if (!deepest) return { routeId: "/", params: {}, projectId: null };
  return {
    routeId: deepest.routeId,
    params: deepest.params,
    projectId: CONFIGURATION.has(deepest.routeId) ? deepest.params.id ?? null : null,
  };
}

/** A report's page: the panel shows its report's chat. */
export const REPORT_ROUTE = "/$slug/reports/$id";

/** `assistant.thread`'s input: a chat by id, a configuration's chat, or the latest general one. */
export type ThreadInput = { id: string } | { projectId: string } | Record<string, never>;

/** Which chat the panel shows (Joule spec §5.4): one picked in the drawer, else the page's own (a
 *  configuration's, a report's), else the latest general chat. `reportThread` is undefined while the
 *  report loads and null when it cannot be read; null as the answer means wait. */
export function threadInput(s: { picked: string | null; projectId: string | null; reportId: string | null; reportThread: string | null | undefined }): ThreadInput | null {
  if (s.picked) return { id: s.picked };
  if (s.projectId) return { projectId: s.projectId };
  if (s.reportId && s.reportThread !== null) return s.reportThread === undefined ? null : { id: s.reportThread };
  return {};
}

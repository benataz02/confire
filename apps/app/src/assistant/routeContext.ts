// Where the panel is (assistant spec §4.3): the deepest route match, sent with every message so the
// server picks the page's tools and prompt. Only a configuration's own pages carry it (its AI configuration page too).

export type RouteContext = { routeId: string; params: Record<string, string>; projectId: string | null };

/** The routes whose `$id` is a configuration. */
const CONFIGURATION = new Set(["/$slug/configs/$id", "/$slug/configs/$id_/quote", "/$slug/assistant/$id"]);

export function routeContext(matches: { routeId: string; params: Record<string, string> }[]): RouteContext {
  const deepest = matches.at(-1);
  if (!deepest) return { routeId: "/", params: {}, projectId: null };
  return {
    routeId: deepest.routeId,
    params: deepest.params,
    projectId: CONFIGURATION.has(deepest.routeId) ? deepest.params.id ?? null : null,
  };
}

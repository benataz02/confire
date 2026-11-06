import type { SearchHit } from "./GlobalSearch.tsx";

/** A hit once picked, with the scope it was found under (a group's key up to its `:`). */
export type Recent = SearchHit & { scope: string };

// ponytail: localStorage per workspace, like the model builder's collapsed rows — a ui_user_state
// key only if the history has to follow the user to another browser.
export const recentKey = (slug: string) => `search.recent.${slug}`;

/** The stored list, without what no longer opens: the Chats scope is gone, and its hits led to the
 *  removed AI page (Joule spec §5.1). */
export function parseRecent(raw: string | null): Recent[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((r): r is Recent => typeof r?.to === "string" && typeof r?.text === "string" && r.scope !== "chats")
      : [];
  } catch {
    return [];
  }
}

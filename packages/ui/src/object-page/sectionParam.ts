import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ObjectPagePropTypes } from "@ui5/webcomponents-react";

/**
 * URL-backed anchor tab for `mode="IconTabBar"` ObjectPages: spread `props` onto the ObjectPage and
 * the open section survives a reload, a shared link and Back out of a drilldown. `go` is the same
 * switch from outside the anchor bar — what a message in the title's popover navigates with.
 *
 * Only for IconTabBar mode — in Default mode every section is on one scrolling page, so there is
 * nothing to restore that the browser's own scroll restoration doesn't already do.
 *
 * The route must declare `section` in `validateSearch`, or the param is stripped on navigate.
 *
 * `replace`, not push: the tab bar is a view switch, so Back leaves the object rather than
 * walking back through the tabs the user happened to open.
 */
export function useSectionParam(): {
  props: Pick<ObjectPagePropTypes, "selectedSectionId" | "onSelectedSectionChange">;
  go: (id: string) => void;
} {
  const section = useSearch({ strict: false, select: (s) => (s as { section?: string }).section });
  const navigate = useNavigate();
  // ObjectPage re-fires onSelectedSectionChange when we hand `selectedSectionId` back to it;
  // without the guard that is a navigate per render.
  const go = (next: string) => {
    if (next && next !== section)
      void navigate({ to: ".", search: (prev) => ({ ...prev, section: next }), replace: true });
  };
  return {
    props: {
      selectedSectionId: section,
      onSelectedSectionChange: (e) => go(e.detail.selectedSectionId),
    },
    go,
  };
}

/** `validateSearch` for a route whose page uses {@link useSectionParam}.
 *  The key is optional, not `string | undefined`: a required key would make `search` mandatory on
 *  every `navigate`/`Link` that targets the route. */
export const sectionSearch = (s: Record<string, unknown>): { section?: string } =>
  typeof s.section === "string" ? { section: s.section } : {};

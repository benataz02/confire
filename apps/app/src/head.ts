import I18nBundle from "@ui5/webcomponents-base/dist/i18nBundle.js";

// A route's `head` runs outside React, so it reads the app's bundle directly (its texts are in before
// the router starts: i18n.ts awaits them). ponytail: a language switch shows in the tab title from the
// next navigation on — head re-runs per navigation, not per bundle change.
const bundle = new I18nBundle("@confire/app");
export const t = (key: string, ...args: (string | number)[]) => bundle.getText(key, ...args);

/** The `head` of a page: its title parts, most specific first, then "Confire". The deepest route's
 *  title wins (HeadContent), so a record's names itself over its list's. */
export const title = (...parts: (string | undefined | null)[]) => ({
  meta: [{ title: [...parts, "Confire"].filter(Boolean).join(" · ") }],
});

// The site's one config (spec 2026-10-30 §15). Empty = that feature renders nothing, so choosing a
// value later changes no code.
export const SITE = {
  /** The public contact address: footer, legal notice, the demo error page. Undecided (§15): it
   *  must receive mail, and confire.ai has no MX yet. */
  contactEmail: "",
  /** Plausible's script URL from its dashboard (or a Caddy-proxied path), e.g.
   *  "https://plausible.io/js/script.js". Cookieless: needs no consent (§10). */
  plausibleScript: "",
  /** Meta Events Manager → the Pixel's ID. Loads only after consent. */
  metaPixelId: "",
  /** LinkedIn Campaign Manager → Insight Tag partner ID, and the demo-request conversion's ID. */
  linkedinPartnerId: "",
  linkedinConversionId: "",
  /** Company profile URLs: the footer and Organization.sameAs. */
  social: { linkedin: "", instagram: "" },
};

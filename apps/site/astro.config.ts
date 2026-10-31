import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// The marketing site (spec 2026-10-30): static HTML on SAP's Horizon variables, no framework JS.
// Unlike the SPAs it has a build setting: canonical URLs, hreflang and the sitemap must be absolute.
export default defineConfig({
  site: "https://confire.ai",
  trailingSlash: "always",
  i18n: { defaultLocale: "en", locales: ["en", "es", "eu"], routing: { prefixDefaultLocale: false } },
  integrations: [
    sitemap({
      i18n: { defaultLocale: "en", locales: { en: "en", es: "es", eu: "eu" } },
      // Utility pages are noindex, so they stay out of the sitemap too.
      filter: (page) => !/\/(thanks|demo-error|404)\/$/.test(page),
    }),
  ],
  vite: {
    // The demo form posts here; in production Caddy sends it to the portal process (Caddyfile).
    server: { proxy: { "/api/demo-request": "http://localhost:3001" } },
    // Every script a file of its own, never inlined: the CSP is script-src 'self' (Caddyfile).
    build: { assetsInlineLimit: 0 },
  },
});

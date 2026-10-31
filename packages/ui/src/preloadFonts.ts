// A Vite plugin for both SPAs' builds: preload the 72 weights the sign-in frame draws (Regular, Bold,
// Black), from the very URLs UI5's own @font-face rules use in this bundle. UI5 inserts those rules only
// once its JS has run, and 72 has no font-display, so the text stayed invisible for a beat after the
// frame appeared — the step from confire.ai felt like a page load. Read off the emitted chunks rather
// than written down: the CDN URL carries a theming version that moves with UI5.
// ponytail: build only — dev serves no bundle to read; dev's fonts come from Vite's warm cache anyway.

type Chunk = { type: string; code?: string };

export const preloadFonts = () => ({
  name: "confire-preload-72",
  transformIndexHtml: {
    order: "post" as const,
    handler(_html: string, ctx: { bundle?: Record<string, Chunk> }) {
      const code = Object.values(ctx.bundle ?? {}).map((c) => (c.type === "chunk" ? c.code : "")).join("\n");
      const urls = new Set(code.match(/https:\/\/[^"'`)\s]+\/fonts\/72-(?:Regular|Bold|Black)\.woff2/g));
      return [...urls].map((href) => ({
        tag: "link",
        attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href },
        injectTo: "head" as const,
      }));
    },
  },
});

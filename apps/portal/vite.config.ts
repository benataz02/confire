import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// The customer portal's SPA (spec §3, §9). Same shape as apps/web's config, on its own port:
// http://localhost:5180/<slug>/. The proxy keeps it same-origin with the portal process (:3001), and
// the sign-in host's host-only `localhost` cookie reaches it (cookies ignore ports), so there's no
// CORS to configure.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  resolve: {
    // One React / QueryClient context / UI5 registry with @confire/ui (see apps/web/vite.config.ts).
    dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router", "@ui5/webcomponents-react", "@ui5/webcomponents", "@ui5/webcomponents-base"],
  },
  server: {
    // The portal's origin with no DOMAIN set (tenant.ts, @confire/ui/host.ts). Not 5174/5175: other
    // checkouts of this repo run their own Vite there.
    port: 5180,
    strictPort: true,
    proxy: {
      "/rpc": "http://localhost:3001",
      "/api": "http://localhost:3001",
      "/files": "http://localhost:3001",
    },
  },
});

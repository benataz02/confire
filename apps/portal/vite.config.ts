import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// The customer portal's SPA (spec §3, §9). Same shape as apps/web's config, on its own zone and port:
// http://<slug>.portal.lvh.me:5180. The proxy keeps it same-origin with the portal process (:3001), so
// the `.lvh.me` session cookie set by the sign-in host just works and there's no CORS to configure.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  resolve: {
    // One React / QueryClient context / UI5 registry with @confire/ui (see apps/web/vite.config.ts).
    dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router", "@ui5/webcomponents-react", "@ui5/webcomponents", "@ui5/webcomponents-base"],
  },
  server: {
    // IPv4 bind: lvh.me resolves to 127.0.0.1, and Vite's default `localhost` bind is ::1 on Windows.
    host: true,
    // Not 5174/5175: other checkouts of this repo run their own Vite there.
    port: 5180,
    strictPort: true,
    // Supplier subdomains: acme.portal.lvh.me:5180. Vite blocks unknown hosts.
    allowedHosts: [".lvh.me"],
    proxy: {
      // changeOrigin:false keeps the supplier Host (acme.portal.lvh.me) so the portal process
      // resolves the tenant from it — apps/server/src/portal/orpc/base.ts.
      "/rpc": { target: "http://localhost:3001", changeOrigin: false },
      "/api": { target: "http://localhost:3001", changeOrigin: false },
      "/files": { target: "http://localhost:3001", changeOrigin: false },
    },
  },
});

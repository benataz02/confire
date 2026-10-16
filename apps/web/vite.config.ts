import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// Dev proxy keeps the SPA same-origin with the API, so Better Auth cookies just work
// and there's no CORS to configure. ponytail: proxy over CORS.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  // @confire/ui is a workspace package with its own node_modules. Bun links equal versions to one
  // store entry, but a drifted range would give the shells a second React or QueryClient context
  // (and UI5 a second custom-element registry) — dedupe makes that impossible rather than unlikely.
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router", "@ui5/webcomponents-react", "@ui5/webcomponents", "@ui5/webcomponents-base"],
  },
  server: {
    // Bind IPv4 (0.0.0.0) — lvh.me resolves to 127.0.0.1; Vite's default `localhost` bind is
    // IPv6-only (::1) on Windows, which lvh.me can't reach (connection refused).
    host: true,
    // Tenant subdomains: acme.app.lvh.me:5173 (lvh.me resolves to 127.0.0.1 at any depth, and unlike
    // localhost a `.app.lvh.me` cookie is shared across subdomains). Vite blocks unknown hosts.
    allowedHosts: [".lvh.me", ".localhost"],
    proxy: {
      // changeOrigin:false keeps the tenant Host (acme.app.lvh.me) so the server resolves
      // the tenant from it — see apps/server/src/orpc/base.ts.
      "/rpc": { target: "http://localhost:3000", changeOrigin: false },
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});

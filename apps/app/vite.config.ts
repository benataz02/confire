import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { preloadFonts } from "../../packages/ui/src/preloadFonts.ts";

// Dev proxy keeps the SPA same-origin with the API, so Better Auth cookies just work
// and there's no CORS to configure. ponytail: proxy over CORS.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), preloadFonts()],
  // @confire/ui is a workspace package with its own node_modules. Bun links equal versions to one
  // store entry, but a drifted range would give the shells a second React or QueryClient context
  // (and UI5 a second custom-element registry) — dedupe makes that impossible rather than unlikely.
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-query", "@tanstack/react-router", "@ui5/webcomponents-react", "@ui5/webcomponents", "@ui5/webcomponents-base"],
  },
  server: {
    // http://localhost:5173 is the sign-in host with no DOMAIN set (tenant.ts, @confire/ui/host.ts):
    // its OAuth callbacks and mailed links name this port, so another one would break them.
    port: 5173,
    strictPort: true,
    // Every interface, so a phone on the LAN can open http://<lan-ip>:5173 — host.ts keeps that host
    // for both origins; the server trusts it through BETTER_AUTH_TRUSTED_ORIGINS (auth.ts). IP hosts
    // pass Vite's allowedHosts check by default.
    host: true,
    proxy: {
      "/rpc": "http://localhost:3000",
      "/api": "http://localhost:3000",
      "/files": "http://localhost:3000",
      "/download": "http://localhost:3000",
    },
  },
});

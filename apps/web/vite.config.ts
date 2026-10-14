import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

// Dev proxy keeps the SPA same-origin with the API, so Better Auth cookies just work
// and there's no CORS to configure. ponytail: proxy over CORS.
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react()],
  server: {
    // Bind every interface: Vite's default `localhost` bind is IPv6-only (::1) on Windows, and
    // a tenant host (acme.confire.localhost) may resolve to 127.0.0.1. Vite's host check already
    // allows `*.localhost`, so the tenant subdomains need no allowedHosts entry.
    host: true,
    proxy: {
      // changeOrigin:false keeps the tenant Host (acme.confire.localhost) so the server resolves
      // the tenant from it — see apps/server/src/orpc/base.ts.
      "/rpc": { target: "http://localhost:3000", changeOrigin: false },
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
});

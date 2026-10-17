import { createAuthClient } from "better-auth/react";

// The one Better Auth instance (apps/server/src/auth.ts), which the portal process mounts at /api/auth
// on this origin too — proxied to it in dev. The portal only signs out: signing in is the sign-in
// host's (lib/host.ts loginUrl).
export const authClient = createAuthClient();

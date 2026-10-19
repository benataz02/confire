import { createFileRoute } from "@tanstack/react-router";
import { authUrl, hardRedirect } from "@confire/ui/host.ts";

// The bare portal origin names no supplier: the dispatcher on the sign-in host decides.
export const Route = createFileRoute("/")({
  beforeLoad: () => hardRedirect(authUrl("/login")),
});

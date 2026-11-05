import { createFileRoute } from "@tanstack/react-router";
import { authUrl, guardRedirect } from "@confire/ui/host.ts";

// The bare portal origin names no supplier: the dispatcher on the sign-in host decides.
export const Route = createFileRoute("/")({
  beforeLoad: ({ preload }) => guardRedirect(authUrl("/login"), preload),
});

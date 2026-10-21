import { createFileRoute, redirect } from "@tanstack/react-router";

// The bare origin names no workspace: the dispatcher (/login) decides where the user goes.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/login" });
  },
});

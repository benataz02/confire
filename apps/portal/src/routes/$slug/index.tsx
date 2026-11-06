import { createFileRoute, redirect } from "@tanstack/react-router";

// The slug alone is home's old address: the lobby's portal URLs, mail links and the pages that send a
// customer "back to the portal" still land here, and go on to /<slug>/home.
export const Route = createFileRoute("/$slug/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$slug/home", params });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

// The admin/owner pages: Settings and the SAP Business One pages. UX only — the server's
// adminProcedure is the boundary; this keeps everyone else from opening a page that only refuses.
export const Route = createFileRoute("/$slug/_admin")({
  beforeLoad: ({ context, params }) => {
    if (context.me.role !== "admin" && context.me.role !== "owner") throw redirect({ to: "/$slug", params });
  },
});

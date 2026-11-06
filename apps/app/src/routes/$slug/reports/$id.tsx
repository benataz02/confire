import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { orpc } from "../../../orpc.ts";
import { ReportPage } from "../../../reports/ReportPage.tsx";

// A saved report (Joule spec §5.8): the report alone; its chat is the assistant panel.
export const Route = createFileRoute("/$slug/reports/$id")({
  // As configs/$id: the page's own query, warmed for the title.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(orpc.reports.get.queryOptions({ input: { id: params.id } })).catch(() => undefined),
  head: ({ loaderData }) => title(loaderData?.title, t("HOME_REPORTS")),
  component: Report,
});

function Report() {
  const { id } = Route.useParams();
  return <ReportPage key={id} id={id} />;
}

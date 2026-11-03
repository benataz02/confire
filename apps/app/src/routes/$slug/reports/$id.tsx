import { createFileRoute } from "@tanstack/react-router";
import { ReportPage } from "../../../reports/ReportPage.tsx";

// One of the user's reports, its chat beside it (reports spec §6.2).
export const Route = createFileRoute("/$slug/reports/$id")({ component: Report });

function Report() {
  const { id } = Route.useParams();
  return <ReportPage key={id} id={id} />;
}

import { createFileRoute } from "@tanstack/react-router";
import { TablePage } from "../../../components/model-builder/TablePage.tsx";
import { tableSearch } from "../../../components/model-builder/paramRoute.ts";

export const Route = createFileRoute("/$slug/models/$id/table")({
  validateSearch: tableSearch,
  component: Page,
});

function Page() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  return <TablePage key={search.key} modelId={id} search={search} />;
}

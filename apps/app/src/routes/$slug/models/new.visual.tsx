import { createFileRoute } from "@tanstack/react-router";
import { VisualPage } from "../../../components/model-builder/VisualPage.tsx";
import { tableSearch } from "../../../components/model-builder/paramRoute.ts";

// A visual's search is a table's: the key of one that exists — visuals are added in the tree.
export const Route = createFileRoute("/$slug/models/new/visual")({
  validateSearch: tableSearch,
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  return <VisualPage key={search.key} search={search} />;
}

import { createFileRoute } from "@tanstack/react-router";
import { ParamPage } from "../../../components/model-builder/ParamPage.tsx";
import { paramSearch } from "../../../components/model-builder/paramRoute.ts";

export const Route = createFileRoute("/$slug/models/$id/parameter")({
  validateSearch: paramSearch,
  component: Page,
});

function Page() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  // A duplicate navigates to the copy on this same route. The buffer is useState, so the page
  // remounts on the new key instead of keeping the source's fields.
  return <ParamPage key={search.key ?? "new"} modelId={id} search={search} />;
}

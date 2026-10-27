import { createFileRoute } from "@tanstack/react-router";
import { ParamPage } from "../../../components/model-builder/ParamPage.tsx";
import { paramSearch } from "../../../components/model-builder/paramRoute.ts";

export const Route = createFileRoute("/$slug/models/new/parameter")({
  validateSearch: paramSearch,
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  return <ParamPage key={search.key ?? "new"} search={search} />;
}

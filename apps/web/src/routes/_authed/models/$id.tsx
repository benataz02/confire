import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/model-builder/ModelBuilderPage.tsx";
import { sectionSearch } from "../../../lib/sectionParam.ts";

export const Route = createFileRoute("/_authed/models/$id")({
  validateSearch: sectionSearch,
  component: Builder,
});

function Builder() {
  const { id } = Route.useParams();
  return <ModelBuilderPage key={id} id={id} />;
}

import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/model-builder/ModelBuilderPage.tsx";
import { sectionSearch } from "@confire/ui/object-page/sectionParam.ts";

export const Route = createFileRoute("/$slug/models/$id/")({
  validateSearch: sectionSearch,
  component: Builder,
});

function Builder() {
  return <ModelBuilderPage />;
}

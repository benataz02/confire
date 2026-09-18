import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/model-builder/ModelBuilderPage.tsx";
import { sectionSearch } from "../../../lib/sectionParam.ts";

export const Route = createFileRoute("/_authed/models/new")({
  validateSearch: sectionSearch,
  component: () => <ModelBuilderPage />,
});

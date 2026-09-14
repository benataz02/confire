import { createFileRoute } from "@tanstack/react-router";
import { ModelBuilderPage } from "../../../components/model-builder/ModelBuilderPage.tsx";

export const Route = createFileRoute("/_authed/models/new")({
  component: () => <ModelBuilderPage />,
});

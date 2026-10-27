import { createFileRoute } from "@tanstack/react-router";
import { ModelDraftScope } from "../../../components/model-builder/draftScope.tsx";

export const Route = createFileRoute("/$slug/models/new")({
  component: () => <ModelDraftScope />,
});

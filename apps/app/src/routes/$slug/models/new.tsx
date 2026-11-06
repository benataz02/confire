import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { ModelDraftScope } from "../../../components/model-builder/draftScope.tsx";

export const Route = createFileRoute("/$slug/models/new")({
  head: () => title(t("NAV_MODELS")),
  component: () => <ModelDraftScope />,
});

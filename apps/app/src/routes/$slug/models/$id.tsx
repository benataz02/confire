import { createFileRoute } from "@tanstack/react-router";
import { ModelDraftScope } from "../../../components/model-builder/draftScope.tsx";

export const Route = createFileRoute("/$slug/models/$id")({
  component: Layout,
});

function Layout() {
  const { id } = Route.useParams();
  // The route component is reused when the id changes, and useDraftModel does not reset.
  return <ModelDraftScope key={id} id={id} />;
}

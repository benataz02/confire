import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "../../../orpc.ts";
import { t, title } from "../../../head.ts";
import { ModelDraftScope } from "../../../components/model-builder/draftScope.tsx";

export const Route = createFileRoute("/$slug/models/$id")({
  // As configs/$id: the builder's own query, warmed for the title. Its child pages set none, so it
  // names them too.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(orpc.models.get.queryOptions({ input: { id: params.id } })).catch(() => undefined),
  head: ({ loaderData }) => title(loaderData?.name, t("NAV_MODELS")),
  component: Layout,
});

function Layout() {
  const { id } = Route.useParams();
  // The route component is reused when the id changes, and useDraftModel does not reset.
  return <ModelDraftScope key={id} id={id} />;
}

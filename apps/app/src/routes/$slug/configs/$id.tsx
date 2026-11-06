import { createFileRoute } from "@tanstack/react-router";
import { orpc } from "../../../orpc.ts";
import { t, title } from "../../../head.ts";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

export const Route = createFileRoute("/$slug/configs/$id")({
  // Warms the query the page reads (same key), so the tab can carry the name; a failed read stays the
  // page's own error, not the route's.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(orpc.configs.get.queryOptions({ input: { id: params.id } })).catch(() => undefined),
  head: ({ loaderData }) => title(loaderData?.project.name, t("NAV_CONFIGS")),
  component: Process,
});

function Process() {
  const { id } = Route.useParams();
  return <ConfigProcessPage key={id} id={id} />;
}

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ObjectPageSkeleton } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { orpc } from "../../../orpc.ts";
import { t, title } from "../../../head.ts";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";
import { RequestOverview } from "../../../components/configurator/RequestOverview.tsx";

export const Route = createFileRoute("/$slug/configs/$id")({
  // Warms the query the page reads (same key), so the tab can carry the name; a failed read stays the
  // page's own error, not the route's.
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(orpc.configs.get.queryOptions({ input: { id: params.id } })).catch(() => undefined),
  head: ({ loaderData }) => title(loaderData?.project.name, t("NAV_CONFIGS")),
  component: Process,
});

// A client's request opens on its project page (client-project-page spec); its configuration is
// $id_.configuration.tsx. A configuration staff made for themselves is the configurator itself.
function Process() {
  const { id } = Route.useParams();
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  if (q.isPending) return <ObjectPageSkeleton />;
  return q.data?.request ? <RequestOverview key={id} id={id} /> : <ConfigProcessPage key={id} id={id} />;
}

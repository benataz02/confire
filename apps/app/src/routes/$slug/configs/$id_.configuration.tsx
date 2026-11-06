import { createFileRoute, redirect } from "@tanstack/react-router";
import { orpc } from "../../../orpc.ts";
import { t, title } from "../../../head.ts";
import { ConfigProcessPage } from "../../../components/configurator/ConfigProcessPage.tsx";

// A client request's configuration, beside its project page ($id.tsx) rather than nested in it (the
// trailing `_`, as $id_.quote.tsx). A configuration staff made for themselves has no project page:
// it is the configurator at /configs/<id>, so it goes there.
export const Route = createFileRoute("/$slug/configs/$id_/configuration")({
  loader: async ({ context, params }) => {
    const v = await context.queryClient.ensureQueryData(orpc.configs.get.queryOptions({ input: { id: params.id } })).catch(() => undefined);
    if (v && !v.request) throw redirect({ to: "/$slug/configs/$id", params, replace: true });
    return v;
  },
  head: ({ loaderData }) => title(loaderData?.project.name, t("NAV_CONFIGS")),
  component: () => {
    const { id } = Route.useParams();
    return <ConfigProcessPage key={id} id={id} />;
  },
});

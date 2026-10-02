import { createFileRoute, redirect } from "@tanstack/react-router";
import { PORTAL_FEATURES } from "../../../../features/portal/documents.tsx";
import { ObjectPage } from "../../../../shared/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "../../../../shared/object-page/ObjectPageSkeleton.tsx";
import { useDetailView } from "../../../../shared/useDetailView.ts";

export const Route = createFileRoute("/_authed/portal/docs/$entity_/$key")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_FEATURES[params.entity]) throw redirect({ to: "/portal" });
  },
  component: PortalDoc,
});

/** One of the client's documents, read-only. */
function PortalDoc() {
  const { entity, key } = Route.useParams();
  const feature = PORTAL_FEATURES[entity]!;
  const d = useDetailView({ entity, routeKey: key, route: `/portal/docs/${entity}`, scope: "portal" });

  if (d.loading) return <ObjectPageSkeleton />;
  if (d.error || !d.constraints || !d.row) return <PageError error={d.error ?? new Error("Not found")} />;
  return (
    <ObjectPage entity={`portal:${entity}`} constraints={d.constraints} data={d.row} readonly localViews
      sections={feature.detail.sections} header={feature.detail.header} onSave={d.save} />
  );
}

import { createFileRoute, redirect } from "@tanstack/react-router";
import { b1Feature } from "../../../features/b1/index.ts";
import { ObjectPage } from "../../../shared/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "../../../shared/object-page/ObjectPageSkeleton.tsx";
import { useDetailView } from "../../../shared/useDetailView.ts";

// One record of a declared B1 entity. Editing is offered when the server says the entity is
// writable, on the fields its write allowlist names, and every save carries the ETag read with
// the row — a concurrent change comes back as a conflict instead of a silent overwrite.

export const Route = createFileRoute("/_authed/b1/$entity_/$key")({
  beforeLoad: ({ params }) => {
    if (!b1Feature(params.entity)) throw redirect({ to: "/" });
  },
  component: EntityRecord,
});

function EntityRecord() {
  const { entity, key } = Route.useParams();
  const feature = b1Feature(entity)!;
  const d = useDetailView({ entity, routeKey: key, route: `/b1/${entity}` });

  if (d.loading) return <ObjectPageSkeleton />;
  if (d.error || !d.constraints || !d.row) return <PageError error={d.error ?? new Error("Not found")} />;
  return (
    <ObjectPage entity={entity} constraints={d.constraints} data={d.row}
      sections={feature.detail.sections} header={feature.detail.header}
      // No ETag means B1 gave us nothing to guard the write with; refuse rather than send a blind PATCH.
      editDisabled={!d.etag}
      onSave={d.save} navigation={d.navigation} />
  );
}

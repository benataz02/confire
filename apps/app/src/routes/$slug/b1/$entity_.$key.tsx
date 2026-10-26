import { useMemo } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useI18n } from "../../../../i18n.ts";
import { b1Feature } from "../../../../features/b1/index.ts";
import { localizedB1Feature } from "../../../../features/b1/localize.ts";
import { b1Label } from "../../../../components/AppShell.tsx";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { useDetailView } from "@confire/ui/useDetailView.ts";

// One record of a declared B1 entity. Editing is offered when the server says the entity is
// writable, on the fields its write allowlist names, and every save carries the ETag read with
// the row — a concurrent change comes back as a conflict instead of a silent overwrite.

export const Route = createFileRoute("/$slug/_admin/b1/$entity_/$key")({
  beforeLoad: ({ params }) => {
    if (!b1Feature(params.entity)) throw redirect({ to: "/$slug", params });
  },
  component: EntityRecord,
});

function EntityRecord() {
  const i18n = useI18n();
  const { entity, key } = Route.useParams();
  const feature = useMemo(
    () => localizedB1Feature(entity, (k, ...args) => i18n.getText(k, ...args))!,
    [entity, i18n],
  );
  const d = useDetailView({ entity, routeKey: key, route: `/b1/${entity}` });

  if (d.loading) return <ObjectPageSkeleton />;
  if (d.error || !d.constraints || !d.row) return <PageError error={d.error ?? new Error(i18n.getText("ADMIN_NOT_FOUND"))} />;
  return (
    <ObjectPage {...feature.detail.templates} entity={entity} constraints={d.constraints} data={d.row}
      sections={feature.detail.sections} header={feature.detail.header}
      // No ETag means B1 gave us nothing to guard the write with; refuse rather than send a blind PATCH.
      editDisabled={!d.etag}
      onSave={d.save} navigation={d.navigation}
      breadcrumbs={[{ text: b1Label(entity, (k) => i18n.getText(k)), to: `/b1/${entity}` }]} />
  );
}

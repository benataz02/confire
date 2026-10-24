import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { useDetailView } from "@confire/ui/useDetailView.ts";
import { PrintActions } from "@confire/ui/PrintActions.tsx";
import type { HeaderConfig } from "@confire/ui/types.ts";
import { orpc } from "../../../orpc.ts";
import { DOC_PAGES, docFeature, isDocEntity, type DocEntity } from "../../../features/documents.ts";
import { useI18n } from "../../../i18n.ts";

// One of the company's SAP documents (spec §9, §13.1): read-only, Preview of its print layout, and a
// link to the project it came from when it traces back to one. No record navigation: next/previous
// would walk every customer's documents.

export const Route = createFileRoute("/$slug/docs/$entity_/$key")({
  beforeLoad: ({ params }) => {
    if (!isDocEntity(params.entity)) throw redirect({ to: "/$slug", params });
  },
  component: DocRecord,
});

function DocRecord() {
  const i18n = useI18n();
  const { entity: raw, key } = Route.useParams();
  const entity = raw as DocEntity;
  const d = useDetailView({ entity, routeKey: key, route: `/docs/${entity}` });
  const feature = d.constraints ? docFeature(entity, d.constraints, i18n.getText.bind(i18n)) : null;
  const header: HeaderConfig | undefined = feature ? {
    ...feature.detail.header,
    actions: (ctx) => {
      const docEntry = Number(ctx.formData.DocEntry);
      return (
        <>
          <ProjectLink entity={entity} docEntry={docEntry} />
          <PrintActions entity={entity} docEntry={docEntry} />
        </>
      );
    },
  } : undefined;

  if (d.loading) return <ObjectPageSkeleton />;
  if (d.error || !d.row || !feature || !header) return <PageError error={d.error ?? new Error(i18n.getText("PORTAL_NOT_FOUND"))} />;
  // `writable: false` from the server: no Edit, so onSave is never reached.
  return <ObjectPage entity={entity} constraints={d.constraints!} data={d.row} sections={feature.detail.sections} header={header}
    onSave={d.save} breadcrumbs={[{ text: i18n.getText(DOC_PAGES[entity].labelKey), to: `/docs/${entity}` }]} />;
}

/** The project this document came from (docs.project walks back to the quotation). A separate read:
 *  while it runs, or when there is none, there is simply no link. */
function ProjectLink({ entity, docEntry }: { entity: DocEntity; docEntry: number }) {
  const i18n = useI18n();
  const navigate = useNavigate({ from: "/$slug" });
  const project = useQuery({ ...orpc.docs.project.queryOptions({ input: { entity, docEntry } }), retry: false, enabled: Number.isFinite(docEntry) });
  if (!project.data) return null;
  const { id, name } = project.data;
  return (
    <Button icon="chain-link" design="Transparent" onClick={() => void navigate({ to: "/$slug/projects/$id", params: { id } })}>
      {i18n.getText("PORTAL_PROJECT_LINK", name)}
    </Button>
  );
}

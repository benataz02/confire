import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Card, CardHeader, Dialog, DynamicPage, DynamicPageTitle, Icon, IllustratedMessage, Input,
  Label, MessageStrip, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { useI18n } from "../../../../i18n.ts";
import { meQuery, orpc } from "../../../../orpc.ts";

// The catalog (spec §9, D21): every model the supplier published, as cards. Pick one, name the
// project, and it opens as a draft. The model is fixed from here on; the customer is the company.

export const Route = createFileRoute("/$slug/_authed/projects/new")({
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me.company?.role === "viewer") throw redirect({ to: "/$slug/projects", params });
  },
  component: Catalog,
});

type Model = { id: string; name: string; description: string | null; portalPricing: "indicative" | "request" };

function Catalog() {
  const i18n = useI18n();
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const models = useQuery(orpc.models.list.queryOptions());
  const [picked, setPicked] = useState<Model | null>(null);
  const [name, setName] = useState("");
  const create = useMutation(orpc.projects.create.mutationOptions({
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
      void navigate({ to: "/$slug/projects/$id", params: { id: r.id } });
    },
  }));
  const pick = (m: Model) => { setPicked(m); setName(m.name); create.reset(); };
  const submit = () => { if (picked && name.trim()) create.mutate({ modelId: picked.id, name: name.trim() }); };

  return (
    <DynamicPage hidePinButton
      titleArea={<DynamicPageTitle heading={<Title level="H3">{i18n.getText("PORTAL_NEW_PROJECT_TITLE")}</Title>}
        subheading={<Text>{i18n.getText("PORTAL_CATALOG_SUB")}</Text>} />}>
      {models.isPending ? <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />
      : models.error ? <MessageStrip design="Negative" hideCloseButton>{models.error.message}</MessageStrip>
      : !models.data.length ? (
        <IllustratedMessage name="NoEntries" titleText={i18n.getText("PORTAL_CATALOG_EMPTY")}
          subtitleText={i18n.getText("PORTAL_CATALOG_EMPTY_SUB")} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))", gap: "1rem" }}>
          {models.data.map((m) => (
            <Card key={m.id} header={
              <CardHeader interactive titleText={m.name} subtitleText={m.description ?? undefined}
                avatar={<Icon name="product" />}
                additionalText={m.portalPricing === "indicative" ? i18n.getText("PORTAL_PRICE_INDICATIVE") : i18n.getText("PORTAL_PRICE_ON_REQUEST")}
                onClick={() => pick(m)} />
            }>
              <div style={{ padding: "0 1rem 1rem" }}>
                <Text style={{ color: "var(--sapContent_LabelColor)" }}>
                  {m.portalPricing === "indicative"
                    ? i18n.getText("PORTAL_PRICE_INDICATIVE_HELP")
                    : i18n.getText("PORTAL_PRICE_ON_REQUEST_HELP")}
                </Text>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!picked} headerText={picked ? i18n.getText("PORTAL_NEW_NAMED_PROJECT", picked.name) : ""} onClose={() => setPicked(null)}
        style={{ width: "min(28rem, 90vw)" }}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!name.trim() || create.isPending} onClick={submit}>{i18n.getText("PORTAL_CREATE")}</Button>
              <Button design="Transparent" onClick={() => setPicked(null)}>{i18n.getText("PORTAL_CANCEL")}</Button>
            </>
          } />
        }>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <Label for="project-name" required>{i18n.getText("PORTAL_PROJECT_NAME")}</Label>
          <Input id="project-name" value={name} maxlength={200} style={{ width: "100%" }}
            valueState={name.trim() ? "None" : "Negative"} valueStateMessage={<div>{i18n.getText("PORTAL_PROJECT_NAME_REQUIRED")}</div>}
            onInput={(e) => setName(e.target.value ?? "")}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
        </div>
      </Dialog>
    </DynamicPage>
  );
}

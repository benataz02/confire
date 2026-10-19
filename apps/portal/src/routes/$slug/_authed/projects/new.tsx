import { useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Card, CardHeader, Dialog, DynamicPage, DynamicPageTitle, Icon, IllustratedMessage, Input,
  Label, MessageStrip, Text, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
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
      titleArea={<DynamicPageTitle heading={<Title level="H3">New project</Title>}
        subheading={<Text>Pick the product to configure.</Text>} />}>
      {models.isPending ? <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />
      : models.error ? <MessageStrip design="Negative" hideCloseButton>{models.error.message}</MessageStrip>
      : !models.data.length ? (
        <IllustratedMessage name="NoEntries" titleText="Nothing to configure yet"
          subtitleText="Your supplier hasn't published a product on the portal yet." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))", gap: "1rem" }}>
          {models.data.map((m) => (
            <Card key={m.id} header={
              <CardHeader interactive titleText={m.name} subtitleText={m.description ?? undefined}
                avatar={<Icon name="product" />}
                additionalText={m.portalPricing === "indicative" ? "Indicative prices" : "Price on request"}
                onClick={() => pick(m)} />
            }>
              <div style={{ padding: "0 1rem 1rem" }}>
                <Text style={{ color: "var(--sapContent_LabelColor)" }}>
                  {m.portalPricing === "indicative"
                    ? "You see indicative prices while you configure; the quotation has the final ones."
                    : "Prices come with the quotation, after your supplier has reviewed the request."}
                </Text>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!picked} headerText={picked ? `New ${picked.name} project` : ""} onClose={() => setPicked(null)}
        style={{ width: "min(28rem, 90vw)" }}
        footer={
          <Bar design="Footer" endContent={
            <>
              <Button design="Emphasized" disabled={!name.trim() || create.isPending} onClick={submit}>Create</Button>
              <Button design="Transparent" onClick={() => setPicked(null)}>Cancel</Button>
            </>
          } />
        }>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <Label for="project-name" required>Project name</Label>
          <Input id="project-name" value={name} maxlength={200} style={{ width: "100%" }}
            valueState={name.trim() ? "None" : "Negative"} valueStateMessage={<div>Give the project a name.</div>}
            onInput={(e) => setName(e.target.value ?? "")}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
        </div>
      </Dialog>
    </DynamicPage>
  );
}

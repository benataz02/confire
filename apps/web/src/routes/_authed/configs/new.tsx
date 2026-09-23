import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Form, FormGroup, FormItem, IllustratedMessage, Input, Label,
  MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle, Option, Select, Title,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoEntries.js";
import { orpc } from "../../../orpc.ts";
import { EntityValueHelp } from "../../../components/ValueHelp.tsx";

export const Route = createFileRoute("/_authed/configs/new")({ component: NewConfig });

const CUSTOMER_SELECT = ["CardCode", "CardName"];
const CUSTOMER_FILTER = [{ field: "CardType", op: "eq" as const, value: "cCustomer" }];

function NewConfig() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery(orpc.configs.models.queryOptions());
  const [name, setName] = useState("");
  const [modelId, setModelId] = useState("");
  const [customer, setCustomer] = useState<{ cardCode: string; cardName: string } | null>(null);
  // An untouched form is not an error yet — Create is what turns the empty name red.
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!modelId && models.data?.[0]) setModelId(models.data[0].id);
  }, [modelId, models.data]);

  const create = useMutation(
    orpc.configs.create.mutationOptions({
      onSuccess: (r) => {
        void qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });
        void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
        void navigate({ to: "/configs/$id", params: { id: r.id }, replace: true });
      },
    }),
  );

  if (models.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (models.error) {
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{models.error.message}</MessageStrip>;
  }
  if (models.data?.length === 0) {
    return (
      <IllustratedMessage name="NoEntries" titleText="No configurator models yet"
        subtitleText="An admin creates those first." />
    );
  }

  return (
    <ObjectPage
      hidePinButton
      titleArea={<ObjectPageTitle header={<Title>New configuration</Title>} />}
      footerArea={
        <Bar design="FloatingFooter" endContent={
          <>
            <Button design="Emphasized" disabled={create.isPending}
              onClick={() => (name.trim() && modelId
                ? create.mutate({ modelId, name: name.trim(), customer })
                : setTried(true))}>
              {create.isPending ? "Creating…" : "Create"}
            </Button>
            <Button onClick={() => void navigate({ to: "/configs" })}>Cancel</Button>
          </>
        } />
      }
    >
      <ObjectPageSection id="general" titleText="General">
        <Form labelSpan="S12 M4 L4 XL4" layout="S1 M1 L1 XL1">
          <FormGroup>
            {create.error ? (
              <FormItem>
                <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip>
              </FormItem>
            ) : null}
            <FormItem labelContent={<Label for="cfg-new-name" required>Name</Label>}>
              <Input id="cfg-new-name" value={name} style={{ width: "100%" }}
                valueState={tried && !name.trim() ? "Negative" : "None"}
                valueStateMessage={<div>Give the configuration a name — it is how it shows up in the list.</div>}
                onInput={(e) => setName(e.target.value ?? "")} />
            </FormItem>
            <FormItem labelContent={<Label required>Model</Label>}>
              <Select value={modelId} style={{ width: "100%" }}
                onChange={(e) => setModelId(e.detail.selectedOption.value ?? "")}>
                {(models.data ?? []).map((m) => (
                  <Option key={m.id} value={m.id}>{m.name}</Option>
                ))}
              </Select>
            </FormItem>
            <FormItem labelContent={<Label>Customer</Label>}>
              <EntityValueHelp entitySet="BusinessPartners" keyField="CardCode"
                select={CUSTOMER_SELECT} filter={CUSTOMER_FILTER}
                value={customer?.cardCode}
                headerText="Select a customer"
                onChange={(v, row) => setCustomer(
                  v == null || v === "" ? null : {
                    cardCode: String(v),
                    cardName: String(row?.[CUSTOMER_SELECT.indexOf("CardName")] ?? ""),
                  },
                )} />
            </FormItem>
          </FormGroup>
        </Form>
      </ObjectPageSection>
    </ObjectPage>
  );
}

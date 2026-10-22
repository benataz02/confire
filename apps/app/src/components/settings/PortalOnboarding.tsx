import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Button, Card, CardHeader, CheckBox, FlexBox, Label, MessageStrip, Option, Select, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Title, Toolbar, ToolbarButton, ToolbarSpacer,
} from "@ui5/webcomponents-react";
import { sameState } from "@confire/ui/views.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../i18n.ts";
import { client, orpc } from "../../orpc.ts";
import { FieldPicker } from "./PortalDocFields.tsx";

// Settings → Portal → New-client onboarding (spec §5.3, §10, D16, D17): the extra BusinessPartners
// fields a new client fills in on the portal, each required or optional, and the numbering series
// SAP gives their lead. The options are the server's `extraPickable` list — the denylist and the
// form's own fields are already out — so this page cannot offer what save would refuse.

type Get = Awaited<ReturnType<typeof client.portalSettings.get>>;
type Extra = Get["extraFields"][number];
type Draft = { extraFields: Extra[]; leadSeries: number | null };

export function PortalOnboarding() {
  const i18n = useI18n();
  const settings = useQuery(orpc.portalSettings.get.queryOptions());
  return (
    <Card header={<CardHeader titleText={i18n.getText("ADMIN_ONBOARDING")} subtitleText={i18n.getText("ADMIN_ONBOARDING_SUB")} />}>
      {settings.data ? <OnboardingForm current={settings.data} />
        : settings.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{settings.error.message}</MessageStrip>
        : <BusyIndicator active style={{ margin: "1rem" }} />}
    </Card>
  );
}

function OnboardingForm({ current }: { current: Get }) {
  const i18n = useI18n();
  const qc = useQueryClient();
  const stored: Draft = { extraFields: current.extraFields, leadSeries: current.leadSeries };
  const [draft, setDraft] = useState<Draft>(stored);
  const [picking, setPicking] = useState(false);
  // A refetch after save re-seeds the draft from what the server now holds.
  useEffect(() => setDraft({ extraFields: current.extraFields, leadSeries: current.leadSeries }), [current.extraFields, current.leadSeries]);
  // Its own call: SAP being down costs this select, not the card.
  const series = useQuery({ ...orpc.portalSettings.leadSeries.queryOptions(), retry: false });

  const save = useMutation(orpc.portalSettings.save.mutationOptions({
    onSuccess: () => {
      toast(i18n.getText("ADMIN_PORTAL_SAVED"));
      void qc.invalidateQueries({ queryKey: orpc.portalSettings.get.key() });
    },
  }));

  const label = new Map(current.extraOptions.map((o) => [o.key, o.label]));
  const dirty = !sameState(draft, stored);
  const setRequired = (key: string, required: boolean) =>
    setDraft((d) => ({ ...d, extraFields: d.extraFields.map((x) => (x.key === key ? { ...x, required } : x)) }));
  const remove = (key: string) => setDraft((d) => ({ ...d, extraFields: d.extraFields.filter((x) => x.key !== key) }));
  // The picker sets which fields and their order; a field kept keeps its Required flag, a new one is optional.
  const pick = (keys: string[]) => setDraft((d) => ({
    ...d, extraFields: keys.map((key) => d.extraFields.find((x) => x.key === key) ?? { key, required: false }),
  }));

  // A stored series B1 no longer lists (or a list that failed to load) still shows as itself.
  const options = series.data ?? [];
  const missing = draft.leadSeries !== null && !options.some((o) => o.series === draft.leadSeries);

  return (
    <FlexBox direction="Column" style={{ padding: "1rem", gap: "1rem" }}>
      {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}

      <FlexBox direction="Column" style={{ gap: "0.25rem" }}>
        <Label for="lead-series" showColon>{i18n.getText("ADMIN_LEAD_SERIES")}</Label>
        <Select id="lead-series" style={{ width: "min(24rem, 100%)" }} disabled={series.isPending}
          value={draft.leadSeries === null ? "" : String(draft.leadSeries)}
          onChange={(e) => {
            const v = e.detail.selectedOption.value ?? "";
            setDraft((d) => ({ ...d, leadSeries: v ? Number(v) : null }));
          }}>
          <Option value="">{i18n.getText("ADMIN_LEAD_SERIES_DEFAULT")}</Option>
          {options.map((o) => <Option key={o.series} value={String(o.series)}>{o.name}</Option>)}
          {missing ? <Option value={String(draft.leadSeries)}>{i18n.getText("ADMIN_SERIES_MISSING", String(draft.leadSeries))}</Option> : null}
        </Select>
        {series.error ? (
          <MessageStrip design="Critical" hideCloseButton>{i18n.getText("ADMIN_LEAD_SERIES_ERROR", series.error.message)}</MessageStrip>
        ) : null}
      </FlexBox>

      <FlexBox direction="Column">
        <Toolbar design="Transparent">
          <Title level="H6">{i18n.getText("ADMIN_EXTRA_FIELDS", draft.extraFields.length)}</Title>
          <ToolbarSpacer />
          <ToolbarButton design="Transparent" icon="action-settings" text={i18n.getText("ADMIN_CHOOSE_FIELDS")} onClick={() => setPicking(true)} />
        </Toolbar>
        <Table accessibleName={i18n.getText("ADMIN_EXTRA_A11Y")} overflowMode="Popin" rowActionCount={1}
          noDataText={i18n.getText("ADMIN_EXTRA_EMPTY")}
          onRowActionClick={(e) => remove((e.detail.row as unknown as { rowKey: string }).rowKey)}
          headerRow={
            <TableHeaderRow sticky>
              <TableHeaderCell minWidth="12rem">{i18n.getText("ADMIN_COL_EXTRA")}</TableHeaderCell>
              <TableHeaderCell width="8rem">{i18n.getText("ADMIN_REQUIRED")}</TableHeaderCell>
            </TableHeaderRow>
          }>
          {draft.extraFields.map((x) => (
            <TableRow key={x.key} rowKey={x.key} actions={<TableRowAction icon="decline" text={i18n.getText("ADMIN_REMOVE_FIELD")} />}>
              <TableCell><Text>{label.get(x.key) ?? x.key}</Text></TableCell>
              <TableCell>
                <CheckBox checked={x.required} accessibleName={i18n.getText("ADMIN_REQUIRED_A11Y", label.get(x.key) ?? x.key)}
                  onChange={(e) => setRequired(x.key, e.target.checked)} />
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </FlexBox>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>
        {i18n.getText("ADMIN_ONBOARDING_NOTE")}
      </Text>

      <Button design="Emphasized" style={{ alignSelf: "start" }} disabled={!dirty || save.isPending}
        onClick={() => save.mutate(draft)}>
        {save.isPending ? i18n.getText("ADMIN_SAVING") : i18n.getText("ADMIN_SAVE")}
      </Button>
      {picking ? (
        <FieldPicker
          title={i18n.getText("ADMIN_PICK_EXTRA")}
          selected={draft.extraFields.map((x) => x.key)}
          options={current.extraOptions}
          onConfirm={(keys) => { pick(keys); setPicking(false); }}
          onClose={() => setPicking(false)} />
      ) : null}
    </FlexBox>
  );
}

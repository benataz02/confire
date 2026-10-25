import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Card, CardHeader, FlexBox, Label, MessageStrip, ProgressIndicator, Switch, Text,
} from "@ui5/webcomponents-react";
import { money } from "@confire/ui/money.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";

// Settings → Assistant (assistant spec §4.7): the workspace's switch, saying where the data goes, and
// this month's spend against the limit. The operator reads across workspaces with SQL (DEPLOY.md).

const BODY = { padding: "1rem", gap: "0.75rem" } as const;

export function AssistantSettings() {
  return (
    <>
      <SwitchCard />
      <UsageCard />
    </>
  );
}

function SwitchCard() {
  const i18n = useI18n();
  const qc = useQueryClient();
  const q = useQuery(orpc.assistant.settings.queryOptions());
  const save = useMutation(orpc.assistant.saveSettings.mutationOptions({
    onSuccess: () => {
      toast(i18n.getText("ASSISTANT_SAVED"));
      void qc.invalidateQueries({ queryKey: orpc.assistant.key() });
    },
  }));
  return (
    <Card header={<CardHeader titleText={i18n.getText("ASSISTANT_SWITCH")} subtitleText={i18n.getText("ASSISTANT_SWITCH_SUB")}
      action={q.data ? (
        <Switch checked={save.isPending ? save.variables?.assistant : q.data.assistant} disabled={save.isPending}
          accessibleName={i18n.getText("ASSISTANT_SWITCH")}
          onChange={(e) => save.mutate({ assistant: e.target.checked })} />
      ) : undefined} />}>
      <FlexBox direction="Column" style={BODY}>
        {q.error ? <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip>
          : !q.data ? <BusyIndicator active /> : null}
        {save.error ? <MessageStrip design="Negative" hideCloseButton>{save.error.message}</MessageStrip> : null}
        <Text>{i18n.getText("ASSISTANT_SWITCH_INFO")}</Text>
      </FlexBox>
    </Card>
  );
}

function UsageCard() {
  const i18n = useI18n();
  const q = useQuery(orpc.assistant.usage.queryOptions());
  const u = q.data;
  const share = u && u.limit > 0 ? (u.cost / u.limit) * 100 : 0;
  return (
    <Card header={<CardHeader titleText={i18n.getText("ASSISTANT_USAGE")} subtitleText={i18n.getText("ASSISTANT_USAGE_SUB")} />}>
      <FlexBox direction="Column" style={BODY}>
        {q.error ? <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip>
          : !u ? <BusyIndicator active />
          : (
            <>
              <ProgressIndicator value={Math.min(100, share)} accessibleName={i18n.getText("ASSISTANT_USAGE")}
                valueState={share >= 100 ? "Negative" : share >= 80 ? "Critical" : "None"}
                displayValue={i18n.getText("ASSISTANT_USAGE_OF", money(u.cost, "USD"), money(u.limit, "USD"))} />
              <Label>{i18n.getText("ASSISTANT_ASSISTED", String(u.assisted))}</Label>
              <Text style={{ color: "var(--sapContent_LabelColor)" }}>{i18n.getText("ASSISTANT_MODEL", u.model)}</Text>
            </>
          )}
      </FlexBox>
    </Card>
  );
}

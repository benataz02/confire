import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Button, Card, CardHeader, FlexBox, Input, Label, MessageStrip, Option, Select, Text,
} from "@ui5/webcomponents-react";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { useI18n } from "../../i18n.ts";
import { client, orpc } from "../../orpc.ts";
import type { CardCtx } from "./registry.tsx";

// The first call's answer (tool `read_request`): model, customer and name, proposed — confirmed or
// changed here before anything exists. Create starts the configuration, opens it, and reads its
// values from the drop. A proposal is AI content: it says so under its header.

export type Proposal = {
  model: { id: string; name: string } | null;
  why: string;
  customers: { cardCode: string; cardName: string }[];
  customerError: string | null;
  name: string;
};
type Customer = { cardCode: string; cardName: string };

const CUSTOMER = { dialogConfig: cfl.customers() };
const BODY = { padding: "0 1rem 0.75rem", gap: "0.5rem" } as const;
const ROW = { display: "flex", flexWrap: "wrap", gap: "0.5rem" } as const;
const NOTICE = { color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" } as const;

export function ProposalCard({ p, ctx }: { p: Proposal; ctx: CardCtx }) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const navigate = useNavigate({ from: "/$slug" });
  const models = useQuery(orpc.configs.models.queryOptions());
  const [modelId, setModelId] = useState(p.model?.id ?? "");
  const [customer, setCustomer] = useState<Customer | null>(p.customers[0] ?? null);
  const [name, setName] = useState(p.name);
  const [state, setState] = useState<"open" | "busy" | "dismissed">("open");
  const [error, setError] = useState<string | null>(null);

  const created = ctx.threadProjectId;
  if (created) {
    return (
      <Card header={<CardHeader titleText={t("ASSISTANT_PROPOSAL_CREATED", name)} interactive
        onClick={() => void navigate({ to: "/$slug/configs/$id", params: { id: created } })} />} />
    );
  }
  if (state === "dismissed") return <Text style={NOTICE}>{t("ASSISTANT_PROPOSAL_DISMISSED")}</Text>;

  const create = async () => {
    setState("busy");
    setError(null);
    try {
      const { id } = await client.assistant.start({ threadId: ctx.threadId, modelId, name: name.trim(), customer });
      await ctx.onStarted(id);
      ctx.setPending(t("ASSISTANT_READING", ctx.lastFiles.join(", ") || "…"));
      try {
        ctx.append((await client.assistant.extract({ threadId: ctx.threadId, projectId: id })).messages);
      } finally {
        ctx.setPending(null);
      }
    } catch (e) {
      setError(ctx.errorText(e));
      setState("open");
    }
  };

  const busy = state === "busy";
  return (
    <Card header={<CardHeader titleText={t("ASSISTANT_PROPOSAL")} subtitleText={p.why} />}>
      <FlexBox direction="Column" style={BODY}>
        <Label for="cf-proposal-model" required>{t("ASSISTANT_PROPOSAL_MODEL")}</Label>
        <Select id="cf-proposal-model" value={modelId} disabled={busy} onChange={(e) => setModelId(e.detail.selectedOption.value ?? "")}>
          {modelId ? null : <Option value="">{t("ASSISTANT_PROPOSAL_NO_MODEL")}</Option>}
          {(models.data ?? []).map((m) => <Option key={m.id} value={m.id}>{m.name}</Option>)}
        </Select>
        <Label>{t("ASSISTANT_PROPOSAL_CUSTOMER")}</Label>
        {p.customerError ? <MessageStrip design="Critical" hideCloseButton>{t("ASSISTANT_PROPOSAL_NO_CUSTOMER")}</MessageStrip> : null}
        {p.customers.length ? (
          <div style={ROW}>
            {p.customers.map((c) => (
              <Button key={c.cardCode} disabled={busy} design={customer?.cardCode === c.cardCode ? "Emphasized" : "Default"}
                aria-pressed={customer?.cardCode === c.cardCode}
                onClick={() => setCustomer(customer?.cardCode === c.cardCode ? null : c)}>{c.cardName}</Button>
            ))}
          </div>
        ) : null}
        <CflField config={CUSTOMER} value={customer?.cardCode ?? null} disabled={busy}
          accessibleName={t("ASSISTANT_PROPOSAL_OTHER")} placeholder={t("ASSISTANT_PROPOSAL_OTHER")}
          onValueChange={(v) => { if (v === null || v === "") setCustomer(null); }}
          onRowSelect={(row) => setCustomer({ cardCode: String(row.CardCode ?? ""), cardName: String(row.CardName ?? "") })} />
        <Label for="cf-proposal-name" required>{t("ASSISTANT_PROPOSAL_NAME")}</Label>
        <Input id="cf-proposal-name" value={name} disabled={busy} onInput={(e) => setName(e.target.value)} />
        {error ? <MessageStrip design="Negative" hideCloseButton>{error}</MessageStrip> : null}
        <div style={ROW}>
          <Button design="Emphasized" icon="ai" disabled={busy || !modelId || !name.trim()} onClick={() => void create()}>
            {t("ASSISTANT_PROPOSAL_CREATE")}
          </Button>
          <Button design="Transparent" disabled={busy} onClick={() => setState("dismissed")}>{t("ASSISTANT_PROPOSAL_DISMISS")}</Button>
        </div>
      </FlexBox>
    </Card>
  );
}

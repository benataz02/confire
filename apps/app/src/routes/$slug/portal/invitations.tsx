import { useCallback, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { InviteNewClientDialog } from "../../../components/portal/BpPortal.tsx";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

type TextFn = (key: string, ...args: Array<string | number>) => string;

function invitationsFeature(t: TextFn): ListFeature {
  return {
    tableId: "portal:invitations",
    title: t("NAV_INVITATIONS"),
    columns: [
      { key: "email", label: t("ADMIN_COL_EMAIL") },
      { key: "cardCode", label: t("ADMIN_COL_BP"), width: 150, linkConfig: { route: "/b1/BusinessPartners" } },
      { key: "cardName", label: t("ADMIN_NAME") },
      { key: "role", label: t("ADMIN_COL_ROLE"), type: "enum", width: 110, groupable: true, options: [
        { value: "owner", label: t("ADMIN_ROLE_OWNER") },
        { value: "buyer", label: t("ADMIN_ROLE_BUYER") },
        { value: "viewer", label: t("ADMIN_ROLE_VIEWER") },
      ] },
      { key: "state", label: t("ADMIN_STATUS"), type: "enum", width: 120, groupable: true, options: [
        { value: "pending", label: t("ADMIN_PENDING") },
        { value: "expired", label: t("ADMIN_EXPIRED") },
        { value: "accepted", label: t("ADMIN_ACCEPTED") },
        { value: "canceled", label: t("ADMIN_CANCELED") },
      ] },
      { key: "inviter", label: t("ADMIN_COL_INVITER") },
      { key: "createdAt", label: t("ADMIN_COL_SENT"), type: "date", width: 130 },
      { key: "expiresAt", label: t("ADMIN_COL_EXPIRES"), type: "date", width: 130 },
    ],
    filterFields: [{ key: "email" }, { key: "cardCode" }, { key: "state" }],
    systemViews: [
      { key: "pending", name: t("ADMIN_PENDING"), state: { filterValues: { state: ["pending"] } }, isDefault: true },
    ],
  };
}

// Portal → Invitations (spec §5.1, §10): every invitation of the tenant, both types — the only place
// a pending new-client one (no CardCode yet, P6) shows. Admins only, on the server.

export const Route = createFileRoute("/$slug/portal/invitations")({ component: Invitations });

function Invitations() {
  const i18n = useI18n();
  const t = (key: string, ...args: Array<string | number>) => i18n.getText(key, ...args);
  const feature = useMemo(() => invitationsFeature(t), [i18n]);
  const qc = useQueryClient();
  const [query, setQuery] = useState<ListQuery | null>(null);
  const [inviting, setInviting] = useState(false);
  const data = useListView(
    {
      ...orpc.portalInvitations.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
  );
  const cancel = useMutation(orpc.portalInvitations.cancel.mutationOptions({
    // The BP Portal sections list pending invitations too.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.portalInvitations.rows.key() });
      void qc.invalidateQueries({ queryKey: orpc.portalCompanies.get.key() });
    },
  }));

  const cancelSelected = useCallback(async (sel: Row[], clear: () => void) => {
    const open = sel.filter((r) => r.state === "pending" || r.state === "expired");
    const one = open.length === 1;
    const ok = await confirm({
      title: t(one ? "ADMIN_CANCEL_INVITE_TITLE" : "ADMIN_CANCEL_INVITES_TITLE"),
      message: one ? t("ADMIN_CANCEL_INVITE_MSG", String(open[0]!.email)) : t("ADMIN_CANCEL_INVITES_MSG", open.length),
      actionText: t("ADMIN_CANCEL_INVITES"),
      destructive: true,
    });
    if (!ok) return;
    try {
      const { canceled } = await cancel.mutateAsync({ ids: open.map((r) => String(r.id)) });
      clear();
      toast(canceled === 1 ? t("ADMIN_INVITE_CANCELLED") : t("ADMIN_INVITES_CANCELLED", canceled));
    } catch {
      // cancel.error is on screen; the selection stays
    }
  }, [cancel, i18n]);

  return (
    <>
      <ListReport
        feature={feature}
        data={data}
        onQuery={setQuery}
        keyOf={(r) => String(r.id)}
        error={cancel.error}
        toolbarActions={({ rows: sel, clear }) => (
          <>
            {/* A new client, no CardCode yet (spec §5.1); an existing BP is invited from its Object Page. */}
            <Button design="Transparent" icon="paper-plane" onClick={() => setInviting(true)}>
              {t("ADMIN_INVITE_NEW_CLIENT")}
            </Button>
            <Button design="Transparent" icon="cancel"
              disabled={cancel.isPending || !sel.some((r) => r.state === "pending" || r.state === "expired")}
              onClick={() => void cancelSelected(sel, clear)}>
              {t("ADMIN_CANCEL_INVITE")}
            </Button>
          </>
        )}
      />
      {inviting ? <InviteNewClientDialog onClose={() => setInviting(false)} /> : null}
    </>
  );
}

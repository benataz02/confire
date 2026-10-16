import { useCallback, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { ROLE_LABEL } from "@confire/ui/portal/CompanyPeople.tsx";
import type { ListFeature, ListQuery, Option, Row } from "@confire/ui/types.ts";

// Portal → Invitations (spec §5.1, §10): every invitation of the tenant, both types — the only place
// a pending new-client one (no CardCode yet, P6) shows. Admins only, on the server.

export const Route = createFileRoute("/_authed/portal/invitations")({ component: Invitations });

const STATE_OPTIONS: Option[] = [
  { value: "pending", label: "Pending" },
  { value: "expired", label: "Expired" },
  { value: "accepted", label: "Accepted" },
  { value: "canceled", label: "Cancelled" },
];
const ROLE_OPTIONS: Option[] = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

const FEATURE: ListFeature = {
  tableId: "portal:invitations",
  title: "Portal invitations",
  columns: [
    { key: "email", label: "Email" },
    { key: "cardCode", label: "Business partner", width: 150, linkConfig: { route: "/b1/BusinessPartners" } },
    { key: "cardName", label: "Name" },
    { key: "role", label: "Role", type: "enum", options: ROLE_OPTIONS, width: 110, groupable: true },
    { key: "state", label: "Status", type: "enum", options: STATE_OPTIONS, width: 120, groupable: true },
    { key: "inviter", label: "Invited by" },
    { key: "createdAt", label: "Sent", type: "date", width: 130 },
    { key: "expiresAt", label: "Expires", type: "date", width: 130 },
  ],
  filterFields: [{ key: "email" }, { key: "cardCode" }, { key: "state" }],
  systemViews: [
    { key: "pending", name: "Pending", state: { filterValues: { state: ["pending"] } }, isDefault: true },
  ],
};

function Invitations() {
  const qc = useQueryClient();
  const [query, setQuery] = useState<ListQuery | null>(null);
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
      title: one ? "Cancel invitation" : "Cancel invitations",
      message: one ? `Cancel the invitation to ${String(open[0]!.email)}? Its link stops working.` : `Cancel ${open.length} invitations? Their links stop working.`,
      actionText: "Cancel invitations",
      destructive: true,
    });
    if (!ok) return;
    try {
      const { canceled } = await cancel.mutateAsync({ ids: open.map((r) => String(r.id)) });
      clear();
      toast(canceled === 1 ? "Invitation cancelled" : `${canceled} invitations cancelled`);
    } catch {
      // cancel.error is on screen; the selection stays
    }
  }, [cancel]);

  return (
    <ListReport
      feature={FEATURE}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      error={cancel.error}
      toolbarActions={({ rows: sel, clear }) => (
        <Button design="Transparent"
          disabled={cancel.isPending || !sel.some((r) => r.state === "pending" || r.state === "expired")}
          onClick={() => void cancelSelected(sel, clear)}>
          Cancel invitation
        </Button>
      )}
    />
  );
}

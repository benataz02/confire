import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Label, MessageStrip, NotificationList, NotificationListItem, ResponsivePopover, Switch,
  Table, TableCell, TableGroupRow, TableHeaderCell, TableHeaderRow, TableRow, Text, Title,
} from "@ui5/webcomponents-react";
import { formatLocale } from "../format.ts";
import { useUiI18n } from "../i18n.ts";
import { toast } from "../toast.ts";
import type { NotificationItem, NotificationSetting, NotificationsApi, Preference } from "./api.ts";

// The bell and the Notifications page (spec docs/superpowers/specs/2026-10-22-notifications-design.md
// §7, §10), for both apps. The data source is injected like UiSource: each app passes its own
// `notificationsApi(client.notifications)` (api.ts; both routers have the same six procedures) and its
// own `getText` for the per-type texts (`NOTIF_<ID>…`), since each app's bundle holds its side of the
// catalog. The query keys are this module's: one SPA page load is one tenant, so they never mix two.

type GetText = (key: string, ...args: string[]) => string;

const KEY = ["notifications"] as const;
const COUNT = [...KEY, "count"] as const;
const LIST = [...KEY, "list"] as const;
const SETTINGS = [...KEY, "settings"] as const;

/** `request.quote_accepted` → `NOTIF_REQUEST_QUOTE_ACCEPTED`, the prefix of its texts. */
const textKey = (type: string) => `NOTIF_${type.toUpperCase().replace(/\./g, "_")}`;

/** The unread count for the ShellBar badge. ponytail: polled every 30 s (and on focus); push over
 *  LISTEN/NOTIFY + SSE if 30 s stops being enough. */
export function useUnreadCount(api: Pick<NotificationsApi, "unreadCount">): number {
  return useQuery({
    queryKey: COUNT, queryFn: () => api.unreadCount(), refetchInterval: 30_000, refetchOnWindowFocus: true,
  }).data?.count ?? 0;
}

const STATE: Record<string, "Positive" | "Critical" | "Negative"> = {
  "project.declined": "Negative", "project.returned": "Critical", "project.quoted": "Positive",
  "request.quote_accepted": "Positive", "request.quote_declined": "Critical",
};

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60],
];
/** "5 minutes ago", in the page's UI5 language. */
function ago(d: Date): string {
  const s = (new Date(d).getTime() - Date.now()) / 1000;
  const f = new Intl.RelativeTimeFormat(formatLocale(), { numeric: "auto" });
  const unit = UNITS.find(([, n]) => Math.abs(s) >= n);
  return unit ? f.format(Math.round(s / unit[1]), unit[0]) : f.format(0, "minute");
}

/** The bell's text: the type's title over the row's snapshotted params, in the reader's language.
 *  Placeholders: {0} who acted, {1} the project, {2} the company, {3} the quotation number. */
function titleOf(n: NotificationItem, getText: GetText) {
  const p = n.params;
  const s = (v: string | number | null | undefined) => (v == null ? "" : String(v));
  return getText(`${textKey(n.type)}_TITLE`, s(p.actorName), s(p.projectName), s(p.companyName), s(p.docNum)).replace(/\s+/g, " ").trim();
}

/** The bell's popover: newest first, an item opens its page (and is read), its close button deletes
 *  it. The list is fetched while it is open; edits patch the count and the list at once, then settle
 *  against the server. */
export function NotificationsPopover({ api, opener, open, onClose, getText, onNavigate, onSettings }: {
  api: NotificationsApi;
  opener: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  getText: GetText;
  /** a tenant-relative path, `useEntityNav`'s */
  onNavigate: (path: string) => void;
  onSettings: () => void;
}) {
  const ui = useUiI18n();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: LIST, queryFn: () => api.list(), enabled: open });
  const rows = list.data ?? [];

  const optimistic = async (patch: (rows: NotificationItem[]) => NotificationItem[], unread: (count: number) => number) => {
    await qc.cancelQueries({ queryKey: KEY });
    qc.setQueryData<NotificationItem[]>(LIST, (r) => r && patch(r));
    qc.setQueryData<{ count: number }>(COUNT, (c) => c && { count: Math.max(0, unread(c.count)) });
  };
  const settle = () => void qc.invalidateQueries({ queryKey: KEY });
  const markRead = useMutation({
    mutationFn: (ids?: string[]) => api.markRead({ ids }),
    onMutate: (ids) => optimistic(
      (r) => r.map((n) => (!ids || ids.includes(n.id) ? { ...n, read: true } : n)),
      (c) => (ids ? c - rows.filter((n) => !n.read && ids.includes(n.id)).length : 0),
    ),
    onSettled: settle,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.dismiss({ id }),
    onMutate: (id) => optimistic(
      (r) => r.filter((n) => n.id !== id),
      (c) => c - (rows.some((n) => n.id === id && !n.read) ? 1 : 0),
    ),
    onSettled: settle,
  });
  const itemOf = (el: HTMLElement) => rows.find((n) => n.id === el.dataset.id);

  return (
    <ResponsivePopover open={open} opener={opener ?? undefined} onClose={onClose} placement="Bottom" horizontalAlign="End"
      headerText={ui.getText("UI_NOTIF_TITLE")} style={{ width: "26rem", maxWidth: "100%" }}
      // headerText, not a header slot: a slotted header replaces the popover's own (on a phone, the
      // dialog's close button with it), so the actions live in the footer, as in PageMessages.
      footer={
        <Bar design="Footer"
          endContent={<>
            <Button design="Transparent" disabled={!rows.some((n) => !n.read)} onClick={() => markRead.mutate(undefined)}>
              {ui.getText("UI_NOTIF_MARK_ALL")}</Button>
            <Button design="Transparent" icon="action-settings" tooltip={ui.getText("UI_NOTIF_SETTINGS")}
              onClick={() => { onClose(); onSettings(); }} />
          </>} />
      }>
      {list.error ? <MessageStrip design="Negative" hideCloseButton>{list.error.message}</MessageStrip> : null}
      <BusyIndicator active={list.isPending && open} style={{ width: "100%" }}>
        <NotificationList noDataText={list.isPending ? "" : ui.getText("UI_NOTIF_EMPTY")} style={{ width: "100%" }}
          onItemClick={(e) => {
            const n = itemOf(e.detail.item);
            if (!n) return;
            if (!n.read) markRead.mutate([n.id]);
            onClose();
            onNavigate(n.path);
          }}
          onItemClose={(e) => {
            const n = itemOf(e.detail.item);
            if (n) dismiss.mutate(n.id);
          }}>
          {rows.map((n) => (
            <NotificationListItem key={n.id} data-id={n.id} titleText={titleOf(n, getText)} read={n.read} showClose
              wrappingType="Normal" state={STATE[n.type] ?? "None"}
              footnotes={<>
                <Label>{String(n.params.projectName ?? n.params.cardCode ?? "")}</Label>
                <Label>{ago(n.createdAt)}</Label>
              </>}>
              {String(n.params.note ?? n.params.fileName ?? "")}
            </NotificationListItem>
          ))}
        </NotificationList>
      </BusyIndicator>
    </ResponsivePopover>
  );
}

/** The Notifications page's table: every type the user can receive, grouped, with a Bell and a Mail
 *  switch each. A switch saves on change — optimistic, put back with a toast if the save fails. */
export function NotificationSettings({ api, getText, intro }: {
  api: Pick<NotificationsApi, "settings" | "setPreference">;
  getText: GetText;
  /** what this side's page says above the table */
  intro: string;
}) {
  const ui = useUiI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: SETTINGS, queryFn: () => api.settings() });
  const flip = (p: Preference, on: boolean) =>
    qc.setQueryData<NotificationSetting[]>(SETTINGS, (r) => r?.map((t) => (t.id === p.type ? { ...t, [p.channel]: on } : t)));
  const save = useMutation({
    mutationFn: (p: Preference) => api.setPreference(p),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: SETTINGS });
      flip(p, p.enabled);
    },
    onError: (e, p) => {
      flip(p, !p.enabled);
      toast(ui.getText("UI_NOTIF_SAVE_FAILED", e.message));
    },
  });
  // Catalog order, one group row before each group's first type.
  const groups = Map.groupBy(q.data ?? [], (t) => t.group);

  return (
    <div style={{ padding: "1rem", maxWidth: 840, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Title level="H3">{ui.getText("UI_NOTIF_TITLE")}</Title>
      <Text>{intro}</Text>
      {q.error ? <MessageStrip design="Negative" hideCloseButton>{q.error.message}</MessageStrip> : null}
      <Table accessibleName={ui.getText("UI_NOTIF_TITLE")} overflowMode="Popin" loading={q.isPending}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="16rem">{ui.getText("UI_NOTIF_EVENT")}</TableHeaderCell>
            <TableHeaderCell width="6rem" horizontalAlign="Center">{ui.getText("UI_NOTIF_BELL")}</TableHeaderCell>
            <TableHeaderCell width="6rem" horizontalAlign="Center">{ui.getText("UI_NOTIF_MAIL")}</TableHeaderCell>
          </TableHeaderRow>
        }>
        {[...groups].flatMap(([group, types]) => [
          <TableGroupRow key={`group:${group}`}>{ui.getText(`UI_NOTIF_GROUP_${group.toUpperCase()}`)}</TableGroupRow>,
          ...types.map((t) => {
            const label = getText(textKey(t.id));
            const toggle = (channel: Preference["channel"], checked: boolean) => (
              <Switch checked={checked}
                accessibleName={ui.getText(channel === "bell" ? "UI_NOTIF_BELL_FOR" : "UI_NOTIF_MAIL_FOR", label)}
                onChange={(e) => save.mutate({ type: t.id, channel, enabled: e.target.checked })} />
            );
            return (
              <TableRow key={t.id} rowKey={t.id}>
                <TableCell>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem" }}>
                    <Text>{label}</Text>
                    <Text style={{ color: "var(--sapContent_LabelColor)" }}>{getText(`${textKey(t.id)}_DESC`)}</Text>
                  </div>
                </TableCell>
                <TableCell horizontalAlign="Center">{toggle("bell", t.bell)}</TableCell>
                <TableCell horizontalAlign="Center">{toggle("mail", t.mail)}</TableCell>
              </TableRow>
            );
          }),
        ])}
      </Table>
    </div>
  );
}

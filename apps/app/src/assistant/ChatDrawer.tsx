import { useRef, useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Icon, Menu, MenuItem } from "@ui5/webcomponents-react";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../i18n.ts";
import { client, orpc } from "../orpc.ts";
import { refusalText } from "./ChatView.tsx";
import { RenameField } from "./RenameField.tsx";
import type { Thread } from "./useAssistant.ts";

// The panel's chats behind ☰ (Joule spec §5.3): the user's chats in two groups (Pinned, Chats) — New
// chat is the panel header's — each row's ••• for Pin, Rename and Delete. In the card it slides over the chat's left edge;
// maximized it is a sidebar beside it.

export type ChatRow = Awaited<ReturnType<typeof client.assistant.threads>>[number];

/** The user's chats and what can be done to one. */
export function useChats() {
  const i18n = useI18n();
  const t = (k: string) => i18n.getText(k);
  const qc = useQueryClient();
  const rows = useQuery(orpc.assistant.threads.queryOptions({ input: undefined })).data ?? [];
  const label = (r: ChatRow) => r.title || r.reportTitle || r.projectName || t("ASSISTANT_UNTITLED");
  const refresh = (r: ChatRow) => {
    void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
    if (r.reportId) {
      void qc.invalidateQueries({ queryKey: orpc.reports.get.key() });
      void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
    }
  };
  const act = async (r: ChatRow, fn: () => Promise<unknown>) => {
    try { await fn(); return true; } catch (e) { toast(refusalText(i18n, e)); return false; } finally { refresh(r); }
  };
  return {
    rows, label,
    pin: (r: ChatRow) => act(r, () => client.assistant.pinThread({ id: r.id, pinned: !r.pinned })),
    rename: (r: ChatRow, title: string | null) => {
      if (title?.trim() && title.trim() !== label(r)) void act(r, () => client.assistant.renameThread({ id: r.id, title }));
    },
    /** Asks first; a report's chat takes its report with it (the DB cascade). Answers whether it deleted. */
    remove: async (r: ChatRow) => {
      const message = t(r.reportId ? "ASSISTANT_DELETE_REPORT_CONFIRM" : "ASSISTANT_DELETE_CONFIRM");
      if (!(await confirm({ message, actionText: t("ASSISTANT_DELETE"), destructive: true }))) return false;
      return act(r, async () => {
        await client.assistant.deleteThread({ id: r.id });
        // Every cached copy goes (by id, by configuration, the general one): none may come back as a chat.
        qc.removeQueries({ queryKey: orpc.assistant.thread.key(), predicate: (x) => (x.state.data as Thread | undefined)?.id === r.id });
      });
    },
  };
}
export type Chats = ReturnType<typeof useChats>;

/** A row's menu: Pin/Unpin, Rename, Delete. It acts once it has closed: it hands focus back to its
 *  opener as it closes, which would take it from a rename field. */
function ChatMenu({ opener, pinned, onAction }: {
  opener: HTMLElement | null; pinned: boolean; onAction(a: string | null): void;
}) {
  const i18n = useI18n();
  const t = (k: string) => i18n.getText(k);
  const picked = useRef<string | null>(null);
  return (
    <Menu open={!!opener} opener={opener ?? undefined}
      onItemClick={(e) => { picked.current = (e.detail.item as HTMLElement).dataset.action ?? null; }}
      onClose={() => { const a = picked.current; picked.current = null; onAction(a); }}>
      <MenuItem data-action="pin" icon={pinned ? "pushpin-off" : "pushpin-on"} text={t(pinned ? "ASSISTANT_UNPIN" : "ASSISTANT_PIN")} />
      <MenuItem data-action="rename" icon="edit" text={t("ASSISTANT_RENAME")} />
      <MenuItem data-action="delete" icon="delete" text={t("ASSISTANT_DELETE")} />
    </Menu>
  );
}

const ROW: CSSProperties = {
  display: "flex", alignItems: "center", height: "2rem", borderRadius: "0.375rem", paddingInlineStart: "0.5rem",
};
const PLAIN: CSSProperties = {
  all: "unset", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer",
};
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function ChatDrawer({ open, mode, openId, chats, onPick, onHide, onRemoved }: {
  open: boolean; mode: "card" | "sidebar"; openId: string | null; chats: Chats;
  onPick(r: ChatRow): void; onHide(): void; onRemoved(r: ChatRow): void;
}) {
  const i18n = useI18n();
  const t = (k: string) => i18n.getText(k);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ el: HTMLElement; row: ChatRow } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const onAction = async (a: string | null) => {
    const r = menu?.row;
    setMenu(null);
    if (!r) return;
    if (a === "pin") void chats.pin(r);
    if (a === "rename") setRenaming(r.id);
    if (a === "delete" && await chats.remove(r)) onRemoved(r);
  };

  const group = (key: string, name: string, rows: ChatRow[]) => !rows.length ? null : (
    <section key={key}>
      <button type="button" aria-expanded={!collapsed[key]} onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
        style={{ all: "unset", display: "flex", alignItems: "center", gap: "0.5rem", width: "100%", padding: "0.5rem", boxSizing: "border-box", cursor: "pointer", fontWeight: "bold" }}>
        <span style={{ flex: 1 }}>{name}</span>
        <span style={{ color: "var(--cf-a-accent)", background: "var(--cf-a-accent-soft)", borderRadius: "0.5rem", padding: "0 0.375rem", fontSize: "0.75rem" }}>{rows.length}</span>
        <Icon name={collapsed[key] ? "slim-arrow-right" : "slim-arrow-down"} style={{ color: "inherit" }} />
      </button>
      {collapsed[key] ? null : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.id} style={{
              ...ROW,
              background: r.id === openId ? "linear-gradient(to right, var(--cf-a-accent) 0.188rem, var(--cf-a-accent-soft) 0.188rem)" : undefined,
            }}>
              {renaming === r.id
                ? <RenameField value={chats.label(r)} label={t("ASSISTANT_RENAME")} onDone={(v) => { setRenaming(null); chats.rename(r, v); }} />
                : <button type="button" style={PLAIN} aria-current={r.id === openId || undefined} onClick={() => onPick(r)}>{chats.label(r)}</button>}
              <Button design="Transparent" icon="overflow" tooltip={t("ASSISTANT_CHAT_ACTIONS")} accessibleName={t("ASSISTANT_CHAT_ACTIONS")}
                accessibilityAttributes={{ hasPopup: "menu" }} style={{ "--sapButton_Lite_TextColor": "var(--cf-a-more)" } as CSSProperties}
                onClick={(e) => setMenu({ el: e.currentTarget as HTMLElement, row: r })} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const card = mode === "card";
  return (
    <nav aria-label={t("ASSISTANT_CHATS")} inert={!open}
      style={{
        width: "16rem", flex: "none", boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "0.5rem",
        padding: "0 0.5rem 0.5rem", overflowY: "auto",
        background: "var(--cf-a-page)", color: "var(--cf-a-text)", fontFamily: "var(--sapFontFamily)", fontSize: "var(--sapFontSize)",
        ...(card ? {
          position: "absolute", insetBlock: 0, insetInlineStart: 0, zIndex: 1, boxShadow: "2px 0 8px rgba(0,0,0,.1)",
          transform: open ? "none" : "translateX(-100%)", visibility: open ? "visible" : "hidden",
          transition: reduced() ? "none" : open ? "transform 0.2s ease-out" : "transform 0.2s ease-out, visibility 0s 0.2s",
        } : { display: open ? "flex" : "none", borderInlineEnd: "1px solid var(--sapGroup_TitleBorderColor)" }),
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.25rem", height: "2.625rem", flex: "none" }}>
        <Button design="Transparent" icon="menu2" tooltip={t("ASSISTANT_CHATS")} accessibleName={t("ASSISTANT_CHATS")}
          accessibilityAttributes={{ expanded: open }} onClick={onHide} />
        <span style={{ fontWeight: "bold", fontSize: "1rem" }}>{t("ASSISTANT_TITLE")}</span>
      </div>
      {group("pinned", t("ASSISTANT_PINNED"), chats.rows.filter((r) => r.pinned))}
      {group("chats", t("ASSISTANT_CHATS"), chats.rows.filter((r) => !r.pinned))}
      <ChatMenu opener={menu?.el ?? null} pinned={!!menu?.row.pinned} onAction={(a) => void onAction(a)} />
    </nav>
  );
}

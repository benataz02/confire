import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Bar, BusyIndicator, Button, FlexBox, Input, Menu, MenuItem, MessageStrip,
  type InputDomRef,
} from "@ui5/webcomponents-react";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../i18n.ts";
import { client, orpc } from "../orpc.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { ChatView, refusalText, useRoute, type HeadState } from "./ChatView.tsx";
import type { Thread } from "./useAssistant.ts";

// The AI page (assistant spec §4.2): one chat, its bar above it. The user's chats are found with the
// shell's search, which this page scopes to them (GlobalSearch); the chat's title opens its menu (pin,
// rename, delete). `/assistant` is a new chat (the user's blank thread, `blankThread`),
// `/assistant/<chat>` one of theirs. The panel is not drawn here (AssistantProvider), so leaving
// mid-answer stops the answer, as Stop does.

type Row = { id: string; title: string; projectId: string | null; projectName: string | null; pinned: boolean; updatedAt: Date };
type Action = "pin" | "rename" | "delete";

export function AssistantPage({ threadId }: { threadId: string | null }) {
  const i18n = useI18n();
  const t = (k: string) => i18n.getText(k);
  const qc = useQueryClient();
  const shell = useAssistantShell();
  const navigate = useNavigate({ from: "/$slug" });
  const route = useRoute();

  // A new chat is the user's blank thread, under its own address.
  const [newError, setNewError] = useState<unknown>(null);
  useEffect(() => {
    if (threadId) return;
    client.assistant.newThread({}).then(
      ({ id }) => navigate({ to: "/$slug/assistant/$id", params: { id }, replace: true }), setNewError);
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  const thread = useQuery({ ...orpc.assistant.thread.queryOptions({ input: { id: threadId ?? "" } }), enabled: !!threadId, staleTime: Infinity });

  // The user's chats: what names the open one and says whether it is pinned.
  const all = useQuery(orpc.assistant.threads.queryOptions({ input: undefined }));
  const label = (r: Row) => r.title || r.projectName || t("ASSISTANT_UNTITLED");
  const current = all.data?.find((r) => r.id === threadId);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const picked = useRef<Action | null>(null);
  const [renaming, setRenaming] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { toast(refusalText(i18n, e)); }
    void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
  };
  const rename = (r: Row, title: string | null) => {
    setRenaming(false);
    if (title?.trim() && title.trim() !== label(r)) void act(() => client.assistant.renameThread({ id: r.id, title }));
  };
  const remove = async (r: Row) => {
    if (!(await confirm({ message: t("ASSISTANT_DELETE_CONFIRM"), actionText: t("ASSISTANT_DELETE"), destructive: true }))) return;
    await act(async () => {
      await client.assistant.deleteThread({ id: r.id });
      // Every cached copy goes, the panel's by configuration too: none may come back as a chat.
      qc.removeQueries({ queryKey: orpc.assistant.thread.key(), predicate: (x) => (x.state.data as Thread | undefined)?.id === r.id });
      if (r.id === threadId) void navigate({ to: "/$slug/assistant" });
    });
  };
  // The title's menu acts once it has closed: it hands focus back to its button as it closes, which
  // would otherwise take it from the rename field straight away.
  const onMenuClosed = () => {
    const a = picked.current;
    picked.current = null;
    setMenu(null);
    if (!current) return;
    if (a === "pin") void act(() => client.assistant.pinThread({ id: current.id, pinned: !current.pinned }));
    if (a === "rename") setRenaming(true);
    if (a === "delete") void remove(current);
  };

  // To the configuration's form, the chat open beside it in the panel.
  const openConfig = (id: string) => {
    if (!shell.open) shell.toggle();
    void navigate({ to: "/$slug/configs/$id", params: { id } });
  };

  // A new chat has nothing to put on the bar, so it has none.
  const bar = ({ busy, projectId, empty }: HeadState) => (empty && !projectId ? null : (
    <Bar
      startContent={!empty && current ? (renaming
        ? <RenameField value={label(current)} label={t("ASSISTANT_RENAME")} onDone={(v) => rename(current, v)} />
        : (
          <Button design="Transparent" endIcon="slim-arrow-down" tooltip={t("ASSISTANT_CHAT_ACTIONS")} style={{ maxWidth: "20rem" }}
            accessibilityAttributes={{ hasPopup: "menu", expanded: !!menu }} onClick={(e) => setMenu(e.currentTarget as HTMLElement)}>
            {label(current)}
          </Button>
        )) : null}
      endContent={
        <>
          {/* Waits for the answer: leaving mid-answer would stop it. */}
          {projectId ? (
            <Button design="Transparent" icon="sales-quote" disabled={busy} onClick={() => openConfig(projectId)}>{t("ASSISTANT_OPEN_CONFIG")}</Button>
          ) : null}
          {!empty ? <Button design="Transparent" icon="write-new" onClick={() => void navigate({ to: "/$slug/assistant" })}>{t("ASSISTANT_NEW_CHAT")}</Button> : null}
        </>
      } />
  ));
  const error = thread.error ?? newError ?? all.error;

  return (
    <FlexBox direction="Column" style={{ height: "100%", background: "var(--sapBackgroundColor)" }}>
      {thread.data ? (
        <ChatView key={thread.data.id} thread={thread.data} route={route} page
          kind={thread.data.projectId ? "configure" : "general"} head={bar} />
      ) : (
        error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, error)}</MessageStrip>
          : <BusyIndicator active style={{ margin: "auto" }} />
      )}
      <Menu open={!!menu} opener={menu ?? undefined} onClose={onMenuClosed}
        onItemClick={(e) => { picked.current = (e.detail.item as HTMLElement).dataset.action as Action; }}>
        <MenuItem data-action="pin" icon={current?.pinned ? "pushpin-off" : "pushpin-on"} text={t(current?.pinned ? "ASSISTANT_UNPIN" : "ASSISTANT_PIN")} />
        <MenuItem data-action="rename" icon="edit" text={t("ASSISTANT_RENAME")} />
        <MenuItem data-action="delete" icon="delete" text={t("ASSISTANT_DELETE")} />
      </Menu>
    </FlexBox>
  );
}

/** The chat's title as a field: Enter or leaving it saves, Escape keeps the old one. */
function RenameField({ value, label, onDone }: { value: string; label: string; onDone(v: string | null): void }) {
  const ref = useRef<InputDomRef>(null);
  const done = useRef(false);
  const finish = (v: string | null) => { if (!done.current) { done.current = true; onDone(v); } };
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Input ref={ref} value={value} maxlength={200} accessibleName={label} style={{ width: "20rem" }}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(ref.current?.value ?? value);
        if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      }}
      onBlur={() => finish(ref.current?.value ?? value)} />
  );
}

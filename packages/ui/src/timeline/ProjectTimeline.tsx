import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Button, FileUploader, Icon, IllustratedMessage, Link, MessageStrip, ObjectStatus, Text, Timeline,
  TimelineGroupItem, TimelineItem, ToggleButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoActivities.js";
import { addCustomCSS } from "@ui5/webcomponents-base/dist/Theming.js";
import { useUiI18n } from "../i18n.ts";
import { money } from "../money.ts";
import { formatLocale, parseIsoDate } from "../format.ts";
import { PrintActions } from "../PrintActions.tsx";
import { FILE_MAX_MB, fileSize, fileUrl } from "../files.ts";
import { Composer, ROUND_BUTTON, type ComposerLook } from "../Composer.tsx";
import { chaptersOf, mergeEntries, oneToOne, type Chapter, type Entry } from "./chapters.ts";

// A project's timeline (spec §8), for both apps: one merged, time-ordered feed of the project's
// events and the SAP documents its quotations became, one entry per document (mergeEntries), and its
// comment box (TimelineComposer). Props-driven — each app passes its own data and its own comment and
// upload calls; the fence is the server's (the portal is sent external events only), nothing here hides a secret.

export type TimelineEvent = {
  id: string;
  at: Date;
  kind: string;
  actorSide: "internal" | "external";
  actorName: string | null;
  visibility: "external" | "internal";
  note: string | null;
  payload: unknown;
};

export type TimelineDoc = {
  entity: string; docEntry: number; docNum: number; docDate: string; docTotal: number; docStatus: string;
};
export type TimelineDocuments = { quotations: { quotation: TimelineDoc; chain: TimelineDoc[]; current: boolean }[] };

const ENTITY: Record<string, { key: string; icon: string }> = {
  Quotations: { key: "UI_DOC_QUOTATION", icon: "sales-quote" },
  Orders: { key: "UI_DOC_ORDER", icon: "sales-order" },
  DeliveryNotes: { key: "UI_DOC_DELIVERY", icon: "shipping-status" },
  Invoices: { key: "UI_DOC_INVOICE", icon: "receipt" },
};

type State = "None" | "Positive" | "Critical" | "Negative" | "Information";
/** Title key, icon and value state per event kind. `title` is an i18n key. */
const KIND: Record<string, { title: (side: "internal" | "external") => string; icon: string; state?: State }> = {
  created: { title: () => "UI_EVT_CREATED", icon: "add-document" },
  submitted: { title: () => "UI_STATUS_SUBMITTED", icon: "paper-plane", state: "Information" },
  resubmitted: { title: () => "UI_EVT_RESUBMITTED", icon: "paper-plane", state: "Information" },
  withdrawn: { title: () => "UI_EVT_WITHDRAWN", icon: "undo" },
  accepted: { title: () => "UI_STATUS_IN_REVIEW", icon: "accept", state: "Information" },
  returned: { title: () => "UI_STATUS_CHANGES", icon: "edit", state: "Critical" },
  declined: { title: () => "UI_STATUS_DECLINED", icon: "decline", state: "Negative" },
  quoted: { title: () => "UI_EVT_QUOTED", icon: "sales-quote", state: "Positive" },
  quote_accepted: { title: (s) => (s === "external" ? "UI_EVT_ACCEPTED_YOU" : "UI_EVT_ACCEPTED"), icon: "approvals", state: "Positive" },
  quote_declined: { title: (s) => (s === "external" ? "UI_EVT_DECLINED_YOU" : "UI_EVT_DECLINED_QUOTE"), icon: "cancel", state: "Critical" },
  comment: { title: () => "UI_EVT_COMMENT", icon: "comment" },
  file: { title: () => "UI_EVT_FILE", icon: "attachment" },
  // Staff only: the event is internal, so the portal is never sent it.
  assigned: { title: () => "UI_EVT_ASSIGNED", icon: "employee" },
  // A sales document Confire sent (document-mail spec §5.8); its title is built below.
  document_sent: { title: () => "UI_EVT_DOC", icon: "email" },
};

/** `document_sent`'s payload. `error` reaches staff only: the server drops it for the portal. */
type DocumentSent = { entity: string; docEntry: number; docNum: number | null; fileId: string; to: string[]; error?: string };
/** Why it was not emailed, in words: the two codes, else Microsoft's (or the print's) own message. */
const NOT_EMAILED: Record<string, string> = { NO_EMAIL: "UI_EVT_DOC_NO_EMAIL", NOT_CONNECTED: "UI_EVT_DOC_NOT_CONNECTED" };

const when = (d: Date) => d.toLocaleString(formatLocale(), { dateStyle: "medium", timeStyle: "short" });

// The reader's own items (`data-mine`) read like a chat's: text on the right and the bubble's point
// with it, the icons staying down one line. TimelineItem has no side and no ::part, so this goes into
// its shadow — the arrow rule is the item's own `:dir(rtl)` one. Every bubble keeps the point's room
// free on the right (the timeline scrolls, so an overhang would be clipped), so both sides are one width.
// The header is strings only, so the internal tag (`--cf-internal`) is drawn in it in the Tag's own
// theme colours, before the sender's name. The icon's tooltip (`--cf-tip`) is CSS too: iconTooltip is
// the browser's native one, whose delay nobody sets. Both are CSS strings (tipVars); unset, nothing draws.
// ponytail: UI5's private class and variable names, for every ui5-timeline-item (this is the apps' only
// Timeline); re-check on a UI5 upgrade, drop if it ships a side.
addCustomCSS("ui5-timeline-item", `
  :host .ui5-tli-bubble { margin-inline-end: var(--_ui5_TimelineItem_arrow_size); }
  :host([data-mine]) .ui5-tli-bubble { text-align: end; }
  :host([data-mine]) .ui5-tli-bubble-arrow--left { left: auto; right: calc(-1 * var(--_ui5_TimelineItem_arrow_size)); transform: scaleX(-1); }
  .ui5-tli-title::before {
    content: var(--cf-internal); display: inline-block; margin-inline-end: .375rem;
    font-size: var(--sapFontSmallSize); font-family: var(--sapFontBoldFamily); line-height: var(--_ui5-tag-height);
    padding: var(--_ui5-tag-text-padding); border: .0625rem solid var(--ui5-tag-set2-color-scheme-8-border);
    border-radius: var(--sapButton_BorderCornerRadius); background: var(--ui5-tag-set2-color-scheme-8-background);
    color: var(--ui5-tag-set2-color-scheme-8-color);
  }
  .ui5-tli-icon-outer::after {
    content: var(--cf-tip); position: absolute; top: 0; inset-inline-start: 100%; z-index: 1; white-space: nowrap;
    padding: .25rem .5rem; font-family: var(--sapFontFamily); font-size: var(--sapFontSmallSize); color: var(--sapTextColor);
    background: var(--sapGroup_ContentBackground); border: .0625rem solid var(--sapGroup_ContentBorderColor);
    border-radius: var(--sapElement_BorderCornerRadius); box-shadow: var(--sapContent_Shadow1);
    pointer-events: none; visibility: hidden; opacity: 0; transition: opacity .1s, visibility .1s;
  }
  .ui5-tli-icon-outer:hover::after { visibility: visible; opacity: 1; transition-delay: .25s; }
`);

/** The custom properties above: CSS strings, so a quote in a label cannot end one early. */
const tipVars = (tip: string, internal?: string) => ({
  "--cf-tip": JSON.stringify(tip), ...(internal ? { "--cf-internal": JSON.stringify(internal) } : {}),
}) as CSSProperties;

export function ProjectTimeline({
  events, loading, error, documents, documentsError, side, currency, onOpenDocument, canPreview, chapters, entryActions,
}: {
  events: TimelineEvent[] | undefined;
  loading?: boolean;
  error?: Error | null;
  /** live SAP: absent while loading, and its error costs these rows only */
  documents?: TimelineDocuments;
  documentsError?: Error | null;
  /** who is reading — the internal side sees internal notes */
  side: "internal" | "external";
  currency?: string;
  /** opens a document's object page; omit and documents render without a link */
  onOpenDocument?: (entity: string, docEntry: number) => void;
  /** a Preview of each document's SAP print layout, through the app's source — only for a reader the
   *  server lets print (any seat on the portal, admins internally) */
  canPreview?: boolean;
  /** group entries into the journey's chapters; labels are the six step names */
  chapters?: { labels: string[]; draft: boolean };
  /** extra controls under one event's content (the portal's decisions, Withdraw) */
  entryActions?: (e: TimelineEvent) => ReactNode;
}) {
  const i18n = useUiI18n();

  // Oldest first, like a chat: the newest sits right above the comment box.
  const entries = useMemo(() => mergeEntries(events, documents), [events, documents]);
  const groups = chapters ? chaptersOf(entries) : null;
  // Two people talking: the side an entry sits on says who wrote it.
  const named = !oneToOne(events);

  // "Quoted · 5 Nov – 7 Nov": the chapter's first and last day. A document counts by its posting date,
  // not the end-of-day sort key mergeEntries gave it (that would read as the next day east of UTC).
  const chapterTitle = (c: Chapter) => {
    const name = c.step === 0 && chapters?.draft ? i18n.getText("UI_CHAPTER_DRAFT") : chapters?.labels[c.step] ?? "";
    const days = c.entries.map((x) => (x.kind === "doc" ? parseIsoDate(x.d.docDate)?.getTime() ?? 0 : x.at)).filter(Boolean);
    if (!days.length) return name;
    const day = (t: number) => new Date(t).toLocaleDateString(formatLocale(), { day: "numeric", month: "short" });
    const [from, to] = [day(Math.min(...days)), day(Math.max(...days))];
    return i18n.getText("UI_CHAPTER_TITLE", name, from === to ? from : `${from} – ${to}`);
  };

  const docName = (entity: string, num: number) => `${ENTITY[entity] ? i18n.getText(ENTITY[entity]!.key) : entity} ${num}`;

  const renderEntry = (x: Entry) => {
    // Who it is from: the event, or the mail that sent a SAP document; a document nobody sent from here has no author.
    const e = x.kind === "event" ? x.e : x.sent;
    const sentEvent = x.sent ?? (e?.kind === "document_sent" ? e : undefined);
    const sent = sentEvent?.payload as DocumentSent | null | undefined;
    const doc = x.kind === "doc" ? x.d : x.doc;
    const q = e?.kind === "quoted" ? e.payload as { docNum?: number | null; mode?: string; value?: number } | null : null;
    const f = e?.kind === "file" ? e.payload as { fileId: string; name: string; size: number } | null : null;
    const known = e ? KIND[e.kind] : undefined;
    const k = known ?? { title: () => e?.kind ?? "", icon: "history" };
    const name = x.kind === "doc" ? docName(x.d.entity, x.d.docNum) : sent ? docName(sent.entity, sent.docNum ?? sent.docEntry) : "";
    const entity = x.kind === "doc" ? x.d.entity : sent?.entity;
    const title = q ? i18n.getText(q.mode === "updated" ? "UI_QUOTE_UPDATED" : "UI_QUOTE_SENT", q.docNum == null ? "" : String(q.docNum)).replace(/\s+/g, " ")
      : x.kind === "doc" || sent ? name
      : e?.kind === "assigned" ? i18n.getText("UI_EVT_ASSIGNED", (e.payload as { assigneeName?: string } | null)?.assigneeName ?? "")
      : e?.kind === "created" && (e.payload as { via?: string } | null)?.via === "assistant" ? i18n.getText("UI_EVT_CREATED_ASSISTANT")
      : e?.kind === "created" && (e.payload as { via?: string } | null)?.via === "mcp" ? i18n.getText("UI_EVT_CREATED_MCP")
      : known ? i18n.getText(k.title(side)) : k.title(side);
    const mine = e?.actorSide === side;
    return (
      <TimelineItem key={x.kind === "doc" ? `${x.d.entity}:${x.d.docEntry}` : x.e.id} icon={(entity && ENTITY[entity]?.icon) || k.icon}
        state={sent?.to.length ? "Positive" : x.kind === "doc" ? "None" : k.state ?? "None"} titleText={title}
        name={named ? e?.actorName ?? undefined : undefined} data-mine={mine || undefined}
        subtitleText={e ? when(new Date(e.at)) : parseIsoDate(doc!.docDate)?.toLocaleDateString(formatLocale())}
        style={tipVars(title, e?.visibility === "internal" ? i18n.getText("UI_INTERNAL_TAG") : undefined)}>
        {/* The body sits on its side as a block; a note's lines still read from the left. */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", textAlign: "start", alignItems: mine ? "flex-end" : "flex-start" }}>
          {q?.value !== undefined ? <Text>{money(q.value, currency)}</Text> : null}
          {x.kind === "doc" ? <Text>{money(x.d.docTotal, currency)}</Text> : null}
          {f ? <Link href={fileUrl(f.fileId)} icon="download">{`${f.name} (${fileSize(f.size)})`}</Link> : null}
          {/* The PDF as it was sent, not a fresh print. */}
          {sent ? <Link href={fileUrl(sent.fileId)} icon="pdf-attachment">{`${name}.pdf`}</Link> : null}
          {/* A mail that left: the recipients by the envelope, as "Not emailed" says why one did not. */}
          {sent?.to.length ? (
            <ObjectStatus state="Positive" icon={<Icon name="email" />}>{i18n.getText("UI_EVT_DOC_EMAILED", sent.to.join(", "))}</ObjectStatus>
          ) : null}
          {sent?.error ? (
            <ObjectStatus state="Critical" showDefaultIcon>
              {i18n.getText("UI_EVT_DOC_NOT_EMAILED", NOT_EMAILED[sent.error] ? i18n.getText(NOT_EMAILED[sent.error]!) : sent.error)}
            </ObjectStatus>
          ) : null}
          {e?.note ? <Text style={{ whiteSpace: "pre-wrap" }}>{e.note}</Text> : null}
          {doc && (onOpenDocument || canPreview) ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              {onOpenDocument ? (
                <Button design="Transparent" icon="document-text" onClick={() => onOpenDocument(doc.entity, doc.docEntry)}>{i18n.getText("UI_OPEN")}</Button>
              ) : null}
              {canPreview ? <PrintActions entity={doc.entity} docEntry={doc.docEntry} /> : null}
            </div>
          ) : null}
          {x.kind === "event" ? entryActions?.(x.e) : null}
        </div>
      </TimelineItem>
    );
  };

  return (
    // Centered in the section: a reading column, not a strip down the left of a wide page.
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", width: "100%", maxWidth: "60rem", marginInline: "auto" }}>
      {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
      {documentsError ? (
        <MessageStrip design="Critical" hideCloseButton>
          {i18n.getText("UI_SAP_UNAVAILABLE", documentsError.message)}
        </MessageStrip>
      ) : null}
      {!loading && !entries.length ? (
        <IllustratedMessage name="NoActivities" design="Small" titleText={i18n.getText("UI_TIMELINE_EMPTY_TITLE")}
          subtitleText={i18n.getText("UI_TIMELINE_EMPTY_SUB")} />
      ) : (
        <Timeline loading={loading} accessibleName={i18n.getText("UI_TIMELINE")}>
          {groups
            ? groups.map((c) => (
              <TimelineGroupItem key={c.step} groupName={chapterTitle(c)} data-chapter={c.step}>
                {c.entries.map(renderEntry)}
              </TimelineGroupItem>
            ))
            : entries.map(renderEntry)}
        </Timeline>
      )}
    </div>
  );
}

export type ProjectTimelineProps = Parameters<typeof ProjectTimeline>[0];

/** A project's comment box: a note, staff's internal-only toggle, and a file. ProjectOverview keeps it in
 *  the page's floating footer, so it stays in view however far the timeline scrolls. */
export function TimelineComposer({ side, onComment, onUpload, look }: {
  /** who is writing — the internal side gets the internal-only toggle */
  side: "internal" | "external";
  onComment: (note: string, internalOnly: boolean) => Promise<unknown>;
  /** attach a file (≤ 10 MB, any type); omit for a reader who may not upload (a portal viewer).
   *  Staff's internal-only toggle applies to it as to a comment. */
  onUpload?: (file: File, internalOnly: boolean) => Promise<unknown>;
  /** the pill's colours; the theme's field look if absent */
  look?: ComposerLook;
}) {
  const i18n = useUiI18n();
  const [note, setNote] = useState("");
  const [internalOnly, setInternalOnly] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  // Remounts the uploader after each pick, so choosing the same file again still fires a change.
  const [picks, setPicks] = useState(0);

  const busy = async (work: () => Promise<unknown>, after: () => void) => {
    setPosting(true);
    setPostError(null);
    try {
      await work();
      after();
      setInternalOnly(false);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  };
  const post = () => note.trim()
    ? busy(() => onComment(note.trim(), side === "internal" && internalOnly), () => setNote(""))
    : Promise.resolve();
  const attach = (file: File | undefined) => {
    setPicks((n) => n + 1);
    if (!file || !onUpload) return;
    if (file.size > FILE_MAX_MB * 1024 * 1024) return setPostError(i18n.getText("UI_FILE_MAX", String(FILE_MAX_MB)));
    void busy(() => onUpload(file, side === "internal" && internalOnly), () => {});
  };

  // Leading: attach, then staff's internal-only switch; trailing: the round send.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Composer value={note} onInput={setNote} onSend={() => void post()} maxlength={4000} disabled={posting} look={look}
        placeholder={i18n.getText(side === "internal" ? "UI_COMMENT_STAFF" : "UI_COMMENT_CLIENT")} accessibleName={i18n.getText("UI_COMMENT")}
        leading={<>
          {onUpload ? (
            // No margin: the uploader wears an Input's .25rem, which made the row taller than the field.
            <FileUploader key={picks} hideInput maxFileSize={FILE_MAX_MB} disabled={posting} style={{ margin: 0 }}
              accessibleName={i18n.getText("UI_ATTACH_NAME")}
              onFileSizeExceed={() => { setPicks((n) => n + 1); setPostError(i18n.getText("UI_FILE_MAX", String(FILE_MAX_MB))); }}
              onChange={(e) => attach(e.detail.files?.[0])}>
              <Button design="Transparent" icon="attachment" tooltip={i18n.getText("UI_ATTACH")} disabled={posting} />
            </FileUploader>
          ) : null}
          {side === "internal" ? (
            // Off by default: a comment or file on a client's request is for the client unless said otherwise.
            <ToggleButton design="Transparent" icon="locked" pressed={internalOnly} disabled={posting}
              tooltip={i18n.getText("UI_INTERNAL_TOGGLE")} onClick={() => setInternalOnly((v) => !v)} />
          ) : null}
        </>}
        trailing={
          <Button design="Emphasized" icon="paper-plane" tooltip={i18n.getText("UI_POST")} accessibleName={i18n.getText("UI_POST")}
            disabled={posting || !note.trim()} style={ROUND_BUTTON} onClick={() => void post()} />
        } />
      {postError ? <MessageStrip design="Negative" hideCloseButton>{postError}</MessageStrip> : null}
    </div>
  );
}

export type TimelineComposerProps = Parameters<typeof TimelineComposer>[0];

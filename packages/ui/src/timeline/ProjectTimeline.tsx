import { useMemo, useState, type CSSProperties } from "react";
import {
  Button, CheckBox, FileUploader, IllustratedMessage, Link, MessageStrip, ObjectStatus, Text, TextArea, Timeline,
  TimelineItem,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoActivities.js";
import { addCustomCSS } from "@ui5/webcomponents-base/dist/Theming.js";
import { useUiI18n } from "../i18n.ts";
import { money } from "../money.ts";
import { formatLocale } from "../format.ts";
import { documentStatusText } from "../documentStatus.ts";
import { PrintActions } from "../PrintActions.tsx";
import { FILE_MAX_MB, fileSize, fileUrl } from "../files.ts";

// A project's timeline (spec §8), for both apps: one merged, time-ordered feed of the project's
// events and the SAP documents its quotations became, with a comment box. Props-driven — each app
// passes its own data and its own comment and upload calls; the fence is the server's (the portal is
// sent external events only), nothing here hides anything.

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
  revised: { title: () => "UI_EVT_REVISED", icon: "edit-outside" },
  quoted: { title: () => "UI_EVT_QUOTED", icon: "sales-quote", state: "Positive" },
  quote_accepted: { title: (s) => (s === "external" ? "UI_EVT_ACCEPTED_YOU" : "UI_EVT_ACCEPTED"), icon: "approvals", state: "Positive" },
  quote_declined: { title: (s) => (s === "external" ? "UI_EVT_DECLINED_YOU" : "UI_EVT_DECLINED_QUOTE"), icon: "cancel", state: "Critical" },
  comment: { title: () => "UI_EVT_COMMENT", icon: "comment" },
  file: { title: () => "UI_EVT_FILE", icon: "attachment" },
  // Staff only: the event is internal, so the portal is never sent it.
  assigned: { title: () => "UI_EVT_ASSIGNED", icon: "employee" },
};

const show = (v: unknown, yes: string, no: string): string =>
  v === undefined || v === null || v === "" ? "—"
  : Array.isArray(v) ? v.join(", ")
  : typeof v === "boolean" ? (v ? yes : no)
  : String(v);

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

/** A revision as readable lines: the model's labels, old → new. */
function Revision({ payload, labels }: { payload: unknown; labels: Record<string, string> }) {
  const i18n = useUiI18n();
  const yes = i18n.getText("UI_YES");
  const no = i18n.getText("UI_NO");
  const cell = (v: unknown) => show(v, yes, no);
  const p = payload as {
    entries?: Record<string, [unknown, unknown]>; batches?: [number[], number[]]; tables?: Record<string, [number, number]>;
  } | null;
  if (!p) return null;
  const lines = [
    ...Object.entries(p.entries ?? {}).map(([k, [a, b]]) => `${labels[k] ?? k}: ${cell(a)} → ${cell(b)}`),
    ...(p.batches ? [i18n.getText("UI_BATCH_QTY", cell(p.batches[0]), cell(p.batches[1]))] : []),
    ...Object.entries(p.tables ?? {}).map(([k, [a, b]]) =>
      `${labels[k] ?? k}: ${a === b
        ? i18n.getText(b === 1 ? "UI_ROW_CHANGED" : "UI_ROWS_CHANGED", String(b))
        : i18n.getText("UI_ROWS_TO", String(a), String(b))}`),
  ];
  return (
    <ul style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
      {lines.map((l) => <li key={l}><Text>{l}</Text></li>)}
    </ul>
  );
}

type Entry =
  | { at: number; kind: "event"; e: TimelineEvent }
  | { at: number; kind: "doc"; d: TimelineDoc; superseded: boolean };

export function ProjectTimeline({
  events, labels, loading, error, documents, documentsError, side, currency, canComment, onComment, onUpload,
  onOpenDocument, canPreview,
}: {
  events: TimelineEvent[] | undefined;
  labels: Record<string, string>;
  loading?: boolean;
  error?: Error | null;
  /** live SAP: absent while loading, and its error costs these rows only */
  documents?: TimelineDocuments;
  documentsError?: Error | null;
  /** who is reading — the internal side gets the internal-only toggle and sees internal notes */
  side: "internal" | "external";
  currency?: string;
  canComment: boolean;
  onComment: (note: string, internalOnly: boolean) => Promise<unknown>;
  /** attach a file (≤ 10 MB, any type); omit for a reader who may not upload (a portal viewer).
   *  Staff's internal-only toggle applies to it as to a comment. */
  onUpload?: (file: File, internalOnly: boolean) => Promise<unknown>;
  /** opens a document's object page; omit and documents render without a link */
  onOpenDocument?: (entity: string, docEntry: number) => void;
  /** a Preview of each document's SAP print layout, through the app's source — only for a reader the
   *  server lets print (any seat on the portal, admins internally) */
  canPreview?: boolean;
}) {
  const i18n = useUiI18n();
  const [note, setNote] = useState("");
  const [internalOnly, setInternalOnly] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Oldest first, like a chat: the newest sits right above the comment box.
  const entries = useMemo<Entry[]>(() => [
    ...(events ?? []).map((e) => ({ at: new Date(e.at).getTime(), kind: "event" as const, e })),
    ...(documents?.quotations ?? []).flatMap((q) => [q.quotation, ...q.chain].map((d) => ({
      // A document has a posting date, not a time: it sorts at the start of its day.
      at: new Date(d.docDate).getTime() || 0, kind: "doc" as const, d, superseded: !q.current && d.entity === "Quotations",
    }))),
  ].sort((a, b) => a.at - b.at), [events, documents]);

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
          {entries.map((x) => {
            if (x.kind === "doc") {
              const meta = ENTITY[x.d.entity];
              const docName = meta ? i18n.getText(meta.key) : x.d.entity;
              return (
                <TimelineItem key={`${x.d.entity}:${x.d.docEntry}`} icon={meta?.icon ?? "document"} style={tipVars(docName)}
                  titleText={i18n.getText(x.superseded ? "UI_DOC_TITLE_SUPERSEDED" : "UI_DOC_TITLE", docName, String(x.d.docNum))}
                  subtitleText={x.d.docDate ? new Date(x.d.docDate).toLocaleDateString(formatLocale()) : undefined}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                    <Text>{money(x.d.docTotal, currency)}</Text>
                    <ObjectStatus state={x.d.docStatus === "bost_Open" ? "Information" : "None"}>
                      {documentStatusText(x.d.docStatus, x.d.docStatus, i18n.getText.bind(i18n))}
                    </ObjectStatus>
                    {onOpenDocument ? (
                      <Link onClick={() => onOpenDocument(x.d.entity, x.d.docEntry)}>{i18n.getText("UI_OPEN")}</Link>
                    ) : null}
                    {canPreview ? <PrintActions entity={x.d.entity} docEntry={x.d.docEntry} /> : null}
                  </div>
                </TimelineItem>
              );
            }
            const e = x.e;
            const known = KIND[e.kind];
            const k = known ?? { title: () => e.kind, icon: "history" };
            const q = e.payload as { docNum?: number | null; mode?: string; value?: number } | null;
            const f = e.kind === "file" ? e.payload as { fileId: string; name: string; size: number } | null : null;
            const title = e.kind === "quoted" && q
              ? i18n.getText(q.mode === "updated" ? "UI_QUOTE_UPDATED" : "UI_QUOTE_SENT", q.docNum == null ? "" : String(q.docNum)).replace(/\s+/g, " ")
              : e.kind === "assigned" ? i18n.getText("UI_EVT_ASSIGNED", (e.payload as { assigneeName?: string } | null)?.assigneeName ?? "")
              : e.kind === "created" && (e.payload as { via?: string } | null)?.via === "assistant" ? i18n.getText("UI_EVT_CREATED_ASSISTANT")
              : known ? i18n.getText(k.title(side)) : k.title(side);
            const mine = e.actorSide === side;
            return (
              <TimelineItem key={e.id} icon={k.icon} state={k.state ?? "None"} titleText={title}
                name={e.actorName ?? undefined} subtitleText={when(new Date(e.at))} data-mine={mine || undefined}
                style={tipVars(title, e.visibility === "internal" ? i18n.getText("UI_INTERNAL_TAG") : undefined)}>
                {/* The body sits on its side as a block; a note's lines still read from the left. */}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", textAlign: "start", alignItems: mine ? "flex-end" : "flex-start" }}>
                  {e.kind === "revised" ? <Revision payload={e.payload} labels={labels} /> : null}
                  {e.kind === "quoted" && q?.value !== undefined ? <Text>{money(q.value, currency)}</Text> : null}
                  {f ? <Link href={fileUrl(f.fileId)} icon="download">{`${f.name} (${fileSize(f.size)})`}</Link> : null}
                  {e.note ? <Text style={{ whiteSpace: "pre-wrap" }}>{e.note}</Text> : null}
                </div>
              </TimelineItem>
            );
          })}
        </Timeline>
      )}
      {canComment || onUpload ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <TextArea value={note} rows={2} growing growingMaxRows={8} maxlength={4000} disabled={posting}
            placeholder={i18n.getText(side === "internal" ? "UI_COMMENT_STAFF" : "UI_COMMENT_CLIENT")}
            accessibleName={i18n.getText("UI_COMMENT")} onInput={(e) => setNote(e.target.value ?? "")} />
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {side === "internal" ? (
              // Off by default: a comment or file on a client's request is for the client unless said otherwise.
              <CheckBox text={i18n.getText("UI_INTERNAL_TOGGLE")} checked={internalOnly} disabled={posting}
                onChange={(e) => setInternalOnly(e.target.checked)} />
            ) : null}
            {onUpload ? (
              <FileUploader key={picks} hideInput maxFileSize={FILE_MAX_MB} disabled={posting} style={{ marginInlineStart: "auto" }}
                accessibleName={i18n.getText("UI_ATTACH_NAME")}
                onFileSizeExceed={() => { setPicks((n) => n + 1); setPostError(i18n.getText("UI_FILE_MAX", String(FILE_MAX_MB))); }}
                onChange={(e) => attach(e.detail.files?.[0])}>
                <Button design="Transparent" icon="attachment" disabled={posting}>{i18n.getText("UI_ATTACH")}</Button>
              </FileUploader>
            ) : null}
            <Button design="Default" icon="paper-plane" disabled={posting || !note.trim()}
              style={onUpload ? undefined : { marginInlineStart: "auto" }} onClick={() => void post()}>{i18n.getText("UI_POST")}</Button>
          </div>
          {postError ? <MessageStrip design="Negative" hideCloseButton>{postError}</MessageStrip> : null}
        </div>
      ) : null}
    </div>
  );
}

import { useMemo, useState } from "react";
import {
  Button, CheckBox, FileUploader, IllustratedMessage, Link, MessageStrip, ObjectStatus, Tag, Text, TextArea, Timeline,
  TimelineItem,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoActivities.js";
import { money } from "../money.ts";
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

const ENTITY: Record<string, { one: string; icon: string }> = {
  Quotations: { one: "Quotation", icon: "sales-quote" },
  Orders: { one: "Sales order", icon: "sales-order" },
  DeliveryNotes: { one: "Delivery", icon: "shipping-status" },
  Invoices: { one: "Invoice", icon: "receipt" },
};
const DOC_STATUS: Record<string, string> = { bost_Open: "Open", bost_Close: "Closed", bost_Paid: "Paid", bost_Delivered: "Delivered" };

type State = "None" | "Positive" | "Critical" | "Negative" | "Information";
/** Title, icon and value state per event kind. `who` is the other side as the reader names it. */
const KIND: Record<string, { title: (side: "internal" | "external") => string; icon: string; state?: State }> = {
  created: { title: () => "Project created", icon: "add-document" },
  submitted: { title: () => "Submitted", icon: "paper-plane", state: "Information" },
  resubmitted: { title: () => "Resubmitted", icon: "paper-plane", state: "Information" },
  withdrawn: { title: () => "Withdrawn", icon: "undo" },
  accepted: { title: () => "In review", icon: "accept", state: "Information" },
  returned: { title: () => "Changes requested", icon: "edit", state: "Critical" },
  declined: { title: () => "Declined", icon: "decline", state: "Negative" },
  revised: { title: () => "Configuration revised", icon: "edit-outside" },
  quoted: { title: () => "Quotation sent", icon: "sales-quote", state: "Positive" },
  quote_accepted: { title: (s) => (s === "external" ? "You accepted the quotation" : "Quotation accepted"), icon: "approvals", state: "Positive" },
  quote_declined: { title: (s) => (s === "external" ? "You declined the quotation" : "Quotation declined"), icon: "cancel", state: "Critical" },
  comment: { title: () => "Comment", icon: "comment" },
  file: { title: () => "File", icon: "attachment" },
};

const show = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "—"
  : Array.isArray(v) ? v.join(", ")
  : typeof v === "boolean" ? (v ? "Yes" : "No")
  : String(v);

const when = (d: Date) => d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A revision as readable lines: the model's labels, old → new. */
function Revision({ payload, labels }: { payload: unknown; labels: Record<string, string> }) {
  const p = payload as {
    entries?: Record<string, [unknown, unknown]>; batches?: [number[], number[]]; tables?: Record<string, [number, number]>;
  } | null;
  if (!p) return null;
  const lines = [
    ...Object.entries(p.entries ?? {}).map(([k, [a, b]]) => `${labels[k] ?? k}: ${show(a)} → ${show(b)}`),
    ...(p.batches ? [`Batch quantities: ${show(p.batches[0])} → ${show(p.batches[1])}`] : []),
    ...Object.entries(p.tables ?? {}).map(([k, [a, b]]) =>
      `${labels[k] ?? k}: ${a === b ? `${b} row${b === 1 ? "" : "s"} changed` : `${a} → ${b} rows`}`),
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
  const [note, setNote] = useState("");
  const [internalOnly, setInternalOnly] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // Newest first: the feed reads from what just happened, the comment box sits on top of it.
  const entries = useMemo<Entry[]>(() => [
    ...(events ?? []).map((e) => ({ at: new Date(e.at).getTime(), kind: "event" as const, e })),
    ...(documents?.quotations ?? []).flatMap((q) => [q.quotation, ...q.chain].map((d) => ({
      // A document has a posting date, not a time: it sorts at the start of its day.
      at: new Date(d.docDate).getTime() || 0, kind: "doc" as const, d, superseded: !q.current && d.entity === "Quotations",
    }))),
  ].sort((a, b) => b.at - a.at), [events, documents]);

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
    if (file.size > FILE_MAX_MB * 1024 * 1024) return setPostError(`A file can be up to ${FILE_MAX_MB} MB`);
    void busy(() => onUpload(file, side === "internal" && internalOnly), () => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "60rem" }}>
      {canComment || onUpload ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <TextArea value={note} rows={2} growing growingMaxRows={8} maxlength={4000} disabled={posting}
            placeholder={side === "internal" ? "Comment on this request" : "Ask a question or add a note"}
            accessibleName="Comment" onInput={(e) => setNote(e.target.value ?? "")} />
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {side === "internal" ? (
              // Off by default: a comment or file on a client's request is for the client unless said otherwise.
              <CheckBox text="Internal note (not shown to the client)" checked={internalOnly} disabled={posting}
                onChange={(e) => setInternalOnly(e.target.checked)} />
            ) : null}
            {onUpload ? (
              <FileUploader key={picks} hideInput maxFileSize={FILE_MAX_MB} disabled={posting} style={{ marginInlineStart: "auto" }}
                accessibleName="Attach a file"
                onFileSizeExceed={() => { setPicks((n) => n + 1); setPostError(`A file can be up to ${FILE_MAX_MB} MB`); }}
                onChange={(e) => attach(e.detail.files?.[0])}>
                <Button design="Transparent" icon="attachment" disabled={posting}>Attach file</Button>
              </FileUploader>
            ) : null}
            <Button design="Default" icon="paper-plane" disabled={posting || !note.trim()}
              style={onUpload ? undefined : { marginInlineStart: "auto" }} onClick={() => void post()}>Post</Button>
          </div>
          {postError ? <MessageStrip design="Negative" hideCloseButton>{postError}</MessageStrip> : null}
        </div>
      ) : null}
      {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
      {documentsError ? (
        <MessageStrip design="Critical" hideCloseButton>
          {`The SAP documents can't be shown right now: ${documentsError.message}`}
        </MessageStrip>
      ) : null}
      {!loading && !entries.length ? (
        <IllustratedMessage name="NoActivities" design="Small" titleText="Nothing here yet"
          subtitleText="Events, comments and documents of this project appear here." />
      ) : (
        <Timeline loading={loading} accessibleName="Project timeline">
          {entries.map((x) => {
            if (x.kind === "doc") {
              const meta = ENTITY[x.d.entity] ?? { one: x.d.entity, icon: "document" };
              return (
                <TimelineItem key={`${x.d.entity}:${x.d.docEntry}`} icon={meta.icon}
                  titleText={`${meta.one} ${x.d.docNum}${x.superseded ? " (superseded)" : ""}`}
                  subtitleText={x.d.docDate ? new Date(x.d.docDate).toLocaleDateString() : undefined}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                    <Text>{money(x.d.docTotal, currency)}</Text>
                    <ObjectStatus state={x.d.docStatus === "bost_Open" ? "Information" : "None"}>
                      {DOC_STATUS[x.d.docStatus] ?? x.d.docStatus}
                    </ObjectStatus>
                    {onOpenDocument ? (
                      <Link onClick={() => onOpenDocument(x.d.entity, x.d.docEntry)}>Open</Link>
                    ) : null}
                    {canPreview ? <PrintActions entity={x.d.entity} docEntry={x.d.docEntry} /> : null}
                  </div>
                </TimelineItem>
              );
            }
            const e = x.e;
            const k = KIND[e.kind] ?? { title: () => e.kind, icon: "history" };
            const q = e.payload as { docNum?: number | null; mode?: string; value?: number } | null;
            const f = e.kind === "file" ? e.payload as { fileId: string; name: string; size: number } | null : null;
            const title = e.kind === "quoted" && q
              ? `Quotation ${q.docNum ?? ""} ${q.mode === "updated" ? "updated" : "sent"}`.replace(/\s+/g, " ")
              : k.title(side);
            return (
              <TimelineItem key={e.id} icon={k.icon} state={k.state ?? "None"} titleText={title}
                name={e.actorName ?? undefined} subtitleText={when(new Date(e.at))}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  {e.visibility === "internal" ? <Tag design="Set2" colorScheme="8" style={{ alignSelf: "flex-start" }}>Internal note</Tag> : null}
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
    </div>
  );
}

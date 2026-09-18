import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Form, FormGroup, FormItem, Label, MessageStrip, ObjectPage,
  ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, Tag, Title, Toolbar,
  ToolbarButton,
} from "@ui5/webcomponents-react";
import { coerceKey, parseKeyParam, type B1Field } from "@confire/b1";
import type { Val } from "@confire/config-engine";
import { formatCell } from "../../listSpec.ts";
import { orpc } from "../../orpc.ts";
import { toast } from "../toast.ts";
import { EntityField } from "./EntityField.tsx";
import { PrintActions } from "./PrintActions.tsx";

// One B1 row as a Fiori ObjectPage: scalar fields in the header section, each complex collection
// as its own section.
//
// Editing is offered only where the server has a curated profile, and only on the fields that
// profile names — the page reads that from entities.profile rather than deciding for itself, so
// the button and the server rule cannot drift apart. Every save carries the ETag read with the
// row; a concurrent change comes back as a conflict instead of a silent overwrite.
//
// Display/edit is the Form's own switch: `accessibleMode` changes the markup and ARIA it emits,
// and `itemSpacing` goes Large -> Normal so the page does not jump when texts become inputs.
//
// The sections MUST be flat children of ObjectPage. It reads them with React.Children, which
// walks arrays but NOT fragments — a `<>…</>` around the collection sections is one opaque child,
// and the anchor bar then draws a single blank tab instead of one per section.

/** B1's BoStatus. Only the colour is ours; the text is the field's own enum label (bost_Open). */
const STATUS_DESIGN: Record<string, "Information" | "Positive" | "Neutral"> = {
  O: "Information", C: "Neutral", P: "Positive", D: "Positive",
};

/** The line that identifies the row: the profile's fields, else the first two non-key strings. */
function subtitleOf(fields: B1Field[], keys: string[], row: Record<string, unknown>, names?: string[]) {
  const picked = names?.length
    ? names.map((n) => fields.find((f) => f.name === n)).filter((f): f is B1Field => !!f)
    : fields.filter((f) => f.kind === "string" && !keys.includes(f.name)).slice(0, 2);
  return picked.map((f) => formatCell(row[f.name], f.edmType)).filter(Boolean).join(" · ");
}

/** Create mode: the caller owns the draft's origin and its write, this component only renders it.
 *  There is no `entityKey` and no ETag — nothing exists in SAP yet to guard against. */
export type CreateMode = {
  /** the seed to render and edit; the caller built it, the server built what it contains */
  row: Record<string, unknown>;
  /** Fiori's create-mode placeholder, e.g. "New quotation" */
  title: string;
  /** shown under the title actions, for whatever the caller cannot let the user change here */
  notice?: ReactNode;
  saving: boolean;
  error: string | null;
  onSave: (data: Record<string, Val | undefined>) => void;
  onCancel: () => void;
};

export function EntityObjectPage({
  entity, entityKey, scope = "internal", create,
}: { entity: string; entityKey?: string; scope?: "internal" | "portal"; create?: CreateMode }) {
  const navigate = useNavigate();
  const parsed = useMemo(() => parseKeyParam(entityKey ?? ""), [entityKey]);
  const portal = scope === "portal";

  const schema = useQuery({
    ...(portal
      ? orpc.portal.docs.schema.queryOptions({ input: { entity } })
      : orpc.entities.schema.queryOptions({ input: { entity } })),
    retry: false,
    // The server answers this from entity_meta in Postgres and never re-reads $metadata on its
    // own, so a day in the browser cache costs nothing: the Refresh button writes through with
    // setQueryData, and a reload falls back to the row.
    staleTime: 24 * 60 * 60_000,
  });
  // Skipped while creating: there is no key yet, and coerceKey throws on an empty one for any
  // composite-key entity. `creating` rather than `create` in the deps — the prop is a fresh object
  // every render.
  const creating = !!create;
  const key = useMemo(
    () => (creating || !schema.data ? parsed : coerceKey(schema.data, parsed)),
    [creating, schema.data, parsed],
  );
  // No profile fetch on the portal: nothing there is editable and entities.profile is admin-only.
  const meta = useQuery({ ...orpc.entities.profile.queryOptions({ input: { entity } }), staleTime: Infinity, enabled: !portal });
  const one = useQuery({
    ...(portal
      ? orpc.portal.docs.one.queryOptions({ input: { entity, key: key as string | number } })
      : orpc.entities.one.queryOptions({ input: { entity, key } })),
    enabled: !create && !!schema.data,
    retry: false,
    // A row this fresh is not worth a second read: the configurator's quote page seeds this cache
    // with SAP's own return-representation and navigates straight here, and without a window the
    // seed would be stale on arrival and refetched on mount. Saves and copies refetch explicitly.
    staleTime: 30_000,
  });

  const [draft, setDraft] = useState<Record<string, Val | undefined> | null>(null);

  const update = useMutation(orpc.entities.update.mutationOptions({
    onSuccess: () => { setDraft(null); toast("Saved to SAP"); void one.refetch(); },
  }));
  const copy = useMutation(orpc.entities.copy.mutationOptions({
    onSuccess: (r) => {
      toast(`${r.entity} ${r.docNum ?? r.docEntry} created`);
      navigate({ to: "/b1/$entity/$key", params: { entity: r.entity, key: String(r.docEntry) } });
    },
  }));

  const { scalars, collections, status } = useMemo(() => {
    const fields = schema.data?.fields ?? [];
    return {
      scalars: fields.filter((f) => f.kind !== "collection"),
      collections: fields.filter((f) => f.kind === "collection"),
      status: fields.find((f) => f.name === "DocumentStatus"),
    };
  }, [schema.data]);

  if (schema.isPending || (!create && schema.data && one.isPending)) return <BusyIndicator active delay={0} />;
  const loadError = schema.error ?? (create ? null : one.error);
  if (loadError) return <MessageStrip design="Negative" hideCloseButton>{loadError.message}</MessageStrip>;

  const row = create?.row ?? one.data!.row;
  const etag = create ? undefined : one.data!.etag;
  const keys = schema.data!.keys;
  const profile = meta.data?.profile ?? null;
  // Create edits the same fields an update does. `requiredOnCreate` is deliberately not folded in:
  // its entries are either already in `editable` or, like DocumentLines, the caller's to build.
  const editable = new Set(profile?.editable ?? []);
  // A create page has nothing to display — it opens in edit mode and stays there.
  const editing = create ? true : draft !== null;
  const value = (name: string) => (draft && name in draft ? draft[name] : row[name]);
  const statusDesign = status ? STATUS_DESIGN[String(row.DocumentStatus)] : undefined;

  return (
    <ObjectPage
      titleArea={
        <ObjectPageTitle
          header={
            <Title>
              {create
                ? create.title
                : String(row[profile?.titleField ?? keys[0] ?? ""] ?? keys.map((k) => row[k]).join(" / "))}
            </Title>
          }
          subHeader={<span>{subtitleOf(scalars, keys, row, profile?.subtitleFields)}</span>}
          actionsBar={
            // Nothing in here applies to a document that does not exist yet: there is no row to
            // print, nothing to copy from, no display mode to leave, and Cancel is in the footer.
            create ? undefined : (
            <Toolbar design="Transparent">
              {profile && !editing && !portal ? (
                <ToolbarButton design="Emphasized" icon="edit" text="Edit"
                  // No ETag means B1 gave us nothing to guard the write with; refuse rather than
                  // send a blind PATCH.
                  disabled={!etag} onClick={() => setDraft({})} />
              ) : null}
              <PrintActions entity={entity} docEntry={Number(row.DocEntry)} scope={scope} disabled={editing} />
              {(meta.data?.flows ?? []).map((f) => (
                <ToolbarButton key={f.target} icon="copy" text={f.label} disabled={copy.isPending || editing}
                  onClick={() => copy.mutate({ sourceEntity: entity, targetEntity: f.target, docEntry: Number(row.DocEntry) })} />
              ))}
              <ToolbarButton icon="nav-back" text="Back to list"
                onClick={() => (portal
                  ? navigate({ to: "/portal/docs/$entity", params: { entity } })
                  : navigate({ to: "/b1/$entity", params: { entity } }))} />
            </Toolbar>
            )
          }>
          {statusDesign ? (
            <Tag design={statusDesign} style={{ alignSelf: "center" }}>
              {(status!.options?.find((o) => o.value === row.DocumentStatus)?.label ?? String(row.DocumentStatus))
                .replace(/^bost_/, "")}
            </Tag>
          ) : null}
          <Tag design="Set2" style={{ alignSelf: "center" }}>{schema.data!.table}</Tag>
        </ObjectPageTitle>
      }
      footerArea={
        create ? (
          <Bar design="FloatingFooter" endContent={
            <>
              <Button design="Emphasized" disabled={create.saving}
                onClick={() => create.onSave(draft ?? {})}>
                {create.saving ? "Creating in SAP…" : "Create in SAP"}
              </Button>
              <Button disabled={create.saving} onClick={create.onCancel}>Cancel</Button>
            </>
          } />
        ) : editing ? (
          <Bar design="FloatingFooter" endContent={
            <>
              <Button design="Emphasized" disabled={update.isPending || !Object.keys(draft!).length}
                onClick={() => update.mutate({ entity, key, etag: etag!, data: draft! as Record<string, unknown> })}>
                {update.isPending ? "Saving…" : "Save to SAP"}
              </Button>
              <Button onClick={() => { update.reset(); setDraft(null); }}>Cancel</Button>
            </>
          } />
        ) : undefined
      }>
      {[
      <ObjectPageSection key="general" id="general" titleText={schema.data!.label}>
        <ObjectPageSubSection id="fields" titleText="Fields">
          <>
            {create?.error ? <MessageStrip design="Negative" hideCloseButton>{create.error}</MessageStrip> : null}
            {create?.notice ?? null}
            {update.error ? <MessageStrip design="Negative" hideCloseButton>{update.error.message}</MessageStrip> : null}
            {copy.error ? <MessageStrip design="Negative" hideCloseButton>{copy.error.message}</MessageStrip> : null}
            {!profile && !editing && !portal ? (
              <MessageStrip design="Information" hideCloseButton>
                {`${schema.data!.label} is read-only in Confire.`}
              </MessageStrip>
            ) : null}
            <Form layout="S1 M2 L3 XL3" labelSpan="S12 M4 L4 XL4"
              accessibleMode={editing ? "Edit" : "Display"} itemSpacing={editing ? "Normal" : "Large"}>
              <FormGroup>
                {scalars.map((f) => (
                  <FormItem key={f.name} labelContent={<Label>{f.label ?? f.name}</Label>}>
                    <EntityField
                      field={f} value={value(f.name)} entityLabel={schema.data!.label}
                      {...(editing && editable.has(f.name)
                        ? { onChange: (v: Val | undefined) => setDraft((d) => ({ ...d, [f.name]: v })) }
                        : {})}
                    />
                  </FormItem>
                ))}
              </FormGroup>
            </Form>
          </>
        </ObjectPageSubSection>
      </ObjectPageSection>,
      ...collections.map((f) => (
        <ObjectPageSection key={f.name} id={f.name} titleText={f.label ?? f.name}>
          <ObjectPageSubSection id={`${f.name}-rows`} titleText={f.label ?? f.name}>
            <EntityField field={f} value={row[f.name]} />
          </ObjectPageSubSection>
        </ObjectPageSection>
      )),
      ]}
    </ObjectPage>
  );
}

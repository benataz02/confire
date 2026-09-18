import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bar, Button, Form, FormGroup, FormItem, Label, Menu, MenuItem, MessageStrip, ObjectPage,
  ObjectPageSection, ObjectPageTitle, SplitButton, Tag, Title, Toolbar,
  ToolbarButton, ToolbarItem,
} from "@ui5/webcomponents-react";
import { coerceKey, parseKeyParam, type B1Field } from "@confire/b1";
import type { Val } from "@confire/config-engine";
import { applyObjectDef, formatCell } from "../../listSpec.ts";
import { orpc } from "../../orpc.ts";
import { useObjectVariant } from "../../variants.ts";
import { toast } from "../toast.ts";
import { EntityField } from "./EntityField.tsx";
import { PrintActions } from "./PrintActions.tsx";

// One B1 row as a Fiori ObjectPage: scalar fields in the header section, each complex collection
// as its own section.
//
// WHICH fields and WHICH collections is a saved object view (ui_variant, page="object"), resolved by
// applyObjectDef — $metadata on its own is ~90 header fields and a 200-column lines table. A view
// with nothing in it means "show everything", which is also what a tenant whose seed never ran
// gets. The portal is excluded: portalSchema already narrows it server-side, and its one view is
// read-only.
//
// A section holds its content DIRECTLY, never wrapped in an ObjectPageSubSection: UI5's own rule is
// "only use subsections if more than one is available", and Fiori's is that a section holding a
// single table drops the redundant inner title. Wrapping drew two identical headings per collection
// and a subsection dropdown on every anchor.
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
// and the anchor bar then draws a single blank tab instead of one per section. (The fragment in the
// return wraps the ObjectPage itself, not its children: the view Menu has to be a sibling of the
// page, because anything inside it would be read as a section.)

/** Menu.opener takes an id, so the SplitButton needs one. Only ever one object page at a time. */
const VIEW_MENU_OPENER = "confire-objview";

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

/** Generic ObjectPage placeholder. Bars copy AnalyticalTable's TablePlaceholder (not a public export). */
function ObjectPageSkeleton() {
  return (
    <div className="confire-op-skel" role="progressbar" aria-valuetext="Busy" title="Please wait">
      <div aria-hidden="true">
        <div className="confire-op-skel-header">
          <div className="confire-op-skel-heading">
            <span className="confire-op-skel-bar confire-op-skel-bar--title" />
            <span className="confire-op-skel-bar confire-op-skel-bar--sub" />
          </div>
          <div className="confire-op-skel-actions">
            <span className="confire-op-skel-bar confire-op-skel-bar--chip" />
            <span className="confire-op-skel-bar confire-op-skel-bar--chip" />
          </div>
        </div>
        <div className="confire-op-skel-tabs">
          <span className="confire-op-skel-bar confire-op-skel-bar--tab" />
          <span className="confire-op-skel-bar confire-op-skel-bar--tab" />
          <span className="confire-op-skel-bar confire-op-skel-bar--tab" />
        </div>
        <div className="confire-op-skel-section">
          <span className="confire-op-skel-bar confire-op-skel-bar--section" />
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="confire-op-skel-field">
              <span className="confire-op-skel-bar confire-op-skel-bar--label" />
              <span className="confire-op-skel-bar confire-op-skel-bar--value" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
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
  const [viewMenu, setViewMenu] = useState(false);
  // `b1:` namespaced, the same key the list route saves its views under.
  const view = useObjectVariant(`b1:${entity}`, !portal);

  const update = useMutation(orpc.entities.update.mutationOptions({
    onSuccess: () => { setDraft(null); toast("Saved to SAP"); void one.refetch(); },
  }));
  const copy = useMutation(orpc.entities.copy.mutationOptions({
    onSuccess: (r) => {
      toast(`${r.entity} ${r.docNum ?? r.docEntry} created`);
      navigate({ to: "/b1/$entity/$key", params: { entity: r.entity, key: String(r.docEntry) } });
    },
  }));

  const profile = meta.data?.profile ?? null;
  // A create page has nothing to display — it opens in edit mode and stays there.
  const editing = create ? true : draft !== null;
  // Whatever the view says, a form that can write a field has to show it: a hand-edited view that
  // dropped CardCode would leave create mode unable to send what the server requires.
  const always = useMemo(
    () => (editing && profile ? [...profile.editable, ...profile.requiredOnCreate] : []),
    [editing, profile],
  );
  const { scalars, sections } = useMemo(
    () => applyObjectDef(schema.data?.fields ?? [], portal ? null : view.def, always),
    [schema.data, portal, view.def, always],
  );
  // Off the raw schema, not the projection: DocumentStatus drives the title Tag whether or not the
  // applied view happens to list it.
  const status = useMemo(
    () => (schema.data?.fields ?? []).find((f) => f.name === "DocumentStatus"),
    [schema.data],
  );

  if (schema.isPending || (!create && schema.data && one.isPending)) {
    return <ObjectPage placeholder={<ObjectPageSkeleton />} />;
  }
  const loadError = schema.error ?? (create ? null : one.error);
  if (loadError) return <MessageStrip design="Negative" hideCloseButton>{loadError.message}</MessageStrip>;

  const row = create?.row ?? one.data!.row;
  const etag = create ? undefined : one.data!.etag;
  const keys = schema.data!.keys;
  // Create edits the same fields an update does. `requiredOnCreate` is deliberately not folded in:
  // its entries are either already in `editable` or, like DocumentLines, the caller's to build.
  const editable = new Set(profile?.editable ?? []);
  const value = (name: string) => (draft && name in draft ? draft[name] : row[name]);
  const statusDesign = status ? STATUS_DESIGN[String(row.DocumentStatus)] : undefined;

  return (
    <>
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
              {/* The view switch, not an action — Fiori keeps split and menu buttons transparent and
                  reserves Emphasized for the page's one primary action (Edit). A Toolbar child has
                  to be a ToolbarButton/Select or be wrapped in ToolbarItem, or it never overflows.
                  SplitButton carries no menu of its own: it only fires click / arrow-click, so the
                  Menu is opened by id, the same wiring as the model builder's row menus. */}
              {!portal && view.variants.length ? (
                <ToolbarItem key="view">
                  <SplitButton id={VIEW_MENU_OPENER} design="Transparent" icon="multiselect-all"
                    accessibleName="Select view" disabled={editing}
                    accessibilityAttributes={{
                      root: { title: "Select view" },
                      arrowButton: { hasPopup: "menu", expanded: viewMenu },
                    }}
                    onClick={() => setViewMenu(true)} onArrowClick={() => setViewMenu(true)}>
                    {view.selected}
                  </SplitButton>
                </ToolbarItem>
              ) : null}
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
      </ObjectPageSection>,
      ...sections.map((f) => (
        <ObjectPageSection key={f.name} id={f.name} titleText={f.label ?? f.name}>
          <EntityField field={f} value={row[f.name]} />
        </ObjectPageSection>
      )),
      ]}
    </ObjectPage>
    {viewMenu ? (
      <Menu open opener={VIEW_MENU_OPENER} onClose={() => setViewMenu(false)}
        onItemClick={(e) => {
          view.apply(String((e.detail.item as HTMLElement).dataset.view));
          setViewMenu(false);
        }}>
        {view.variants.map((v) => (
          <MenuItem key={v.id} text={v.name} data-view={v.name}
            icon={v.name === view.selected ? "accept" : undefined}
            additionalText={v.shared ? "Shared" : undefined} />
        ))}
      </Menu>
    ) : null}
    </>
  );
}

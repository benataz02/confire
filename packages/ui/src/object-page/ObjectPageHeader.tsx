import type { ReactElement, ReactNode } from "react";
import {
  FlexBox, Label, ObjectPageHeader, ObjectPageTitle, ObjectStatus, Text, Title, Toolbar, ToolbarButton, ToolbarItem,
  type ObjectPageHeaderPropTypes, type ObjectPageTitlePropTypes,
} from "@ui5/webcomponents-react";
import { formatValue } from "../format.ts";
import { isIntegerType, type FieldConstraint } from "../metadata.ts";
import type { Facet, HeaderActionContext, HeaderConfig, Row } from "../types.ts";

// app-object-page-header (LIST-REPORT-OBJECT-PAGE.md §4.3), from the declared header config and
// the record. Functions returning the UI5 elements, not components: ObjectPage clones its
// titleArea/headerArea and expects to find ObjectPageTitle/ObjectPageHeader there.

export type RecordNavigation = { first: () => void; prev: () => void; next: () => void; last: () => void; busy?: boolean };

const formatField = (formData: Row, fields: Record<string, FieldConstraint> | undefined, key: string) => {
  const m = fields?.[key];
  return formatValue(formData[key], m?.Type, m?.Options, isIntegerType(m?.EdmType));
};

/** Title: the create title, or the record's title field. Subtitle: the subtitle fields, formatted
 *  by their metadata type. */
export function objectPageTitle(o: {
  header: HeaderConfig;
  formData: Row;
  ctx: HeaderActionContext;
  label: string;
  /** Edit, shown in display mode when the page may edit */
  onEdit?: () => void;
  editDisabled?: boolean;
  navigation?: RecordNavigation;
  /** the layout view selector + Adapt layout */
  layout?: ReactNode;
}): ReactElement<ObjectPageTitlePropTypes> {
  const { header, formData, ctx } = o;
  const fields = ctx.constraints?.fields;
  const title = ctx.isNew
    ? header.createTitle ?? `New ${o.label}`
    : formatField(formData, fields, header.titleField);
  const subtitle = ctx.isNew ? "" : (header.subtitleFields ?? [])
    .map((k) => formatField(formData, fields, k))
    .filter(Boolean)
    .join(" · ");
  const actions = header.actions?.(ctx);
  return (
    <ObjectPageTitle
      breadcrumbs={o.layout}
      header={<Title>{title || o.label}</Title>}
      subHeader={subtitle ? <Text>{subtitle}</Text> : undefined}
      navigationBar={o.navigation && !ctx.isNew ? (
        <Toolbar design="Transparent">
          {/* Same overflowGroup: the four moves stay together. A bar that cannot fit all of them
              puts every one in the overflow menu, rather than leaving First visible and Last hidden. */}
          <ToolbarButton overflowGroup="record" design="Transparent" icon="media-rewind" tooltip="First" accessibleName="First"
            disabled={o.navigation.busy} onClick={o.navigation.first} />
          <ToolbarButton overflowGroup="record" design="Transparent" icon="navigation-left-arrow" tooltip="Previous" accessibleName="Previous"
            disabled={o.navigation.busy} onClick={o.navigation.prev} />
          <ToolbarButton overflowGroup="record" design="Transparent" icon="navigation-right-arrow" tooltip="Next" accessibleName="Next"
            disabled={o.navigation.busy} onClick={o.navigation.next} />
          <ToolbarButton overflowGroup="record" design="Transparent" icon="media-forward" tooltip="Last" accessibleName="Last"
            disabled={o.navigation.busy} onClick={o.navigation.last} />
        </Toolbar>
      ) : undefined}
      actionsBar={
        <Toolbar design="Transparent">
          {o.onEdit && !ctx.isEditMode ? (
            <ToolbarButton design="Emphasized" icon="edit" text="Edit" disabled={o.editDisabled} onClick={o.onEdit} />
          ) : null}
          {/* A Toolbar child has to be a ToolbarButton/Select or be wrapped, or it never overflows. */}
          {actions ? <ToolbarItem>{actions}</ToolbarItem> : null}
        </Toolbar>
      }
    />
  );
}

function FacetValue({ facet, formData, meta }: { facet: Facet; formData: Row; meta: FieldConstraint | undefined }) {
  const v = formData[facet.field];
  if (facet.type === "status") {
    const m = facet.statusMapping?.[String(v)];
    return <ObjectStatus state={m?.state ?? "None"}>{m?.text ?? formatValue(v, meta?.Type, meta?.Options, isIntegerType(meta?.EdmType))}</ObjectStatus>;
  }
  if (facet.type === "date") return <Text>{formatValue(v, "date")}</Text>;
  const unit = facet.unitField ? formData[facet.unitField] : undefined;
  return <Title level="H4">{`${formatValue(v, "number")}${unit ? ` ${String(unit)}` : ""}`}</Title>;
}

/** The KPI strip: one block per facet with a value on the record. */
export function objectPageHeaderArea(
  facets: Facet[] | undefined, formData: Row, fields: Record<string, FieldConstraint> | undefined,
): ReactElement<ObjectPageHeaderPropTypes> | undefined {
  const shown = (facets ?? []).filter((f) => formData[f.field] !== undefined && formData[f.field] !== null && formData[f.field] !== "");
  if (!shown.length) return undefined;
  return (
    <ObjectPageHeader>
      <FlexBox wrap="Wrap" style={{ gap: "2rem" }}>
        {shown.map((f) => (
          <FlexBox key={f.field} direction="Column" style={{ gap: "0.25rem" }}>
            <Label>{f.label ?? fields?.[f.field]?.Label ?? f.field}</Label>
            <FacetValue facet={f} formData={formData} meta={fields?.[f.field]} />
          </FlexBox>
        ))}
      </FlexBox>
    </ObjectPageHeader>
  );
}

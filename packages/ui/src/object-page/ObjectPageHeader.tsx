import type { ReactElement, ReactNode } from "react";
import {
  FlexBox, Label, ObjectPageHeader, ObjectPageTitle, ObjectStatus, Text, Title, Toolbar, ToolbarButton, ToolbarItem,
  type ObjectPageHeaderPropTypes, type ObjectPageTitlePropTypes,
} from "@ui5/webcomponents-react";
import { formatValue } from "../format.ts";
import { useUiI18n } from "../i18n.ts";
import { documentStatusText } from "../documentStatus.ts";
import { isIntegerType, type FieldConstraint } from "../metadata.ts";
import { PageBreadcrumbs, type Crumb } from "../PageBreadcrumbs.tsx";
import type { Facet, HeaderActionContext, HeaderConfig, Row } from "../types.ts";

// app-object-page-header (LIST-REPORT-OBJECT-PAGE.md §4.3), from the declared header config and
// the record. Functions returning the UI5 elements, not components: ObjectPage clones its
// titleArea/headerArea and expects to find ObjectPageTitle/ObjectPageHeader there.

export type RecordNavigation = {
  first: () => void; prev: () => void; next: () => void; last: () => void; busy?: boolean;
  /** known to be on the first/last record: First+Previous / Next+Last are off */
  atFirst?: boolean; atLast?: boolean;
};

const formatField = (formData: Row, fields: Record<string, FieldConstraint> | undefined, key: string) => {
  const m = fields?.[key];
  return formatValue(formData[key], m?.Type, m?.Options, isIntegerType(m?.EdmType));
};

/** The create title, or the record's title field — and while that is empty, the create title or the
 *  entity's label. */
export function recordTitle(header: HeaderConfig, ctx: HeaderActionContext, label: string, t: (key: string, ...params: Array<string | number>) => string): string {
  if (ctx.isNew) return header.createTitle ?? t("UI_NEW", label);
  return formatField(ctx.formData, ctx.constraints?.fields, header.titleField) || header.createTitle || label;
}

/** Title: {@link recordTitle}. Subtitle: the subtitle fields, formatted by their metadata type. */
export function objectPageTitle(o: {
  header: HeaderConfig;
  formData: Row;
  ctx: HeaderActionContext;
  label: string;
  /** Edit, shown in display mode when the page may edit */
  onEdit?: () => void;
  editDisabled?: boolean;
  navigation?: RecordNavigation;
  /** the trail above the title */
  breadcrumbs?: Crumb[];
  /** the messages button: a Toolbar child, first in the actions */
  messages?: ReactNode;
  /** the layout view menu + Adapt layout: Toolbar children, after the page's actions */
  layout?: ReactNode;
  t: (key: string, ...params: Array<string | number>) => string;
}): ReactElement<ObjectPageTitlePropTypes> {
  const { header, formData, ctx } = o;
  const fields = ctx.constraints?.fields;
  const title = recordTitle(header, ctx, o.label, o.t);
  const subtitle = ctx.isNew ? "" : (header.subtitleFields ?? [])
    .map((k) => formatField(formData, fields, k))
    .filter(Boolean)
    .join(" · ");
  const actions = header.actions?.(ctx);
  const navActions = header.navigationActions?.(ctx);
  const recordNav = o.navigation && !ctx.isNew ? o.navigation : undefined;
  // The trail names the record by what users quote: a document's DocNum (its key, DocEntry, is
  // internal), else the key itself (CardCode, ItemCode). A new record by the create title.
  const code = ctx.isNew ? null : formData.DocNum ?? formData[ctx.constraints?.keys[0] ?? ""];
  const crumb = code == null || code === "" ? title : String(code);
  return (
    <ObjectPageTitle
      breadcrumbs={o.breadcrumbs ? <PageBreadcrumbs items={o.breadcrumbs} current={crumb} /> : undefined}
      header={<Title>{title}</Title>}
      subHeader={subtitle ? <Text>{subtitle}</Text> : undefined}
      navigationBar={recordNav || navActions ? (
        <Toolbar design="Transparent">
          {navActions ? <ToolbarItem>{navActions}</ToolbarItem> : null}
          {/* Same overflowGroup: the four moves stay together. A bar that cannot fit all of them
              puts every one in the overflow menu, rather than leaving First visible and Last hidden. */}
          {recordNav ? (
            <>
              <ToolbarButton overflowGroup="record" design="Transparent" icon="media-rewind" tooltip={o.t("UI_FIRST")} accessibleName={o.t("UI_FIRST")}
                disabled={recordNav.busy || recordNav.atFirst} onClick={recordNav.first} />
              <ToolbarButton overflowGroup="record" design="Transparent" icon="navigation-left-arrow" tooltip={o.t("UI_PREVIOUS")} accessibleName={o.t("UI_PREVIOUS")}
                disabled={recordNav.busy || recordNav.atFirst} onClick={recordNav.prev} />
              <ToolbarButton overflowGroup="record" design="Transparent" icon="navigation-right-arrow" tooltip={o.t("UI_NEXT")} accessibleName={o.t("UI_NEXT")}
                disabled={recordNav.busy || recordNav.atLast} onClick={recordNav.next} />
              <ToolbarButton overflowGroup="record" design="Transparent" icon="media-forward" tooltip={o.t("UI_LAST")} accessibleName={o.t("UI_LAST")}
                disabled={recordNav.busy || recordNav.atLast} onClick={recordNav.last} />
            </>
          ) : null}
        </Toolbar>
      ) : undefined}
      actionsBar={
        <Toolbar design="Transparent">
          {o.messages}
          {o.onEdit && !ctx.isEditMode ? (
            <ToolbarButton design="Emphasized" icon="edit" text={o.t("UI_EDIT")} disabled={o.editDisabled} onClick={o.onEdit} />
          ) : null}
          {/* A Toolbar child has to be a ToolbarButton/Select or be wrapped, or it never overflows. */}
          {actions ? <ToolbarItem>{actions}</ToolbarItem> : null}
          {o.layout}
        </Toolbar>
      }
    />
  );
}

function FacetValue({ facet, formData, meta }: { facet: Facet; formData: Row; meta: FieldConstraint | undefined }) {
  const i18n = useUiI18n();
  const v = formData[facet.field];
  if (facet.type === "status") {
    const code = String(v ?? "");
    const m = facet.statusMapping?.[code];
    const text = documentStatusText(code, m?.text ?? formatValue(v, meta?.Type, meta?.Options, isIntegerType(meta?.EdmType)), i18n.getText.bind(i18n));
    return <ObjectStatus state={m?.state ?? "None"}>{text}</ObjectStatus>;
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

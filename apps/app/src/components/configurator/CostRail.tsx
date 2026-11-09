import { createPortal } from "react-dom";
import {
  Card, CardHeader, IllustratedMessage, List, ListItemGroup, ListItemStandard,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { ITEM_COL, type CostBreakdown, type CostLine, type Val } from "@confire/config-engine";
import { money } from "@confire/ui/money.ts";
import { useI18n } from "../../i18n.ts";
import { percent } from "./runView.ts";

// The cost rail beside every section of the process page, sticky under the title and anchor bar.
// ObjectPage has no slot for side content (each child becomes an anchor), so the rail is portaled
// into its content area and global.css reserves a quarter of that area for it; the content's offset
// is where the sticky bars end. Every figure is the view's (config-engine costBreakdown). While an
// edit is out they are the last answer's: dimmed, not hidden.
// ponytail: no fall-down below the sections on a narrow screen; the title's toggle hides the rail.

/** `page` is the ObjectPage's root; `rows` the items grid's evaluated rows, for the item codes. */
export function CostRail({ page, cost: c, rows, cur, busy, footerUp }: {
  page: HTMLElement | null;
  cost: CostBreakdown | undefined;
  rows: Record<string, Val>[];
  cur?: string;
  busy: boolean;
  footerUp: boolean;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const content = page?.querySelector<HTMLElement>('[data-component-name="ObjectPageContent"]');
  if (!page || !content) return null;

  const line = (l: CostLine, key: string | number = l.label) =>
    <ListItemStandard key={key} type="Inactive" text={l.label} additionalText={money(l.amount, cur)} />;
  const group = (ls: CostLine[], title: string) =>
    ls.length ? <ListItemGroup headerText={title}>{ls.map((l) => line(l))}</ListItemGroup> : null;
  // The item code when the row has one, the row number when it does not.
  const byItem = c?.items.flatMap((r, i) => r
    ? [{ label: String(rows[i]?.[ITEM_COL] ?? "").trim() || t("CONFIG_ITEM", String(i + 1)), amount: r.lineCost }]
    : []) ?? [];

  return createPortal(
    <aside className="confire-rail" aria-label={t("CONFIG_COST_ELEMENTS")}>
      <div style={{ top: content.offsetTop, maxHeight: `calc(${page.clientHeight - content.offsetTop}px - ${footerUp ? "4.5rem" : "1rem"})` }}>
        {/* Read like a checkout: what the cost is made of, then the totals under a rule. */}
        <Card accessibleName={t("CONFIG_COST_ELEMENTS")} style={busy ? { opacity: 0.6 } : undefined}
          header={<CardHeader titleText={t("CONFIG_COST_ELEMENTS")} subtitleText={c ? t("CONFIG_COST_SUB", String(c.batchQty)) : undefined} />}>
          {c ? (
            <>
              <List separators="Inner">
                {group(c.materials, t("CONFIG_MATERIALS"))}
                {group(c.operations, t("CONFIG_OPERATIONS"))}
                {group(c.other, t("CONFIG_OTHER_COSTS"))}
              </List>
              <List separators="None" style={{ borderBlockStart: "1px solid var(--sapList_GroupHeaderBorderColor)" }}>
                <ListItemStandard type="Inactive" className="confire-total" text={t("CONFIG_TOTAL_COST")} additionalText={money(c.cost, cur)} />
                {line({ label: t("CONFIG_UNIT_COST"), amount: c.unitCost })}
                {/* A typed grid price wins here as it does on the quotation: the same money unit. */}
                {line({ label: t("CONFIG_PRICE"), amount: c.price })}
                {/* Negative only below zero: any other threshold would be a policy this app does not have. */}
                <ListItemStandard type="Inactive" text={t("CONFIG_MARGIN")} additionalText={percent(c.margin)}
                  additionalTextState={c.margin !== null && c.margin < 0 ? "Negative" : "None"} />
              </List>
              {/* The same total on the other axis, in line totals (the grid shows it per unit). One
                  item would only repeat the total, so it earns its space from two rows up. */}
              {byItem.length > 1 ? (
                <List separators="Inner">
                  <ListItemGroup headerText={t("CONFIG_COST_BY_ITEM")}>{byItem.map((l, i) => line(l, i))}</ListItemGroup>
                </List>
              ) : null}
            </>
          ) : (
            <IllustratedMessage name="NoData" design="ExtraSmall" titleText={t("CONFIG_NO_COSTS")}
              subtitleText={t("CONFIG_NO_COSTS_SUB")} />
          )}
        </Card>
      </div>
    </aside>,
    content,
  );
}

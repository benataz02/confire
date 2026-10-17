// One money formatter for the whole app. There used to be two with the same name and different
// output — configurator/costElements.ts (locale default, 2 decimals, EUR default, guarded) and
// dashboard/dashboardView.ts (hardcoded en-GB, 0 decimals, unguarded) — so the same figure read
// differently depending on which page you were on.
//
// No default currency. The old `= "EUR"` invented a unit for tenants whose books are in something
// else; undefined now means "SAP has not said yet" and renders a bare number, which is honest.
// The currency itself comes from the UiSource's useCurrency() — this module stays free of the query
// client so it can be unit-tested without a DOM.

/**
 * Always two decimals, everywhere, including the dashboard's charts. Both bounds are set, not just
 * the maximum: Intl's currency style otherwise takes the *currency's* own digit count, so the same
 * figure would render with 0 decimals under JPY and 3 under KWD. Pinning both is what makes a
 * column of money line up.
 */
export function money(n: number, currency?: string): string {
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(undefined, currency ? { style: "currency", currency, ...digits } : digits).format(n);
  } catch {
    // The code is whatever B1 has in OADM, not something this app validated. Intl throws on
    // anything that is not a well-formed ISO 4217 code — never let that take the page down.
    return `${n.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

// --- the items grid's money (derived by apps/web's itemMoney.ts, drawn by ConfigTable) ---------

export type RowMoney = {
  unitCost: number;
  unitPrice: number;
  /** pieces this row ships across every selected batch — unitCost x quantity is the line cost */
  quantity: number;
};
/** One element of what the cost is made of: a BOM line under its description, an operation under
 *  its resource. Batch totals, so these add up to the same money `rows` splits over the grid. */
export type CostLine = { kind: "material" | "operation"; label: string; amount: number };
export type ItemMoney = {
  /** the batch quantity the figures are priced at — the one picked in the items section's header */
  batchQty: number;
  /** indexed by position in the unfiltered grid; a row that ships nothing has no share */
  rows: (RowMoney | undefined)[];
  /** where the cost comes from, as opposed to where `rows` lands it — same total, other axis */
  lines: CostLine[];
};

/** Setup cost is spread across the run, so a unit figure means nothing without the quantity it was
 *  priced at. Empty before there is any money to label. */
export const qtyLabel = (batchQty: number | undefined) =>
  batchQty ? ` (Quantity ${batchQty})` : "";


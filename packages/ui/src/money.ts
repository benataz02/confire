import { formatLocale } from "./format.ts";

// One money formatter for the whole app. There used to be two with the same name and different
// output — one locale-default with 2 decimals, one hardcoded en-GB with 0 — so the same figure
// read differently depending on which page you were on.
//
// No default currency. The old `= "EUR"` invented a unit for tenants whose books are in something
// else; undefined now means "SAP has not said yet" and renders a bare number, which is honest.
// The currency itself comes from the UiSource's useCurrency() — this module stays free of the query
// client so it can be unit-tested without a DOM.

/**
 * Always two decimals, everywhere. Both bounds are set, not just
 * the maximum: Intl's currency style otherwise takes the *currency's* own digit count, so the same
 * figure would render with 0 decimals under JPY and 3 under KWD. Pinning both is what makes a
 * column of money line up.
 */
export function money(n: number, currency?: string): string {
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  try {
    return new Intl.NumberFormat(formatLocale(), currency ? { style: "currency", currency, ...digits } : digits).format(n);
  } catch {
    // The code is whatever B1 has in OADM, not something this app validated. Intl throws on
    // anything that is not a well-formed ISO 4217 code — never let that take the page down.
    return `${n.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

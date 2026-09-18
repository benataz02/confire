import { useQuery } from "@tanstack/react-query";
import { meQuery } from "../orpc.ts";

// One money formatter for the whole app. There used to be two with the same name and different
// output — configurator/costElements.ts (locale default, 2 decimals, guarded) and
// dashboard/dashboardView.ts (hardcoded en-GB, 0 decimals, unguarded) — so the same figure read
// differently depending on which page you were on.

/**
 * The tenant's B1 local currency. It comes off `me`, which _authed.beforeLoad already primes and
 * orpc.ts already caches with staleTime: Infinity — B1 gives no way to change a company's local
 * currency, so even one read per browser session is generous.
 *
 * undefined = SAP has never been reachable for this tenant. Money then renders as a plain number,
 * which is honest; the old `= "EUR"` default was not.
 */
export function useCurrency(): string | undefined {
  return useQuery(meQuery).data?.currency ?? undefined;
}

/**
 * `maxFrac` is for the dashboard's charts, which read in whole units. Everything else takes the
 * currency's own default (2 for most, 0 for JPY — which is why this is not `toFixed(2)`).
 */
export function money(n: number, currency?: string, maxFrac?: number): string {
  try {
    return new Intl.NumberFormat(
      undefined,
      currency
        ? { style: "currency", currency, maximumFractionDigits: maxFrac }
        : { maximumFractionDigits: maxFrac ?? 2 },
    ).format(n);
  } catch {
    // The code is whatever B1 has in OADM/ODOC, not something this app validated. Intl throws on
    // anything that is not a well-formed ISO 4217 code — never let that take the page down.
    return `${n.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

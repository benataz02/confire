import type { Facet } from "./types.ts";

/** B1's BoStatus member names (what the Service Layer sends) -> a status colour. Both apps' document
 *  pages read it. */
export const DOCUMENT_STATUS: Facet["statusMapping"] = {
  bost_Open: { state: "Information", text: "Open" },
  bost_Close: { state: "None", text: "Closed" },
  bost_Paid: { state: "Positive", text: "Paid" },
  bost_Delivered: { state: "Positive", text: "Delivered" },
};

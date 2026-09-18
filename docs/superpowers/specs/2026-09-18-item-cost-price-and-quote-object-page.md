# Item cost and price in the grid; the quotation as an object page

Date: 2026-09-18

## Purpose

Two gaps closed in one pass:

1. The items grid already declared how a joint total is divided — `ItemsTable.basisExpr` →
   `splitWeights()` → `splitShares()` — but only the *price* was ever split, on the server, at quote
   time. Cost was summed and never attributed, so nobody could read margin per line.
2. The salesperson could not set a line price. `RESERVED_LINE_FIELDS` blocks mapping a column to
   `UnitPrice` because the split owned it.

And `StepCreateQuote` — a read-only preview table with two inputs, rendered as a third section of
the configurator's ObjectPage — is replaced by a route that opens the real Quotations document in
`EntityObjectPage`, the component that renders every other B1 document.

## Decisions

| | |
|---|---|
| Price semantics | The edited per-unit price is authoritative: it becomes `DocumentLine.UnitPrice` and drives `quotedValue`. The split only seeds the field. |
| Preview | Both columns derived, nothing stored until the salesperson types. Basis: the saved selection, else `candidates[0]` at `batches[0]`. The header names the batch. |
| Cost elements rail | Keeps the priced-parameter list; gains an Items block below it. |
| Access | `entities.schema` and `entities.profile` become `userProcedure`. Neither returns business data. `entities.one` and every write stay admin. |
| Quote page edits | The `Quotations` profile's `editable` header fields. `DocumentLines` stay display-only. |

## Two invariants worth stating once

### The seed is derived, never stored

A stored cell **is** a manual override in this engine (`tables.ts`, `evalTableRows`). Writing the
split price into each row on first calculation would:

- clear `candidates` in the same `UPDATE` that writes `tables` (`configs.calculate`), retriggering
  the calculation that produced the seed — a loop;
- mark every row permanently overridden, so a parameter change silently stops moving the price;
- mint a new SAP dedup key on page load, because `configDocumentCommandId` hashes `tables`.

So `COST_COL`/`PRICE_COL` are **not** `TableColumn`s. A model never declares them (checkModel rejects
a column that tries), they produce no `items_*` aggregate, and `evalTableRows` ignores a stored
`unitprice` — which is what stops a hand-typed price feeding back into `basisExpr`. `buildQuoteLines`
reads the override off `ItemLine.raw`, not off the evaluated row, for exactly that reason.

### `round2`, not `splitShares`, is now what reconciles the document

`splitShares` guarantees `Σ shares === round(total, 2)`, and that is what used to make B1's
`DocTotal` equal the stored `quotedValue`: the lines were the total, divided. A hand-typed price
breaks that derivation — the document total is no longer `unitPrice × batchQty`.

What holds it together instead is that `buildQuoteLines` now accumulates
`round2(unitPrice × quantity)` per line, which is precisely how B1 re-derives `LineTotal`. The
invariant survives; its source moved. `splitShares` still owns the *default* prices, and still
reconciles them to the cent.

## Shape

- `packages/config-engine/src/tables.ts` — `itemSplit()` owns eval → filter → weight → split and
  returns `{ index, raw, row, quantity, cost, price }` per shipping row. One function, two callers:
  `buildQuoteLines` on the server and `itemMoney.ts` in the browser, so the grid cannot show a price
  the quotation will not carry.
- `apps/web/src/components/configurator/itemMoney.ts` — per-unit cost and price per grid row.
  Optional everywhere it is threaded, which is how the builder preview and the client portal stay
  free of cost data: they simply do not pass it.
- `apps/server/src/config-quote.ts` — `QUOTE_HEADER` is read off `ENTITY_PROFILES.Quotations.editable`
  so the quote page's write allowlist and the entity page's cannot drift. Deliberately not the
  profile's `editableCollections` or its `U_` escape hatch: `DocumentLines` come from the item matrix
  and `U_CF_Key` is the dedup key.
- `apps/web/src/components/b1/EntityObjectPage.tsx` — one optional `create` prop. No `entities.one`
  query, no ETag (nothing exists yet to guard), editing forced on, footer becomes Create/Cancel.
- The write still goes through `configs.createQuote`, not `entities.create`: that is the only path
  with the `U_CF_Key` check-then-create, the `status → quoted` transition and the
  `quotedValue`/`quotedCost` write.

## Not in scope

- Editable `DocumentLines` on the quote page. Nothing in the repo edits a B1 collection, and line
  edits would leave the document disagreeing with the `config_project.tables` rows behind it.
- `StepCandidatesReview`'s grand total stays the engineered total; it is relabelled to say so.

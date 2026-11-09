# One SAP cache

**Date:** 2026-11-09 · **Status:** design, awaiting approval

## Why

Confire keeps copies of SAP data so a page does not wait on the agent and the Service Layer every
time. Over time each feature grew its own copy: two tables, four cache columns on three other tables,
and three per-process `Map`s. Each has its own idea of freshness — none, a TTL in a jsonb field, a
hard-coded 10 minutes, a parser epoch, a company tag on the value — and a company switch has to
remember every one of them by hand (`adoptCompany` in `b1.ts`). It reads as spaghetti, and every new
cache adds another strand.

This is a big-bang refactor with **no backwards compatibility**: one table holds everything Confire
keeps from SAP, one module reads and writes it, one map says how long each thing lasts, and a
company switch is one statement.

## Goals

- Every copy of SAP data lives in one table, `sap_cache`. No cache-specific table or column remains.
- `apps/server/src/sap-cache.ts` is the only code that touches that table.
- Each kind's lifetime is one entry in one map in that module.
- A company switch clears the cache in one statement, and a read never serves another company's entry.
- **New:** the model's price list is cached once the model is saved, read through a **stored SQL
  query**, and refreshed after 24 h. `pricing.itemTable` goes away.
- A cleanup of everything the change touches or leaves dead (see Cleanup).

## Non-goals

- What is cached and for how long stay as they are, except: the entity list, the Beas schemas and the
  print layouts now outlive a restart, and the price list is new.
- No job runner. As today, freshness is a TTL checked on read and refilled from there.
- The routing's `pricing.operationTable` (Beas `OperationsCatalog`) stays a masterdata query.
- `portal_company.card_name`/`language_code` stay where they are: they are the register of which BPs
  are on the portal, not a cache.
- In-process memos that do not hold SAP data stay: `udfsMade` (agent-pairing.ts), `cachedLookups`
  (config-project.ts), the spreadsheet parse cache, and the in-flight dedup maps.
- Opening a report still runs it live against SAP. Only the last result, the home tile's figure,
  moves into the cache.
- No data migration and no dual reads. Old data is dropped and refills on its own.

## Anti-goals

- A page that does not wait on SAP today must not start waiting. Above all, `resolveLookups` stays
  SAP-free: masterdata and price lists are refilled in the background and a calculation goes ahead
  with what is there.
- No cache framework: no classes, no plugin registry, no per-kind modules. One table, a handful of
  functions, one map.
- No change a user notices beyond two things: report tiles are blank after the deploy until each
  report is opened once, and the first page loads refill the cache.

## What moves where

| kind | key | rows | lifetime | today |
|---|---|---|---|---|
| `schema` | entity set name | one | until Refresh, or older than `PARSER_EPOCH` | `entity_meta` |
| `entity_list` | `""` | one | 24 h | memory, `entity-meta.ts` `daily` (`b1:`) |
| `beas_schemas` | `""` | one | 24 h | memory, same map (`beas:`) |
| `currency` | `""` | one | forever | `sap_connection.local_currency` |
| `open_counts` | `""` | one | 10 min | `sap_connection.open_counts` |
| `print_layout` | `<ReportCode>\|<CardCode>` | one | 2 h | memory, `print.ts` `layouts` |
| `masterdata` | `config_masterdata.id` | many | `query.syncMinutes` (absent = manual) | `config_masterdata_row` + `config_masterdata.synced_at/sync_error/row_count` |
| `price_list` | price list number | many | 24 h | **new**, replaces the `pricing.itemTable` masterdata |
| `report` | `assistant_report.id` | one | until the next run | `assistant_report.last_result/last_run_at` |

Every kind is per company, because each holds data from one company database.

## The table

```ts
// packages/db/src/schema/sap.ts, beside sap_connection
export const sapCache = pgTable("sap_cache", {
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").$type<CacheKind>().notNull(),
  key: text("key").notNull().default(""),
  seq: integer("seq").notNull().default(0),
  company: text("company"),
  data: jsonb("data").$type<unknown>(),
  error: text("error"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.key, t.seq] })]);
```

**`seq 0` is the entry** (my call). Each entry has exactly one seq-0 row, and its `company`,
`fetched_at` and `error` say whether the entry can be used:

- `fetched_at` is when SAP answered. It is null when no read has succeeded yet: a failed first
  masterdata sync still needs a row to carry its `error`.
- A failed refresh keeps the last good data and `fetched_at` and only sets `error`. A successful one
  clears `error`.
- A kind with one value keeps it in seq 0's `data`.
- A kind with many rows (`masterdata`, `price_list`) keeps them at seq 1…n, one SAP row each, in the
  read's order. That order is what replays a masterdata query's `orderby`, as `seq` does today. Its
  seq 0 holds `{ rows: n, hash, changedAt }`:
  - `rows` lets the masterdata list show a count without counting.
  - `hash` is a sha1 over the rows in order, computed while streaming.
  - `changedAt` moves only when a refill's `hash` differs from the last one (my call). `fetched_at`
    says when SAP was last asked, which drives the TTL. `changedAt` says when the data last changed,
    which drives stale calculations (see below). A daily price-list refill that finds the same prices
    therefore leaves every configuration's calculation, and the candidate its user picked, alone.
    Today a masterdata with `syncMinutes` throws the selection away on every sync. This fixes that as
    a side effect.
  The seq ≥ 1 rows leave `company`, `fetched_at` and `error` null, because only the entry's own row
  is read for those.
- A many-row entry is refilled the way the masterdata sync works today: delete and insert in one
  transaction, streaming page by page, so a reader sees either the old set or the new one. On a failed
  refill the transaction rolls back and the error goes on seq 0 afterwards.
- A refill takes `pg_advisory_xact_lock` on (tenant, kind, key) first. The staff and portal processes
  can refill the same entry at once, and the in-flight maps only dedup within a process, so without
  the lock two refills could hit the same primary key.

**The company rule.** An entry is written with the company the SAP call itself carried
(`Connector.companyDb`), never one read again. A read treats an entry whose `company` is distinct from
`sap_connection.company_db` as absent (`is not distinct from`, because dev may have no company yet).
`adoptCompany` deletes all of the tenant's `sap_cache` rows inside its existing transaction. The read
rule is still needed after that delete: a refill that started under the old company can land later.
Together they replace today's five separate steps and the per-value company tags on open counts and
report results.

## `sap-cache.ts`

This is the only module that imports `sapCache`. Exact names and signatures are the builder's
choice. It needs:

- **A lifetime map**, `kind → ms | "forever" | per-entry`. Masterdata reads its lifetime off the
  masterdata row's `query.syncMinutes`. `schema` is also stale when `fetched_at < PARSER_EPOCH`
  (that constant moves here from `entity-meta.ts`).
- **A read-through for one-value kinds**: a fresh entry is returned as it is. Otherwise SAP is read
  once per process and key (in-flight dedup, as `daily`, `openCounts` and `ensureFresh` do now), the
  result is written, and it is returned. A failed load is not written as data. It keeps doing what
  each caller does today:
  - `currency` never throws and answers null.
  - `open_counts` serves the last counts of the same company when SAP fails (not on `COMPANY_CHANGED`).
  - `print_layout` does not store a PLD layout it refused.
  - `refresh` forces a read where a caller offers that today: the schema Refresh button, and the
    entity list behind it.
- **Many-row fill**: delete and insert a whole entry from a page stream, as above.
- **Many-row read**: today's `selectRows` (`masterdata-sync.ts`), unchanged in behaviour, over the
  seq ≥ 1 rows: value filter, `where`, search, `ORDER BY seq`, top/skip. `rowCache`/`RowCache` keep
  their shape and move onto it.
- **Entry read**: seq 0 of one key or many keys, for freshness, `error` and the row count.
- **Forget**: by tenant (company switch), by tenant and kind (`ensureUdfs` created a UDF, so every
  `schema` goes), or by kind and key (a masterdata saved with a new query or deleted, a report deleted).

### Callers, per kind

- **schema** (`entity-meta.ts` `entitySchema`): same flow. A hit returns before `assertEntity`. On an
  old Service Layer one answer holds every schema, and all of them are written in chunks of 50.
- **entity_list, beas_schemas** (`entityList`, `beasSchemas`): the `daily` map and `forgetEntityList`
  go. `masterdata.ts`, `b1.ts`'s router and `reports/run.ts` call them as today.
- **currency** (`b1.ts` `tenantCurrency`): `agentStatus` also writes the entry when its
  `CompanyService_GetAdminInfo` read answers, as it writes the column today.
- **open_counts** (`open-counts.ts`): the SQL, its `$count` fallback and its stored-query creation
  stay. Only where the answer is kept changes.
- **print_layout** (`print.ts`): the key no longer holds the tenant or the company, because the table
  has both.
- **masterdata** (`masterdata-sync.ts`): `syncMasterdata`, `ensureFresh`, `syncNow` and `isStale`
  keep their behaviour over the entry. `MasterdataRow` loses `syncedAt`/`syncError`/`rowCount` as
  columns, and the reads that need them (`config-project.ts`, `config-view.ts`'s notices,
  `orpc/routers/masterdata.ts`, `home.ts`'s sync-errors tile) join or read the entry instead. The
  masterdata list sorts and filters on row count and last synced through `list-sql.ts`, so those two
  become SQL over the seq-0 row (a left join or a subquery), and the API field names
  (`rowCount`, `syncedAt`, `syncError`) stay so the app is untouched there. Saving a query masterdata
  with a changed query, or deleting one, forgets its entry, which is what clearing the columns does now.
- **report** (`reports/store.ts`): `storeRun`/`storeResult` write the entry, with `company` set to the
  result's own `company` and `fetched_at` to its `readAt`. `getReport`/`savedReports` answer
  `lastResult`/`lastRunAt` from it, so the app's types do not change. The tile's own company check in
  `reports.tiles` goes, because the read rule covers it. `deleteReport` forgets the entry.
- **Stale calculations** (`config-project.ts`): a stored calculation is stale once any of these is
  newer than `calculatedAt`:
  - the model
  - a masterdata definition (`updatedAt`)
  - a masterdata entry's `changedAt`
  - **the model's price-list entry's `changedAt`**

  `cachedLookups`' version string includes the same timestamps, per entry rather than a max, for the
  reason its comment gives today. `fetched_at` is never part of it.

## The price list

- A model's `pricing.priceList` is already required by `checkModel`. `pricing.itemTable` is removed:
  from `ModelDefZ`, from `checkModel`'s BOM rule, from `syncTables`, from the table-rename rewrite
  (`check.ts`), from the builder's field (`features/model/model.ts`, `record.ts` `PRICING`) and from
  its i18n keys. A model with a BOM needs a price list and nothing else. Stored models that still
  carry `itemTable` in their jsonb are harmless, because `z.object` strips unknown keys on parse, and
  the key drops out at the next save.
- **The read is a stored SQL query, one per price list**, created on first use the way
  `open-counts.ts` does it:
  `SELECT ItemCode, Price FROM ITM1 WHERE PriceList = <n> ORDER BY ItemCode`, code
  `CF_PL_<first 8 hex of sha1(text)>`. The `ORDER BY` keeps paging stable and the hash meaningful.
  Column names are matched case-insensitively, because HANA may upper-case them (`countsOf` already
  does this).
  `<n>` is an integer from a validated model. Assert it again where the text is built, because it is
  spliced into SQL. A missing query (404) is created and run again. As with open counts, superseded
  entries stay in SAP. The agent needs no change: `GET SQLQueries('…')/List` passes as any GET, and
  the create is a POST to one segment.
- **Paging:** `sqlQuery` sends no `Prefer` header today, so SAP answers 20 rows and an
  `@odata.nextLink`. It gains a page size, `Prefer: odata.maxpagesize`, and the fill walks
  `readNext` page by page into the entry.
- **When it is read** (my call on the first and third points):
  - `models.create`/`models.save` start a background fill when the model has a price list **and its
    entry is missing or stale**. Saving a model is not a reason to re-read thousands of prices through
    the agent's one SAP session. The fill never delays or fails the save, and an error lands on the
    entry.
  - A resolve that finds the entry missing or older than 24 h starts the same background fill
    (`ensureFresh`'s pattern and dedup) and calculates with what is there.
  - **The configuration's existing Refresh button** (`configs.sync`, which today refills every query
    table the model reads) also refills the model's price list, forced and reporting failure. That is
    how a price changed in SAP reaches a quote right away, as the Items masterdata's "Sync now" did.
    No new button.
  - One entry per (tenant, price list) serves every model that uses that list.
- **`cachedPrices`** (`lookups.ts`) reads the seq ≥ 1 rows whose `ItemCode` is in `bomItemCodes`.
  This replaces the `Items` masterdata lookup and its `ItemPrices` digging.
  - An item with no row stays `unpriced`, as today.
  - A price-list entry with an `error` or no `fetched_at` becomes a coded notice in `config-view.ts`,
    the way `sync_failed` works for masterdata, so the process page says why the BOM is unpriced.
  - `// ponytail:` no index on `data->>'ItemCode'`, so a lookup scans one list's rows. Add a partial
    expression index (`where kind = 'price_list'`) if it profiles slow.
- **No fallback** (my call, because you chose the stored SQL): a SAP that refuses the query (no
  SQL-query authorization, or `ITM1` missing from `b1s_sqltable.conf`) leaves the entry's `error`
  set and the notice on the page. Verify on the live tenant (`hera`) that `ITM1` is allowed. Until
  then the code is marked `unverified (spec §16)`, like the other live-SAP assumptions.

## Migration

One drizzle migration (`bun run db:generate`, committed):

- creates `sap_cache`
- drops `entity_meta` and `config_masterdata_row`
- drops `sap_connection.local_currency` and `open_counts`
- drops `config_masterdata.synced_at`, `sync_error` and `row_count`
- drops `assistant_report.last_result` and `last_run_at`

No data is copied. After deploy:

- the currency is read again at the next `me` or status poll
- schemas are read again on first use
- masterdata entries are missing, so they count as stale and refill on the next read (manual-only ones
  included, because missing is stale)
- price lists fill on the first save or calculation
- report tiles are empty until each report is opened

Tenants' Items masterdata rows, which only existed to supply prices, are left in place. They are the
tenant's own definitions, and an admin can delete them.

## Cleanup (my call: scoped to this change, not the whole repo)

- **Delete** what the change leaves dead:
  - the old tables and columns, plus their schema comments
  - the `daily` map, `forgetEntityList`, `print.ts`' `layouts`
  - the company tags inside `open_counts`'s value and the report tile's check
  - `itemTable` everywhere
  - the `ITEM_PRICES` digging in `lookups.ts`
  - `MasterdataRow`'s cache fields
- **Comments:** rewrite or remove every comment that names an old home (`sap_connection.localCurrency`,
  `entity_meta`, `config_masterdata_row`, `daily`, the Items masterdata for prices). That includes
  `packages/ui/src/metadata.ts`, `TablePage.tsx`, `model.ts`'s pricing notes and `model.test.ts`. Keep
  every verified B1 error string and every explanation of why.
- **Tests:**
  - Move the existing ones onto the new table (`masterdata-sync`, `entity-meta`, `company-switch`,
    `reports`, `configurator`, `config-process`, `b1-tools`, `assistant-*`, `portal-*`, and
    config-engine's `itemTable` cases).
  - Add one for `sap-cache.ts`'s freshness and company rule.
  - Add one for the price-list SQL text and its paging.
- **Docs:**
  - `CLAUDE.md`: the masterdata cache section, `ResolvedLookups.prices`, the open counts, print's 2 h
    cache, `entity_meta`/`adoptCompany`, the report tiles, `pricing.itemTable`.
  - `DEPLOY.md`'s table-size note.
  - Dated specs are history and stay as written.
- **Gates:**
  - every project's `tsc`
  - the server, config-engine and ui tests
  - `bun --cwd apps/app build` and `bun --cwd apps/portal build`

## Left to the builder

Function names and the module's exact surface. Whether the seq ≥ 1 rows carry `company`. How the
masterdata list's SQL reaches the seq-0 row. The wording of the price-list notice. The order of the
work.

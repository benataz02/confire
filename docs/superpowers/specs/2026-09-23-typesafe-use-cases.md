# TypeSafe (System One / Jev) — Use Cases Across Confire

**Date:** 2026-09-23
**Scope:** where System One judgments fit in Confire, and where they do not. Covers configuration
assistance, configuration similarity, document history search, and six other candidates found in
the codebase.
**Builds on:** `2026-09-21-typesafe-recall-exploration.md` (similarity P1–P3, documents D1–D3,
the `Judge` seam, budget, and evaluation). This document does not repeat those designs. It
corrects them where the code has moved (§1) and adds the use cases they did not cover.
**Status:** exploration. Nothing is implemented and no dependency was added.

> **Sourcing.** The egress proxy still blocks `docs.typesafe.ai`, so the live docs and cookbooks
> could not be read. The contract was re-checked against the published SDK,
> `@typesafe-ai/sdk@0.6.0` (`dist/index.d.mts`, from the npm registry). That is still the latest
> version. It confirms the shapes the 09-21 doc used:
> `choice(instructions, criteria)`, `noul(instructions?, criteria?)`, and
> `score(instructions, criteria[≥2])`. Choice returns `probabilities` over **every** label and Score
> returns a distribution over its levels. The defaults are a 10 s timeout per attempt and 2
> retries, with no total retry budget. Question wording and thresholds below are drafts to test,
> not tuned values.

---

## 0. The one-paragraph version

Jev can do three things for Confire that code cannot: **map free text onto the model's own
vocabulary** (A1, D2, D5), **choose among alternatives that code has already proved valid** (A2,
A3, D3), and **judge whether retrieved evidence is actually usable** (P2 and D2 from 09-21, plus
D4). The pattern is the same every time. Code builds a closed candidate set: domain options,
number spans found in the text, single-edit repairs that `propagate` accepts, schema fields, or
cached item rows. Jev picks from that set or ranks it. Code then validates the result with the
checks that already exist (`propagate`, `checkModel`, `compileList`) and keeps every number.
**Jev never writes a value that code did not offer.**

**Recommended first build: A1 (text → entries) and A2 (conflict repair), in that order.** They
share one server module and one request shape. A1 already covers 09-21's P1 (free text → history
search), because its output is ordinary entries that feed `scoreRows` unchanged.

---

## 1. Corrections to the 09-21 exploration

| 09-21 said | Code now | Consequence |
|---|---|---|
| P1 depends on fixing the truncated `domains` first (audit §5.1) | The truncation is still there: the canonical resolve loads `top: DEFAULT_PAGE` (100) rows per query table (`lookups.ts:291`). But every read now comes from the Postgres cache, and `RowCache` takes `search`/`searchCols` and `col`/`values` (`lookups.ts:44-53`). | The prerequisite is now a **shortlist query against Postgres**, not a fix to the resolve path. Nothing in this design reaches SAP. See A1 step 2. |
| D1 finds item codes through a token filter over `pricing.itemTable` | Still true. The items grid also has a fixed `ITEM_COL` (`model.ts`) that the removed docs pane used to match on. | If the documents pane comes back, it keys on items-grid codes. The text-to-code step (D2 below) is then the same code as picking an item for a BOM line. |
| The 5-minute `lookupCache` and `loadHistoryRows` / `config_history` are cited as the cache layer | Replaced by `config_masterdata_row` plus `ensureFresh`. The history query is an ordinary masterdata query (`configs.ts:234-239`). | A judgment cache can key on `masterdataVersion(tenantId)` as 09-21 suggested. It no longer has to also track a separate history sync. |

---

## 2. Configuration assistance — the core

The configurator's hard parts are already deterministic and good. `propagate` removes impossible
options and reports `conflicts` with a path. `enumerate` closes the open parameters.
`computeOutputs` does the numbers. What it cannot do:

1. read a customer's sentence (email, portal note, call notes),
2. say which input to change when the configuration becomes infeasible, and
3. tell which of 200 valid candidates the customer actually wants.

Those are exactly the three gaps a System One judgment fills.

### A1 — Request text → entries

**Behaviour:** on the process page, a "Fill from request" box. Paste the customer's text and every
parameter the text mentions is proposed as a **draft** value, marked with a suggestion indicator.
The page's single `draft` object (`ConfigProcessPage.tsx`) already models unsaved edits. Accepting
the draft goes through the normal `configs.calculate`, so no second write path exists.

**Candidate construction (code):**

1. **Option parameters with a manual or table domain:** take the live options from `propagate`
   against the current entries. Options already eliminated are never offered.
2. **Option parameters with a query domain (possibly thousands of rows):** first build a
   shortlist. Split the request into tokens and run a `RowCache` `search` over the table's
   `searchCols`, capped at about 30 rows per parameter. Always add `__none` ("the request does not
   specify this") and `__unlisted` ("the request names a value that is not among these options").
   `__unlisted` tells the user that the shortlist missed. It is the skill's candidate-coverage
   rule turned into a label.
3. **Numeric parameters (`domain.kind === "range"` or `type: "number"`):** a regex finds the number
   spans in the text, with the unit token and surrounding words (for example `s3: "120 mm"` or
   `s4: "DN100"`). The spans become the labels. Jev **selects a span, it never produces a
   number.** Code parses it, converts the unit to `Param.unit` or refuses a conversion it does not
   know, and checks the range. This is the value-extraction cookbook pattern.
4. **Boolean parameters:** one Choice with the labels `yes`, `no` and `__none`. A Noul cannot say
   "not mentioned".

**One request.** The state is the request text plus the model's own vocabulary: `label`, `unit`,
`help`, and the section title for context. Question keys are parameter keys.

```ts
state: {
  request: "Need 12 flanges, stainless 316L, DN100, PN16, raised face, pickled finish please",
  parameters: {
    material: { label: "Material", help: "EN grade", options: ["1.4404 (316L)", "1.4301 (304)", "S235JR"] },
    dn:       { label: "Nominal width", unit: "mm", spans: { s0: "12", s1: "DN100", s2: "PN16" } },
    face:     { label: "Face type", options: ["RF — raised face", "FF — flat face"] },
    …
  },
},
questions: {
  material: choice(
    "Which option for `parameters.material` does `request` ask for?",
    { "1.4404 (316L)": null, "1.4301 (304)": null, "S235JR": null,
      __none: "the request does not specify the material",
      __unlisted: "the request names a material that is not among these options" }),
  dn: choice(
    "Which span in `parameters.dn.spans` gives the nominal width that `request` asks for?",
    { s0: "12", s1: "DN100", s2: "PN16", __none: "no span gives the nominal width" }),
  …
}
```

Choice labels are what code receives back. For query domains, use the option **value**, which is
the B1 key, as the label and put the display label in the description. That way the returned
label maps straight back to a domain row with nothing left to parse.

**Composition (code, and the reason this is more than extraction):**

- Order the answers by confidence and apply them to a scratch `Entries` one at a time,
  re-running `propagate` after each. `propagate` is pure and runs in the browser too.
- If an applied value creates a conflict, do **not** make a second call. The Choice already
  returned a probability for every label, so code takes the best label that is still live. That
  is the "branch-specific answers up front" idea. If no live label is left, the parameter becomes
  a clarification (next item).
- **Clarifying questions come free.** A parameter whose answer is `__none`, `__unlisted`, or
  low-confidence is exactly what the salesperson has to ask the customer.
  `prompts/ai-agent.md`'s "in case of doubt, ask the user" becomes a list: *"The request doesn't
  say: face type, pressure rating."* No chat state or conversation table is needed (audit §5.6
  does not block this).
- Apply only visible parameters (`b.visible`). A suggestion for a hidden field is noise.

**Why this is safe:** every value that reaches entries was offered by code, either a live domain
option or a parsed span. The audit's §4.2 concern (unknown keys, wrong types) cannot happen here,
because keys come from `model.parameters` and values are coerced by `Param.type` before they touch
the draft.

**Feeds similarity for free:** once A1 produces entries, `configs.similar` ranks history rows with
them unchanged. That is 09-21 P1 with no separate endpoint.

### A2 — Conflict repair: choose among repairs code has proved valid

**Today:** `calculateProject` throws `Configuration has conflicts: …` or `No valid configuration
completes the current entries` (`configs.ts:189-196`). The audit calls this a dead end (§4.4).

**Behaviour:** when calculate fails, the page shows "Closest valid configurations", a ranked list
of single edits, each one click to apply.

**Candidate construction (code, deterministic, no AI):**

- For each parameter the user entered (not the defaulted ones, `b.defaulted`), and each of its
  domain options: set it, or clear it, and run `propagate` (plus a capped `enumerate` when there
  are no conflicts). Keep the edits that produce a feasible configuration. The conflict's `path`
  (`constraints[i]`) plus the constraint's `params` or expression refs narrow which parameters are
  worth trying. For a table constraint that is just its `params`.
- The result is a small set of **proven-valid** repairs, for example
  `{ r0: "material: 1.4301 → 1.4404", r1: "clear pressure rating", r2: "dn: 150 → 125" }`.
  Bound the search: a single edit first, and pairs only if no single edit works.
  `// ponytail:` single-edit repair, pairs as fallback; full MaxSAT only if real models need it.

**The judgment:** a Score per repair over one shared state (the request text, if any, the current
entries with labels, the constraint `message`s that fired, and the repair list), using one rubric:

```ts
score("How well does repair `repairs.r0` preserve what the customer asked for in `request` and `current`?",
  [ "changes something the customer explicitly required",
    "changes something the customer mentioned but did not insist on",
    "changes something the customer did not mention",
    "changes only a value that was a guess or a default" ])
```

Code sorts by the score level, then by price delta. `computeOutputs` has already run for each
repair, so "cheapest faithful repair" is a sort key, not a judgment. **With no request text the
feature still works:** skip the call and sort by price delta alone. The judgment improves the
ranking. It is not a dependency.

This is the strongest fit in the whole app: code guarantees feasibility, the judgment ranks by
intent, and neither could do the other's job.

### A3 — Narrow the candidate list to the request

`enumerate` can return up to 200 candidates (`CandidatesMatrix.tsx`). A Score per candidate would
need 200 questions over a large state. That is the wrong shape.

**Shape that scales with parameters, not candidates:** candidates differ only on the parameters
that were open. For each open parameter, one Choice over its values *that occur in the candidate
list*, plus `__indifferent` ("the request does not prefer any of these"). Code keeps the
candidates consistent with the non-indifferent answers above a confidence threshold and leaves
price ordering to code. Worst case is about 10 open parameters, so about 10 questions, one
request.

This reuses A1's question builder with a different candidate source (`candidates[].assignment`
instead of domains). It is worth building only after A1.

### A4 — Quote pre-flight check (verify, don't block)

Before `createQuote`, and only when request text exists: one Noul per **selected** parameter
value, asking whether it contradicts `request`. For example, the request says "flat face" and the
selected candidate has `face: RF`. A high probability shows a warning on `QuoteCreatePage`. It
never blocks the write: idempotent write-back and ETag handling stay the gate
(`config-quote.ts`). This is the citation-check pattern. It is cheap (one request), and it catches
the costliest mistake in the flow: quoting something the customer did not ask for.

---

## 3. Configuration similarity — additions to 09-21

09-21's P1 (text → entries → `scoreRows`) is now **A1**, and P2 (rerank the top 10 by
*reusability*) stands as written. Two additions:

- **P4 — Explain the gap, not the match.** The pane already shows per-parameter chips. For the
  top 1–3 rows, ask a Noul per *differing* mapped parameter: "Does this difference change the
  engineering (tooling, routing, material cert), or only the paperwork?" The rubric lives in
  `history.guidance` (proposed in 09-21 §5). The answer turns "3 of 5 match" into "differs only
  in colour", which is what decides whether the salesperson presses Copy.
- **Copy is a draft, not a write.** `onCopy` in `InsightsRail` should land in the same `draft`
  as A1's suggestions, with the same suggestion marker. Then "applied from a similar
  configuration" and "applied from request text" are one provenance mechanism, not two.

## 4. Document history search — additions to 09-21

D1 (text → item codes), D2 (rank lines as price references) and D3 (Noul "special price, not
repeatable") from 09-21 stand, **if** the documents pane returns (it was deleted in `df506cd`).
Two notes:

- **Key on the items grid.** `ITEM_COL` is fixed on every items table, so the pane's query key is
  the evaluated item codes from `evalTableRows`. `InsightsRail` already computes these. D1 is then
  only needed when a row has no code yet, which is the same problem as D2 below.
- **Keep price arithmetic out of the state's questions.** Put `ageDays`, `quantityRatio`, and the
  converted currency in the state as facts, as 09-21 says, and never ask "is this price
  reasonable". That is a number, and numbers belong to code.

---

## 5. Other use cases

Ranked by value divided by effort.

### D1 — Natural-language saved views (function-calling pattern) · **high value, low risk**

`ListVariantDef` (`packages/db/src/schema/variant.ts`) is a closed grammar: `filter` is
`{ field, op ∈ FilterOpZ, value }`, `orderby` is `{ field, dir }`, and `search` is free text. That
makes it an ideal target for "select, don't generate".

- "open quotations for Müller over 10k this quarter" → **Request 1** (Choice): which curated
  entity (the eight in `ENTITY_PROFILES`, plus `configs` and `models`, which run through
  `listSpec.ts`).
- **Request 2** (needs request 1's schema, so it is a second call on purpose): per candidate
  filter slot, a Choice over the entity's schema fields (`schemaColumns`) with `__none`, a Choice
  over `FilterOpZ`, and a Choice over value spans from the text. For a BusinessPartner field,
  code looks the span up in a value help and offers the matching rows.
- Code assembles the `ListVariantDef`. **`compileList` is the validator.** A filter on a missing
  field is already an error there (CLAUDE.md, "Saved views"), so a bad field choice fails loudly
  instead of silently widening the result. The result opens as an unsaved view the user can save.
  Same spec, both executors, no new query path.

`GlobalSearch.tsx` already has scopes and a popover of `SearchEntry` items. The natural-language
view is one more group in it.

### D2 — Item code from description (BOM lines, items grid, documents D1) · **high value**

The same shortlist-then-Choice step appears in three places: a BOM line's `itemCode` in the
builder, the items grid's `ITEM_COL`, and 09-21's documents D1. Build it once as
`judge.pickItem(text, shortlist)`. The shortlist is a `RowCache` search over `pricing.itemTable`
rows (`ItemCode`, `ItemName`, `ForeignName`, and `U_` descriptive fields). The labels are item
codes, plus `__none`. The builder's value help (`ValueHelp.tsx`) gets a "best match" row on top.
It is a suggestion, and the dialog is unchanged below it.

### D3 — Model builder: propose history mappings · **medium value, very low risk**

`HistoryTab.tsx` makes the author map each parameter to a column of the history query by hand. For
each parameter, a Choice over the cached query's columns (from the first cached rows) plus
`__none`, with the parameter's `label`/`unit`/`help` and a few sample values per column in the
state. A second Choice picks `exact | closeness | contains`, but that one mostly follows from
`Param.type` and the column's sample values, so let code decide it and ask only when they
disagree. **`checkModel` is the gate on save** (`check.ts:310`), so a wrong proposal cannot
persist in a broken form. It is one call per authoring session, so the cost is negligible.

### D4 — Portal request triage · **medium value**

Portal projects arrive as `status: "requested"`. For the internal inbox:

- Noul: "Is this request complete enough to quote without contacting the customer?" The state is
  the entries with labels, the open parameters from `propagate`, and any note on the
  `submitted` event.
- Choice: route to `sales` / `application engineering` / `needs customer clarification`, using
  the tenant's own descriptions.

Store the raw probabilities, not a verdict, so the inbox can sort and filter and the thresholds
can change without re-running inference. This is the "turn judgments into reusable data"
pattern.

### D5 — Rejection reasons as data (dashboard) · **low effort**

`rejectionNote` is free text (`configurator.ts:100`). A Choice over a tenant-maintained list of
reasons (price, lead time, not feasible, missing info, duplicate), plus `other`, classifies each
note once, on reject. The dashboard gets a "why we lose" breakdown that no text field can give.
One call per rejection, stored beside the note and never replacing it.

### D6 — Drawing extraction (feature A): Jev as the verifier in a cascade · **later**

Jev takes text or JSON state, not images, so it cannot read a drawing. It is still useful in a
two-stage cascade:

1. A vision or OCR model turns the drawing into text plus candidate spans with positions (title
   block, dimensions, notes).
2. **A1 runs unchanged** on that text, with the same spans-as-labels for numeric parameters.
3. A Noul per extracted value ("Does span `s7` in the title block support `material = 1.4404`?")
   verifies it. Only low-probability fields go back to the reasoning model or to the user.

This is the extraction-cascade pattern. A1 is the reusable half. Audit §5.3 (no file ingress, the
2 MB RPC cap) still blocks stage 1.

---

## 6. Where TypeSafe does **not** belong

| Place | Why not |
|---|---|
| `packages/config-engine` | Pure, zod-only, and it runs in the browser. There is no API key there and never an inference call. |
| Any number stored in `config_project` or sent to B1 | "Never trust the browser's figures" also covers a model's figures. Judgments rank, select, and flag, never price. |
| `doc-chain.ts` | An exact key traversal with a verified `$crossjoin`. There is nothing to judge. |
| DSL formulas in the builder (`FormulaDialog`) | That would be generation, not selection. `check.ts` would catch parse errors but not wrong formulas. A reasoning model with `checkModel` in the loop is the right tool, if this is ever wanted. |
| Masterdata column labels (`U_CF_Foo` → "Coating thickness") | Also generation. The source of truth is B1's UDF description, which `metadata.ts` can read. |
| Sync failure explanation | `syncError` is a B1 status and code. `toOrpcError` is already a lookup, and a lookup beats a judgment. |

---

## 7. Plumbing deltas from 09-21 §5

09-21's plan stands: a `Judge` seam in `apps/server/src/judge.ts`, the SDK in `apps/server` only,
`TYPESAFE_API_KEY`, the stale AI keys removed, a per-tenant budget, and degradation to
deterministic results. The additions:

| Piece | Where | Note |
|---|---|---|
| Question builders (`paramQuestions(model, prop, text)`, `spansOf(text)`, `repairQuestions(...)`) | `apps/server/src/assist.ts` | Pure, so they get network-free tests like `similarity.ts`. The `Judge` is injected. |
| `configs.assist.fromText` → `{ suggestions: { key, value, confidence }[], clarify: string[] }` | `orpc/routers/configs.ts`, `userProcedure` | Returns a draft and **never writes**. The client merges it into `draft`. |
| `configs.assist.repairs` → `{ repairs: { edit, outputsDelta, level? }[] }` | same | The repair search runs even without a key. Only `level` needs the judge. |
| Suggestion provenance | client `draft` first, `config_project.events` later | Until a suggestion is accepted it exists only in the draft, so no schema change is needed for v1. Audit §4.3's field-level provenance becomes necessary only when suggestions are persisted unaccepted. |
| Portal exposure | not in v1 | `clientProcedure` could expose `fromText`, but it widens the per-tenant cost and data-residency question (09-21 §7.4) to anonymous-ish portal users. Decide separately. |
| Timeouts | per call, around 3 s for A1 and A2 | The SDK has no total retry budget, so set `timeout` and `retry.maxRetries` explicitly. When the call expires, the deterministic result stands. |

---

## 8. Evaluation plan (A1/A2 first)

- **A1:** collect 30–50 real customer requests per pilot model, with the entries a salesperson
  finally quoted. Those are already in `config_project.entries` for quoted projects. Measure per
  parameter: accuracy when answered, abstention rate (`__none`/`__unlisted`), and the rate of
  wrong-but-confident answers. The last one decides the auto-apply threshold. A threshold with
  high accuracy on the tenant's data gets pre-filled. Anything below it becomes a clarification.
- **A2:** replay infeasible drafts from logs, or seed them by mutating quoted projects. Ask an
  application engineer which repair they would have picked. Compare top-1 agreement for price-delta
  ordering alone against price-delta plus Score. If the judgment does not beat the arithmetic on
  a tenant's models, leave it off for that tenant. The repair list still ships.
- **Budget:** A1 is one request per "Fill from request" press, with about one question per visible
  parameter. A2 is one request per failed calculate, only when request text exists. Neither runs
  per keystroke.

## 9. Suggested order

1. **A1**: the question builder, span extraction, the shortlist, and the propagate-aware apply.
   It is the foundation for A3, D2 and D6.
2. **A2**: repair search (useful without AI), then the Score ranking.
3. **D1** (natural-language views): independent of the configurator, high visibility, and
   `compileList` already validates it.
4. **D2** (item picker): reused by the builder, the items grid, and the documents pane.
5. 09-21 **P2** (reusability rerank) and **P4**, once A1 is feeding the similarity pane with
   entries.
6. D3, D4, D5, A3 and A4 as small increments. D6 once file ingress exists.

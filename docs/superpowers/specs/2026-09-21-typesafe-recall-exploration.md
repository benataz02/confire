# TypeSafe (System One / Jev) for Recall — Exploration

**Date:** 2026-09-21
**Scope:** feature B of `prompts/ai-agent.md` — *similar configurations* and *SAP B1 document
suggestions* — assessed against the TypeSafe System One programming model.
**Skill:** `.agents/skills/typesafe-ai/SKILL.md` (typesafe-ai/skills, MIT), installed in the same
commit range as this document.
**Status:** exploration. Nothing here is implemented; no dependency was added.

> **Sourcing caveat.** `docs.typesafe.ai` is blocked by this environment's egress proxy (403 at the
> CONNECT tunnel), so the live docs the skill points at could not be read. The API contract below
> was taken from the **official SDK source** — `@typesafe-ai/sdk@0.6.0`, repo
> `typesafe-ai/typesafe-sdk-js` (`src/types.ts`, `src/questions.ts`, `src/client.ts`) — which is a
> primary source for shapes and defaults but *not* for prompting guidance, limits, pricing or
> cookbooks. **Read `concepts/state`, `primitives/*`, `confidence` and the rerank cookbook before
> implementing any of this**; the question drafts below are informed guesses at wording, and the
> thresholds are placeholders to be fitted on tenant data, not recommendations.

---

## 1. The contract, in one page

One call, one **state**, N named **questions**, typed answers back:

```ts
const { answers, usage } = await client.systemOne({
  state: { /* text, or a JSON object/array */ },
  questions: {
    someKey: noul("…"),                       // → { noul: 0..1 }
    otherKey: choice("…", { a: "…", b: null }), // → { choice, confidence, probabilities }
    graded:   score("…", ["level 0", "level 1", "level 2"]), // → { score, confidence, legend, probabilities }
  },
});
```

Facts that shape every design below:

| Fact | Source | Consequence for Confire |
|---|---|---|
| One request carries **one state**; questions over it run in parallel and cannot see each other | `types.ts` `SystemOneRequest`, skill "Compose and verify" | Ranking K candidates = one request whose state holds all K, with one question per candidate — not K requests |
| Question **names are code-side only** and are not sent to the model | skill | Question keys can be row ids; the meaning must live in `instructions` |
| `choice` criteria is a **map of labels**; the model cannot pick a label that is absent | `questions.ts` (throws on an array) | Select-don't-generate: the label set *is* the allowlist, which is how a judgment can be made unable to invent an item code or a domain value |
| `score` criteria is an **ordered list, ≥2 levels**, indexed from 0 | `validateQuestions` | A relevance rubric must describe concrete situations per level |
| `noul` returns a probability of yes, **no separate confidence**; 0.5 means "uncertain", not "medium" | `types.ts` `NoulResponse`, skill | Never render a Noul as a percentage bar of intensity |
| Choice/Score `confidence` = distribution concentration, **not** correctness | skill | It gates *presentation* (offer vs. merely show), never a stored number |
| Defaults: model `jev-latest`, 10 s timeout **per attempt**, 2 retries, `TYPESAFE_API_KEY`, browser use off unless `dangerouslyAllowBrowser` | `types.ts` `TypeSafeClientConfig`, `env.ts` | Server-side only — which is free here, since both features are already server functions |
| `usage` is input/output tokens per request | `types.ts` `Usage` | K candidates sharing one state is also the cheap shape, not just the low-latency one |

---

## 2. The rule this codebase already implies

Confire's existing invariants decide, on their own, where a probabilistic judgment may sit:

- **"Never trust the browser's figures; handlers recompute"** (`CLAUDE.md`) generalises to *never
  trust a judgment's figures*. A System One answer may **rank, select from a closed set, or flag** —
  it may never produce a number that reaches `config_project` or a B1 document.
- **`packages/config-engine` is pure and dependency-free (zod only) and runs in the browser.** No
  TypeSafe call can ever live there. Everything below is `apps/server/src`.
- **`ensureFresh` fires off the request path and never throws** (`masterdata-sync.ts`); a stale
  cache is a page message, not a failed request. A TypeSafe outage must degrade the same way: the
  deterministic result still renders, the judgment layer is simply absent.
- **`b1.ts`/`B1Transport` prove the house style for an external dependency**: a named-method seam,
  injectable, so the pure logic has a network-free test (`similarity.ts` has exactly that property
  today — "Pure — no DB, no agent — so it has a network-free test", `similarity.ts:3`).

So: **a `Judge` seam alongside `B1Transport`, ranking only, degrading to today's behaviour when it
is absent.** That single sentence is the architecture; the rest is which questions to ask.

---

## 3. Feature B1 — configuration similarity

### 3.1 What exists

`configs.similar` (`orpc/routers/configs.ts:675`) → `searchSimilarRows`
(`orpc/routers/configs.ts:224`) → `scoreRows` (`similarity.ts:17`):

- The model's `history` block (`model.ts:253`) names a masterdata **query** table, a list of
  `mappings` (`param` → `column`, `match` ∈ `exact | closeness | contains`, `weight`), and the
  `display` columns that identify a row. `checkModel` gates all of it on save (`check.ts:313`).
- Scoring is `Σ(weight × match) / Σ(weight of the params the user filled)`, `closeness`
  self-normalised against the column's observed range, top-10, over **every cached row** read from
  `config_masterdata_row`. No network, no SAP.
- The pane (`configurator/HistoryPane.tsx`) re-ranks on a 500 ms debounce with
  `keepPreviousData` and `staleTime: 30_000`, and renders per-parameter chips — a per-match "why"
  that is already better evidence than most recall UIs ship.

### 3.2 The three real gaps

1. **No semantic path.** The audit's §4.5 already names it: *"customer asked for a stainless flange,
   roughly DN100" cannot reach it* without the entries being filled first. `contains` is a
   lowercased substring test (`similarity.ts:37`), so `"DN 100"` misses `"DN100"` and
   `"1.4404"` never matches `"stainless"`.
2. **Every filled mapping counts, in the author's fixed weights.** A row matching 4 of 5 mappings
   outranks one matching 3 — even when the 3 are the ones that decide whether the past job is
   actually reusable. The weights are per model, hand-authored once, and cannot depend on *which*
   values the salesperson typed.
3. **Rank ≠ reusable.** The UI offers a Copy button on every row (`HistoryPane.tsx`), including a
   35 % match. Nothing distinguishes "same job, copy it" from "vaguely related, look at it".

### 3.3 Proposals

**P1 — Free text → entries (`select`, don't generate).** *Highest value, lowest risk.*

A search box above the pane. Code supplies the candidate values; the judgment only picks among
them, so the result is structurally in-domain:

```ts
// state: the request plus the model's own vocabulary
state: {
  request: "stainless flange, roughly DN100, 12 off",
  parameters: [ { key: "material", label: "Material", unit: null,
                  options: ["1.4404 stainless", "S235 mild steel", …] }, … ],
}
// one Choice per mapped parameter, all in one request
questions: {
  material: choice(
    "Which `parameters` option for Material does `request` ask for? Choose `__none` if the " +
    "request says nothing about material.",
    { "1.4404 stainless": null, "S235 mild steel": null, __none: "the request does not mention it" },
  ),
  nominal_width: choice("… Nominal width …", { "DN80": null, "DN100": null, __none: "…" }),
}
```

- Options come from `ResolvedLookups.domains[param]`, which `configs.lookups` already returns —
  **but see the audit's §5.1 correctness trap: `domains` is one 100-row page for a query-backed
  table.** A judgment cannot choose an omitted value (the skill says so explicitly), so this
  proposal *depends on* fixing that truncation first. That is a prerequisite, not a detail.
- Numeric parameters have no closed domain. Either omit them here, or bound them with a Score over
  named bands the model author already understands — not a free number.
- The `__none` label is the skill's "include a no-match outcome"; without it every parameter gets
  forced to a value.
- **Then run today's `scoreRows` unchanged.** The judgment produced entries; the deterministic
  scorer produced the ranking. Both halves stay debuggable, and the weights keep meaning what the
  model author said they mean.

Why this is the best first step: it closes the gap the audit actually flagged, it reuses the pane
as-is, it cannot produce an out-of-domain value, and its failure mode ("picked DN80, I meant
DN100") is visible and one click from correction.

**P2 — Rerank the top-K as *reusability*, not similarity.**

`scoreRows` stays the recall stage (cheap, full scan, thousands of rows). Take its top 10 — the
existing cap — and ask one comparable Score per candidate over one shared state:

```ts
state: {
  current: { /* labelled entries, the model's parameter labels, not keys */ },
  candidates: { r0: { /* history.display columns + mapped columns */ }, r1: {…}, … },
}
questions: {
  r0: score(
    "How usable is `candidates.r0` as the starting point for `current`? Judge reusability of the " +
    "engineering work, not textual similarity.",
    [ "different product — nothing to reuse",
      "same product family, but size or material differs enough to re-engineer",
      "same family and size; minor differences a configurator change would cover",
      "effectively the same configuration; it can be copied and adjusted" ],
  ),
  r1: score(/* the identical rubric */), …
}
```

- **The rubric must be identical across candidates** — the skill's rule for graded ranking by
  comparable per-item Scores. Build it once and reuse the object.
- **State projection is already authored**: `history.display` is precisely the author's answer to
  "what identifies this row", plus the mapped columns are the evidence. Nothing else should go into
  the state — raw cached rows are whole B1 documents.
- Composition stays in code: final order by the deterministic score *and* the judgment (e.g. sort
  by judgment level, tie-break by `scoreRows`), with the weighting a constant in one place. This is
  the skill's "keep policy explicit and raw judgments reusable" — and it matches how this repo
  already treats `weight`: authored data, not model behaviour.
- **Use the level, not the number, in the UI.** The pane's three-band chip scale
  (`chipDesign`/`scoreHighlight`, exact / close / differs) already refuses false precision; a
  `score: 2.41` must render as its rubric level, never as "2.41 / 3".

**P3 — Semantic replacement for `contains` on messy columns.** *Defer.*

A per-mapping Noul ("does the historic value describe the same thing as the entered value?") would
fix `"DN 100"` vs `"DN100"`. But it multiplies questions by mappings × candidates for a problem
that normalisation (case, whitespace, unit tokens) solves for most of it, deterministically and for
free. **Try normalising `norm()` first**; keep P3 for columns that are genuinely prose (item
descriptions, customer notes) and only after P2 proves the request budget.

### 3.4 Where the call goes, and when

- The pane fires on a **500 ms keystroke debounce**. An inference call per keystroke is not
  acceptable — not for latency, not for cost, not for the absent rate limiting (audit §5.5).
- Gate it: `scoreRows` stays live per keystroke; the judgment runs **on an explicit action** (a
  "Rank by reusability" toggle or the search box's submit) or when entries settle (the same ~1 s
  quiet point `configs.calculate` already uses).
- Cache on the server by `(tenantId, modelId, masterdataVersion(tenantId), hash(entries), candidate
  row ids)`. `masterdataVersion`/`bumpMasterdata` (`lookups.ts:109-111`) already exist for exactly
  this and are bumped by the sync. Note `lookups.ts:279` warns against folding a configuration's
  entries into a memo key — unbounded user input. Hashing them and **bounding the cache** (LRU,
  short TTL) is the way to keep that warning satisfied; an unbounded `Map` keyed by entries is the
  leak that comment is about.

---

## 4. Feature B2 — document history search

### 4.1 What exists (and what was removed)

`doc-history.ts` was **deleted in `df506cd`** together with `history-sync.ts`. Recovering it
(`git show df506cd^:apps/server/src/doc-history.ts`) shows the shape the feature had:

- `docHistoryQuery(entity, { itemCodes, cardCode, top })` built a `$crossjoin` over
  `Orders`/`Quotations` × `DocumentLines`, filtered by `CardCode` equality and **exact `ItemCode`
  equality, OR-ed**, ordered by `DocDate desc`, capped by `$top`.
- `flattenDocs` produced `DocRow` — `docEntry/docNum/docDate/currency/cardCode/cardName/itemCode/
  itemDescription/quantity/unitPrice`, plus `matched: "both" | "customer" | "item"`.
- `sortDocRows` = both-matches first, then newest first. That is the entire relevance model.

The same B1 constraint is still recorded live in `doc-chain.ts`: **B1's `$filter` has no lambda
operators and no `in`**, verified against `b1s/v2` with three 400s (code 201). A document cannot be
filtered by a property of its lines except through `$crossjoin` with the `DocEntry` equality as the
join. There is **no text search over line descriptions** available at the B1 end, at any price.

### 4.2 Why this is the better fit for a judgment

The similarity pane answers "has someone configured this before". The documents pane answers a
harder question the sort order cannot: **"which of these past lines is a defensible price
reference for what I am quoting now?"** Date-descending says nothing about whether a line was a
sample, a rebate, an intercompany transfer, a 500-off volume deal, or a different currency.

**D1 — Free text → item codes, then the exact B1 read.**

The retrieval stays exactly what it is — quoted, escaped, code-equality, capped. Only the *choice
of codes* becomes semantic:

1. Candidates come from Postgres, not SAP: the cached rows of `pricing.itemTable` (the `Items`
   query that already exists for BOM pricing, `CLAUDE.md` § "the calculation core"), narrowed by a
   cheap token filter in SQL.
2. One request, one Choice per slot (or one Choice with the shortlist as labels, plus `__none`):
   the label set is the shortlist, so **the model cannot return a code that is not in the cache**.
3. `docHistoryQuery` then runs with those exact codes. `escapeLiteral` still sees only values that
   came from a cached B1 row — the filter-injection surface does not widen at all.

**D2 — Rank the returned lines as price references.** One shared state, one comparable Score per
line, same discipline as P2:

```ts
state: {
  quoting: { itemCode, description, batchQuantities, customer: { cardCode, cardName } },
  lines: { l0: { docType, docDate, cardCode, cardName, itemCode, itemDescription,
                 quantity, unitPrice, currency }, … },
}
questions: {
  l0: score("How good a price reference is `lines.l0` for `quoting`?",
      [ "not comparable — different item, or a one-off",
        "weakly comparable — same item, very different quantity or age",
        "comparable — same item, similar order of quantity, recent enough",
        "directly comparable — same customer, same item, similar quantity, recent" ]),
  …
}
```

**D3 — A separate presence judgment for "special price".** The skill's rule: an "any serious
violation" test does not belong inside a weighted score. A per-line
`noul("Does this line look like a special case — sample, rebate, intercompany, or a price that " +
"would not be offered again?")` is independently useful: a high probability demotes the line to
*reference only* and suppresses any "use this price" affordance, whatever D2 said.

**Policy stays in code**, and some of it must not be asked at all:
- **Currency.** `DocRow.currency` is the *document's* — the removed module says so in a comment. A
  cross-currency comparison is a conversion problem, not a judgment; filter or convert before the
  state is built.
- **Age and quantity bands** are arithmetic. Put them in the state as facts (`ageDays`,
  `quantityRatio`) so the judgment reasons over them rather than re-deriving them.

**What not to do: `doc-chain.ts`.** The forward walk (quotation → orders → deliveries → invoices)
is an exact key traversal with a verified join. There is no semantic step in it and nothing to
rank. Adding a judgment there would be cost with no question attached.

---

## 5. Plumbing, if this is built

| Piece | Where | Why there |
|---|---|---|
| `Judge` seam — one named method (`rank`, `select`) per use, never a URL at the call site | `apps/server/src/judge.ts` | Mirrors `B1Transport`/`QueryRunner`; lets the pure ranking have a network-free test, as `similarity.ts` does today |
| Pure composition (deterministic score + judgment level → final order) | `apps/server/src/similarity.ts` (extend) | Keeps the testable core testable; no API key in the tested path |
| `@typesafe-ai/sdk` dependency | `apps/server/package.json` only | `config-engine` stays zod-only and browser-safe — non-negotiable |
| `TYPESAFE_API_KEY` | server env | Audit §5.4: `GEMINI_API_KEY`/`GEMINI_MODEL`/`ANTHROPIC_API_KEY` sit in `.env` read by nothing — **delete those when adding this**, don't accumulate a third |
| Per-tenant request budget | new, before any of this ships | Audit §5.5: nothing bounds a loop over these endpoints today, and the similarity pane is keystroke-driven |
| Optional `history.guidance?: string` on `ModelDef` | `packages/config-engine/src/model.ts`, validated in `check.ts` | What makes two configurations comparable is per model and per tenant ("same alloy matters, colour does not"). It is authored text that belongs in the state, and the model is one jsonb doc, so it is additive. `checkModel` gating it keeps the "a model that saves cannot fail at runtime" property |
| Provenance | `config_project.events` (audit §4.3) | If a Copy is ever applied from a judged suggestion, that is the first thing anyone will ask about. `events` records status transitions only today |

**Degradation contract.** Judge unavailable, slow, rate-limited or unkeyed ⇒ log, drop the
judgment, return the deterministic result. The pane must never show an error because a ranking
service is down — the same posture `ensureFresh` takes toward a cold cache.

---

## 6. Budget and evaluation

- **Requests:** P1 = 1 per search submit. P2 = 1 per ranking action (10 candidates as 10 questions,
  one state). D1 + D2/D3 = 2 sequential requests (the second needs the first's codes to fetch the
  documents — the skill's stated reason a second request is warranted).
- **Tokens:** state is shared across a request's questions, so the projection matters more than the
  question count. Project `history.display` + mapped columns, never a raw cached B1 row.
- **Latency:** SDK default is 10 s per attempt with 2 retries and no total budget
  (`types.ts` `RequestOptions`: *"there is no total retry budget"*). Set an explicit per-call
  timeout well under the pane's tolerance and let the deterministic result stand when it expires.
- **Evaluation, before trusting any threshold:** take real tenant history rows, have an application
  engineer label "would you actually have started from this one?", then measure top-1 and top-3
  agreement for (a) today's `scoreRows`, (b) P2, (c) P2 composed with `scoreRows`. If (c) does not
  beat (a) on a tenant's own data, the judgment layer is cost without benefit for that tenant —
  which the model-level `history` config makes easy to switch off per model.

## 7. Open questions

1. **Is free-text recall in scope at all, or is recall always post-extraction?** The audit left this
   open (§4.5) and it decides whether P1 or P2 is the first build.
2. **Does the documents pane come back?** It was deleted recently (`df506cd`); D1–D3 assume it returns
   in some form, and `docHistoryQuery` is recoverable from `df506cd^` largely intact.
3. **Truncated domains (audit §5.1)** must be fixed before P1 — a Choice cannot select a value the
   candidate list omits.
4. **Per-tenant data residency:** state sent to TypeSafe contains customer names, item descriptions
   and prices from a tenant's SAP system. That is a contractual question for a multi-tenant SaaS,
   and it applies to P1 least (model vocabulary only) and D2 most (real document lines).

---

## 8. Bottom line

The fit is good, and narrower than it first looks. TypeSafe does not replace `scoreRows` or the B1
read; it adds the two steps neither can do: **turning a sentence into in-domain values** (P1, D1),
and **judging whether a retrieved row is actually reusable** (P2, D2/D3). Both sit behind existing
tenant-scoped server functions, both are structurally incapable of inventing a value when the
candidate set is supplied by code, and both can be switched off without the features going dark.

Recommended first step: **P1 behind the existing `configs.similar` handler**, after the truncated
`domains` trap is fixed — one request, one pattern, and the deterministic scorer keeps owning the
ranking while its value is measured.

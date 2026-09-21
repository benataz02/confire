# Jev (TypeSafe System One) in the CPQ workflow — design note

**Date:** 2026-09-21
**Status:** design proposal, nothing implemented
**Reads on:** `docs/superpowers/specs/2026-09-18-ai-readiness-audit.md` (findings F1–F13 referenced below)

---

## 1. Why this model fits this codebase specifically

Jev is not a small LLM. It is a *System One* model: you hand it a state (text or JSON) plus a set of
typed questions, and it returns **calibrated answers over the options you defined** — never prose,
never a tool call, never a number it invented. Three primitives:

| Primitive | Returns |
|---|---|
| `noul(claim)` | probability 0–1 that the claim is true (0.5 = uncertain, *not* "medium") |
| `choice(question, {key: description})` | one of your keys, a probability per key, plus a confidence |
| `score(question, [level, …])` | a position on your rubric (can land between levels, e.g. 1.4), probabilities per level, confidence |

TypeSafe's own framing is *"code still validates the answer and owns the action"*. That sentence is
already this repo's house rule, written in `CLAUDE.md` as **"never trust the browser's figures:
handlers recompute"**. Confire was built so that the only thing an untrusted party can influence is
*which* of the server's own options gets chosen — `configs.select` persists a `candidateIdx`, not a
total; `createQuote` rebuilds every line from the persisted project; `QUOTE_HEADER` refuses unknown
header fields by name. Jev's output shape is the same shape: **an index into a list the server
built.**

That is the whole thesis of this note. Everywhere the CPQ flow currently has a *judgment* gap —
which row did the customer mean, which parameter to ask about next, which historic order is really
comparable, is this a duplicate item — the deterministic core can produce a **short, closed list of
legal answers**, and Jev can pick from it at ~$0.042/1M input tokens and 70–500 ms, with a
probability you can threshold on. No candidate list, no Jev call. That rule alone removes the entire
class of "the model proposed a value that does not exist in SAP".

### The constraints, stated up front

- **Text and JSON only.** No images, audio or video. **Drawing extraction is *not* a Jev job** — a
  vision LLM still reads the drawing. Jev's role there is the second stage (§4.9).
- **It answers questions you wrote.** It does not discover fields, summarise, or write the
  clarifying question to the user in natural language. Multi-turn assistant prose still needs a
  generative model.
- **No arithmetic, no tool calls, no retrieval.** Recall/search stays deterministic; Jev re-ranks.
- **~64k context per request** (≈32k for state plus the longest question), 250k tokens/s,
  1,200 req/min, output tokens free. Many independent questions can share one state in one request —
  that is the unit of batching, and it is what makes the per-parameter patterns below affordable.
- Answer and confidence are **separate axes**. A 0.95 answer with low confidence is not the same as
  a 0.95 answer with high confidence, and thresholds are per action, not global.

---

## 2. Where it lives in the tree

One module builds Jev calls, the way `packages/b1/src/query.ts` is the only module that builds a
Service Layer URL:

```
apps/server/src/judge.ts     // the only module that constructs a systemOne() request
apps/server/src/judge/*.ts   // one file per call site: resolve.ts, rerank.ts, gate.ts, items.ts
```

Three properties to copy from what already works here:

1. **A `Judge` seam, injectable like `QueryRunner`.** `lookups.ts` is written against
   `QueryRunner`; production builds it with `runnerFor(connector)` and every test fakes it
   (`apps/server/test/mock-agent.ts`). Do the same: `type Judge = (req) => Promise<Answers>`, faked
   in tests with fixed distributions. **AI tool tests then need no live SAP and no live model** —
   both ends are already injectable seams, and a calibrated fake is far easier to write than a fake
   LLM because the response is a distribution, not prose.
2. **State is projected by allowlist, never spread.** `toPortalModelDef` (`portal.ts`) is the
   pattern: an explicit field list and a deliberate no-spread, so a new `ModelDef` field defaults to
   *excluded*. `toJudgeState` must do the same — **cost expressions, margins, `pricing.priceExpr`,
   BOM unit costs and supplier data never enter a third-party request.** This is the single
   highest-risk detail in the whole integration and it already has a pattern in the repo.
3. **`TYPESAFE_API_KEY` is server-side only.** Never the agent, never the browser. Jev needs no SAP
   access and holds no SAP credentials — it sees only what `toJudgeState` projected.

### The cost centre it does *not* touch

A Jev call costs no B1 licence slot. Better: the candidate stage for value resolution now reads
**Postgres, not SAP** — `queryTablePage` goes through `masterdataRows` → `pageRows` against
`config_masterdata_row`, with `ensureFresh` firing off the request path. So the loop
*search the cache → ask Jev to pick → threshold* is entirely cloud-local. That materially softens
audit finding F5 (no rate limiting on licence-slot paths) for every AI path built this way: the
frequency bound still matters for `calculate`, but the AI-specific traffic added here does not reach
the customer's agent at all.

---

## 3. The one invariant

> **Every Jev answer is a key from a list the server just built, and nothing downstream reads
> anything else.**

Concretely, the only things a Jev answer is ever allowed to become:

- an entry value that is a member of a `ResolvedTable` row the server returned;
- an index into `project.candidates` (which `applySelection` already validates);
- a boolean gate in front of an action a human could also take;
- a rubric level used for ordering or routing, never for arithmetic.

It is never a price, a quantity, a total, a document field, an item code typed free-hand, or a
parameter key that is not in `model.parameters`. Those remain what they are today: recomputed.

---

## 4. Call sites

Ordered by the CPQ workflow, each hung off a function that already exists.

### 4.1 — J1 · Value resolution: free text → a real masterdata row  ⭐ highest value

**Fixes audit F1**, the worst correctness trap in the tree: `configs.lookups` returns **one 100-row
page** of a query-backed domain (`DEFAULT_PAGE` in `lookups.ts`), so an LLM prompt built from
`domains` sees 100 of 4,000 materials and produces confidently wrong picks or spurious "no match".

The audit's conclusion was "an AI-facing resolution tool must be search-backed, not
domain-dump-backed". Jev is exactly the missing second stage:

```ts
// stage 1 — deterministic recall, from the Postgres masterdata cache, no SAP hop
const page = await queryTablePage(tenantId, {
  modelId, table: "materials", search: "stainless flange DN100", searchCols: ["ItemName", "U_Norm"],
});

// stage 2 — Jev picks among what actually exists
const options = Object.fromEntries(
  page.rows.slice(0, 12).map((r, i) => [`r${i}`, describeRow(page.columns, r)]),
);
const { answers } = await judge({
  state: { request: customerText, parameter: "material", unit: param.unit ?? null },
  questions: {
    row: choice("Which of these masterdata rows does the request name?", {
      ...options,
      none: "None of these rows matches the request.",
    }),
  },
});
```

Why this is strictly better than handing a domain to an LLM:

- **The domain is closed by construction.** The answer key indexes `page.rows`. A value outside
  SAP's masterdata is not expressible, so the F1 risk ("model picks a value outside the real
  domain", rated **High** in the audit's risk register) drops to *structurally prevented* — the same
  status the audit already gives to invented prices and duplicate quotations.
- **Truncation stops mattering**, because the list is a *search result*, not a page-1 dump.
- `none` is mandatory in every such option set (TypeSafe's own safety checklist: include an
  `other`/`unknown` option whenever the list may be incomplete). `none` → fall back to the value
  help dialog the user already has.

Thresholds: ≥0.90 auto-fill the entry **marked as AI-proposed** (§6); 0.60–0.90 show top-3 with
their probabilities; <0.60 open the picker. Run the same call per unresolved parameter, batched as
parallel questions against one shared state.

### 4.2 — J2 · What to ask next

`propagate()` returns `open: string[]` — the parameters still unbound — with no notion of *which one
matters*. For the assistant flow in `prompts/ai-agent.md` ("in case of doubt, the AI configurator
agent will ask questions"), asking in model-definition order is poor UX.

One request, one `noul` per open parameter, against the customer's text:

```ts
questions: Object.fromEntries(pre.open.map((k) => [
  k, noul(`Does the customer's request already state a value for "${labelOf(k)}"?`),
]))
```

- High probability → try J1 to resolve it instead of asking.
- Low probability across the board → ask, ordered by `mandatory` first, then by how much each
  parameter cuts `candidateEstimate` (deterministic, from `propagate`).

Cheap, one round trip for the whole form, and it needs no new storage.

### 4.3 — J3 · Ranking candidates

`enumerate` caps at 200 candidates and today the user picks an index. When several candidates
complete the entries, "which one did the customer mean" is a judgment call with a closed answer set.

Two-stage, because a `choice` option list must stay small and legible:

1. Deterministic prefilter to 5–8: cheapest, and the ones differing in the fewest parameters from
   what the user typed (`widest` already tells you the axis that blew up).
2. `choice` over those, each described by only the parameters that *differ* between them — a short
   state and a question the model can actually answer.

The answer is an index into `project.candidates`, which is precisely what `configs.select` already
accepts and `applySelection` already validates. **No new write path.**

### 4.4 — J4 · Turning a dead end into a suggestion

**Fixes audit F9.** When nothing completes, `calculateProject` throws
`"No valid configuration completes the current entries"` — a dead end that names nothing to relax,
while the far richer `propagate` diagnosis (`conflicts[].message` + `path`, per-option
`eliminatedBy` carrying the constraint author's own words) is computed on the line above and
discarded.

```ts
questions: {
  relax: choice("Which of these requirements is the customer most likely willing to give up?",
    Object.fromEntries(pre.conflicts.map((c, i) => [c.path, c.message]))),
}
```

The answer is a `path` (`constraints[3]`, `parameters.width`) — already machine-addressable, already
the thing the UI needs to highlight. The error becomes *"these four requirements conflict; the one
usually negotiable here is the DN rating — relax it?"* with a probability attached.

### 4.5 — J5 · Re-ranking similar configurations  ⭐ cheapest to ship

**Turns audit F11 from "needs pgvector" into "needs a re-rank call".** `scoreRows`
(`apps/server/src/similarity.ts`) is a pure weighted scan over the cached history table — exact /
contains / closeness over *mapped columns only*, top 10. It cannot see that "marine duty" and
"offshore spec" are the same thing; the `ponytail:` comment in `configurator.ts` names pgvector as
the upgrade path.

Retrieve-then-rerank is the standard answer, and Jev is a re-ranker:

```ts
// scoreRows stays the recall stage — cheap, deterministic, already tested network-free
const top = scoreRows(h, entries, rows, 25);
const { answers } = await judge({
  state: { request: customerText, current: displayableEntries },
  questions: Object.fromEntries(top.map((s, i) => [
    `r${i}`, score("How comparable is this past configuration to the current request?",
      ["Unrelated", "Same family, different spec", "Near-identical — safe to copy"]),
  ])),
});
```

Keep `scoreRows`' `matches` breakdown next to Jev's level and probability: the first says *which
parameters matched and at what weight*, the second says *how comparable it is overall*. Together
they are a Fiori Level 2 "why" popover with no extra modelling. `values` is already literally what
the Copy button applies, so the re-ranked list feeds `calculate` unchanged.

No embeddings, no pgvector, no new column, no sync job.

### 4.6 — J6 · Historic B1 sales documents as reference

The document reads are deterministic and already careful — `doc-chain.ts` walks
Quotations → Orders → Deliveries → Invoices with `$crossjoin` (B1's `$filter` has no lambda
operators; the file records the three verified 400s), item codes are only ever quoted filter values,
results capped. What they cannot do is tell a salesperson *which* of twenty past documents is
actually a precedent for this configuration.

Per document, against one shared state:

- `noul("Is this document for the same product family as the configuration being priced?")`
- `score("How comparable is this document's commercial basis?", ["Different customer and period", "Same customer or same period", "Same customer, same spec, recent"])`

Then show the survivors as *"priced before"* references, ordered by the score, each with its
probability. Note this is a **display and ordering** decision only — nothing about the document's
figures is recomputed or trusted; you are filtering a list SAP returned.

A second, higher-value use of the same data: `score("How aggressive is the discount on this
configuration relative to these comparable orders?", […])` as a **routing** signal to approval —
never as an input to the price. The price stays `computeOutputs`.

### 4.7 — J7 · The quote gate

Audit open question #4 — *does the agent write, or only propose?* — has a principled answer here
that does not require choosing between "always ask a human" and "let it rip": a
**confidence-gated action** with a high threshold, on top of the deterministic guards that already
exist and stay in force (SHA-256 `commandId`, the `U_CF_Key` pre-check, `b1DocEntry`,
`assertConfigMutable`, `QUOTE_HEADER` refusing unknown keys by name).

Before `createQuote`, one request against the `quoteDraft` output:

```ts
questions: {
  matchesRequest: noul("Does this quotation cover everything the customer asked for?"),
  unrequestedChange: noul("Does this quote differ from the customer's stated requirements in a way they did not ask for?"),
  humanAuthored: noul("Were the commercially material parameters set by a person rather than inferred?"),
  risk: score("How unusual is this quotation for this customer?", ["Routine repeat", "Normal variation", "Unusual — larger, cheaper or different than anything before"]),
}
```

All gates clear at a high threshold → the button is enabled / the agent may post. Any gate fails →
route to a human with the failing question named. **Jev is triage, not authority**: it can only ever
*withhold* the write, never authorise something the deterministic guards would refuse. That
asymmetry is what makes it safe to add.

### 4.8 — J8 · Item creation in B1

`ENTITY_PROFILES.Items` allows create with `requiredOnCreate: ["ItemCode", "ItemName"]` and a narrow
editable list. The two real risks in agent-driven item creation are **duplicates** (the classic
master-data explosion) and **misclassification**.

- **Duplicate check, before create:** lexical search of the cached `Items` rows for the proposed
  name/spec → top 10 → `noul("Does this existing item refer to the same physical article as the one
  being created?")` per row, one request. Any probability above threshold → refuse to create, return
  the existing `ItemCode`. This is the same check a good master-data process does by hand, and it is
  exactly the "entity alignment" pattern Jev is sold for.
- **Classification:** `choice` over the tenant's real `ItemsGroupCode` values (from the cached
  `ItemGroups` read) and over `SalesUnit`/`InventoryUOM` domains. Closed sets from SAP, so an
  invalid group code is not expressible.
- **Naming convention:** `score("How well does this description follow the conventions in these
  examples?", …)` with 20 existing item names in the state. Below threshold → propose, don't create.

Everything else about the write is unchanged: `pickEditable` still refuses fields by name and still
reports what it dropped.

### 4.9 — J9 · The second stage of drawing extraction

Jev cannot read a drawing. The split is:

| Stage | Who | Output |
|---|---|---|
| Read the drawing | vision LLM | raw callouts: strings, numbers, positions |
| Decide what each callout *is* | **Jev** | `choice` over `model.parameters` — which parameter this callout fills, plus `none` |
| Resolve a text callout to a masterdata value | **Jev** | J1 (§4.1) |
| Judge legibility / ambiguity | **Jev** | `score("How unambiguous is this callout?", …)` |
| Validate the whole proposal | `propagate()` | conflicts + `eliminatedBy`, side-effect-free |
| Apply | `configs.calculate` | one call |

This is worth doing even when the same vision model *could* do the mapping, for two reasons: the
mapping answer becomes **typed and closed** (no `"wdith"` — see F6), and it comes with a calibrated
probability the UI can show, which a vision model's self-reported confidence is not. Jev is also the
cheap guardrail on the expensive model's output — the "self-consistency check" pattern — at roughly
1/100th the cost of a second LLM pass.

### 4.10 — J10 · Routing and fencing the MCP surface

When the MCP server lands (audit feature D, blocked on machine identity, not on this):

- `choice` over tool names as a **cheap router** before spending a large model on tool selection;
- `noul("Does this request ask to write to SAP?")` as a fence that forces the approval path;
- `noul` policy checks on a tool argument set before it reaches a curated write.

Same rule as everywhere else: Jev can withhold, never widen. The allowlist in
`orpc/routers/entities.ts` remains the boundary.

---

## 5. Thresholds

Per action and per risk — TypeSafe's checklist is explicit that one global threshold is wrong, and
the CPQ flow spans read-only suggestion to ERP writes:

| Action | Reversible? | Gate |
|---|---|---|
| Re-order a "similar configurations" list (J5, J6) | fully | none — ordering only, show the score |
| Suggest a value, not applied (J1 low band) | fully | ≥0.60, show top 3 with probabilities |
| Auto-fill an entry, marked AI-proposed (J1) | yes, one edit | ≥0.90 **and** confidence high |
| Pick a candidate (J3) | yes, `select` again | ≥0.85, always visible and swappable |
| Propose a relaxation (J4) | it only asks | ≥0.50 — a ranked suggestion, never applied |
| Refuse to create a duplicate item (J8) | it blocks | ≥0.70 — **low bar on purpose**, blocking is the safe direction |
| Allow a quotation to post (J7) | **no** | every gate ≥0.95, *and* a human press unless the tenant opted in |

Two rules behind the table: the threshold follows the *cost of being wrong in that direction*, and a
gate that only ever blocks can sit far lower than one that only ever permits.

---

## 6. Provenance — the thing Jev makes honest

**Audit F10** is that `config_project.events` records status transitions only, so there is nowhere
to record that `width` came from a drawing at 0.82 while `material` was typed by a human — and
therefore no way to derive the Fiori **Level 1 explanation indicator**, which is the *minimum*
required whenever an ML/LLM output is shown.

Jev makes this cheap and, more importantly, *truthful*. Because it is trained for calibration
(answers given 90% should be right about 90% of the time), the number you display means something —
unlike an LLM's self-reported confidence, which does not. Store the distribution, not just the pick:

```ts
// ponytail: jsonb on config_project; a real table only if provenance needs its own reporting
type Proposal = {
  param: string; value: Val;
  source: "jev" | "vision" | "history" | "human";
  p: number; confidence: number; alternatives: { value: Val; p: number }[];
  model: string;        // the *versioned* model id from the response, not the alias sent
  at: string;
};
```

Log the versioned model the response reports, not the alias you sent — it is what makes a later
calibration review possible, and it is on TypeSafe's own safety checklist. The stored alternatives
are what the Level 2 "why" popover shows: *"stainless 316 (0.91); 304 was second at 0.06"*.

---

## 7. Budget

State per call is small once projected — a few hundred to a few thousand tokens (the customer's
text, 10–25 candidate rows, a handful of parameter labels). At $0.042/1M input tokens with output
free, a fully assisted configuration running J1 across a dozen parameters, J2, J3, J5 and J7 costs
on the order of **a tenth of a cent**. Latency 70–500 ms means J1 and J2 fit inside the existing
~1 s debounced auto-calculate without being noticeable, and J5/J6 fit in the panel load.

Cache the way the repo already caches: key a re-rank on `(modelId, model.updatedAt,
masterdataVersion, hash(state))`, alongside the existing 5-minute `lookupCache`. Most keystrokes do
not change the answer.

The practical ceiling is 1,200 req/min per account — batch every per-item question into one request
against a shared state, which is also the cheaper shape.

---

## 8. Build order

1. **J5 re-rank** (§4.5). No new storage, no write path, no identity work, immediately visible in
   the existing "similar configurations" panel, and the failure mode is a badly ordered list.
   Ships the `judge.ts` seam and the test fake.
2. **J1 value resolution** (§4.1). The highest-value one, and the one that retires audit F1. Needs
   the AI-proposed marker (§6) to be honest about what it filled.
3. **Deterministic entries guard** (audit F6/F7) — **not a Jev job**. Reject unknown parameter keys
   and coerce to `Param.type` in the shared write path. Do this before any model can write entries;
   it is a dozen lines and it fixes the UI, the portal and every future AI path at once.
4. **J4 conflict relaxation** (§4.4) — small, self-contained, turns the worst error message in the
   product into a suggestion.
5. **J2 / J3** (§4.2, §4.3) once the assistant flow exists to consume them.
6. **J7 quote gate** and **J8 item duplicate check** (§4.7, §4.8) — these gate writes, so they land
   with the approval record, not before it.
7. **J6, J9, J10** follow the features they belong to (B1 reference panel, drawing ingress, MCP).

Steps 1–4 need no machine identity, no file ingress, no blob store, and no streaming — i.e. **none
of the audit's four red blockers.** That is the argument for starting here rather than with the
full agent.

---

## 9. What this does not solve

- **Ingress (F4), machine identity (F2/F3), streaming and run records (§5.6 of the audit)** are
  untouched. Jev is a decision call, not a front door.
- **Extraction itself** still needs a vision model, and therefore still needs the drawing to reach
  something — the open question of whether inference runs in the cloud or on the customer's agent
  is unchanged. (Jev's half of the work is text-only and needs no drawing, which is a point in
  favour of splitting the two.)
- **Clarifying questions in natural language** need a generative model. Jev decides *what* to ask
  (§4.2); it does not phrase it.
- **Calibration is not correctness.** A calibrated 0.9 that is wrong 10% of the time is still wrong
  10% of the time; the thresholds in §5 are the design, not a formality.
- **Third-party data exposure** is a real decision even with `toJudgeState`: customer text, item
  descriptions and historic specs leave the tenant's boundary. Cost expressions must not (§2), and
  per-tenant opt-out belongs in the same place the model provider choice does.

---

## 10. Open questions

1. Platform key with tenant metering, or per-tenant BYO `TYPESAFE_API_KEY`? (Same question the audit
   raised for the LLM provider; the answer should probably match.)
2. Does J7 ever post without a human press, for a tenant that opts in — and does that need the
   approval record first?
3. Does the AI-proposed marker (§6) live as jsonb on `config_project`, or does provenance finally
   justify the run/message tables the audit lists as absent?
4. Is J1 allowed to auto-fill at all in the internal configurator, or only in the portal / assistant
   flow where the user is expecting help?
5. Re-rank caching: is a 5-minute cache on a *judgment* acceptable, given the model version can
   change under it?

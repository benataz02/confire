# Tenant visuals — design (2026-11-09)

## Intent

Hera's ALUMIGRAF model needs **how many pieces fit on a sheet**, with pieces free to sit upright or
rotated in the same layout, and a **picture of that layout** beside the sheet fields. Neither fits
today:

- The formula language cannot search (no loops, variables or user functions — on purpose: every
  formula is checked on save and always finishes). The best mixed layout is a search: on hera's
  default 1000×500 sheet with laser fibra (margen 10, paso 3) and a 120×70 piece, all pieces the same
  way round fit 42; mixing orientations fits **48**.
- The configurator form draws parameters and tables, nothing else.

Other tenants will want pictures of their own — a plain photo, a 2D drawing, later 3D — each with its
own calculation. So this is not one widget but a way for **a tenant's models to carry visuals written
for that tenant**, with the sheet layout as the first.

**Who writes a visual:** a Confire developer, in this repo, while prototyping a tenant's model. Never
the tenant or an end user. A visual is reviewed code that ships with a release, so nothing needs a
sandbox.

## Goals

1. A **visual** is code with declared **inputs**, declared **outputs**, a **calculation** and a
   **drawing**, available to the tenant(s) it names and to no other.
2. A model places a visual in a field group, the way it places a table. Each input is a formula over
   the model. Each output is a value every formula can read, named `<visual key>_<output>` — the
   pattern `<param>_<column>` and `<table>_<column>` already follow.
3. The picture and the outputs come from **one run of the calculation**, so they cannot disagree.
4. First visual: hera's **sheet layout** (below), whose piece count replaces the hard-coded
   `formato_qty = 5`.

## Non-goals

- **Interactions.** A visual only displays; it writes nothing.
- **3D now.** But nothing may block it: a drawing is any React component, loaded only where used.
- **Tenant-written code**, and therefore any sandbox.
- **Tenant formula functions.** A tenant's special calculation lives in a visual and comes out as
  outputs; the formula language stays one fixed list for everyone.
- **Several different articles on one sheet.** The sheet layout is for one-item configurations.
- **Non-guillotine layouts** (see the sheet layout's rules).

## Anti-goals (a failure even if it works)

- A count that disagrees with its picture.
- One tenant's visual usable in another tenant's model.
- A slow calculation stalling the configurator. It runs inside the calculation on every edit and for
  every candidate; a naive full layout search on a 3000×1500 sheet with 37×23 pieces did not finish in
  two minutes.
- Drawing data flooding the wire or the assistant's context (thousands of rectangles on every
  calculate).

## How it works

### A visual in code

Two halves sharing one **kind** id (e.g. `hera.sheetLayout`):

- **Calculation** — pure TypeScript in `packages/config-engine` (no React, no I/O), because its outputs
  feed formulas, which run on the server and in the builder's preview in the browser. It declares:
  - `tenants`: the tenant slugs it is available to (hera's: `["hera"]`);
  - a label;
  - `inputs` and `outputs`: name → `{ type: "number" | "string" | "boolean", label }`;
  - `compute(inputs) → { outputs, view }`, where `view` is plain JSON for the drawing.
- **Drawing** — a React component in `packages/ui` that draws a `view`. Loaded lazily per kind.

Each half has one static registry keyed by kind; tenant code sits in a folder per tenant
(`…/visuals/hera/`). A test checks that every calculation has a drawing and every drawing a
calculation. Adding a visual is two files and two registry lines.

### In the model

- `ModelDef.visuals?: { key, kind, title?, inputs: Record<inputName, formula> }[]` — optional, like
  `tables`, so no stored model changes.
- A visual's key shares the one namespace of parameters, computed values and tables, and a group's
  `params` list names it like a table key.
- `model-patch.ts` treats `visuals` as a keyed part, like `tables` (its `_covered` compile check
  already forces the choice).

### Calculation

- Inside `propagate`'s fixed-point loop, next to the table aggregates: evaluate each input formula;
  when every input is decided and of its declared type, run `compute` and write each output into the
  values as `<key>_<output>`. An undecided input (unbound, `null`, wrong type) leaves the outputs
  absent — undecidable, exactly like an unbound parameter — and the visual has no view. A `compute`
  that throws counts as undecided; it never fails a calculation.
- `compute` is memoized by kind + inputs, so the loop's iterations and the candidates' enumeration do
  not repeat it.
- The propagation keeps each visual's last view; `formState` puts it in `FormState.visuals[key]`
  (plain JSON). A visual in a hidden section or group is left out, as its fields are.

### Check (`checkModel`)

- The kind exists and lists the model's tenant. The server's `models.save` is the gate (it passes the
  tenant); the builder only offers the tenant's own kinds.
- Every declared input has a formula, and none is extra. Input formulas are checked like a computed
  value's.
- Outputs join the known identifiers, collision-checked like table aggregates — so
  `formato_qty = hoja_piezas` passes and a clash is named.

### Form

- A group that lists a visual draws its fields in one half of the width and the picture in the other
  (layout A of the mockups). On a narrow screen the picture goes under the fields. A group whose only
  visible item is the visual gives it the whole width *(Confire's call)*.
- No view → a short empty state in the picture's place (UI texts through i18n).
- A quoted, read-only configuration still shows its picture.
- **Staff only.** The staff configurator and the builder's preview draw visuals; the portal never
  does: `toPortalForm` drops `FormState.visuals`, and the portal's form draws none. (Outputs never
  reach it either — computed values already stay home.)
- **The chat and MCP tools leave drawing data out** of the views they return; a picture is for
  people.

### Builder

The author can add a visual to a group in the structure tree, pick its kind from the tenant's kinds,
write each input's formula with the existing formula control and the model's scope, read the output
names to use in formulas, and see the picture in the preview.

## First visual: hera's sheet layout (`hera.sheetLayout`)

**Inputs** (mm): sheet length, sheet width, piece length, piece width, gap X, gap Y, margin X,
margin Y.
**Outputs:** `piezas` (pieces per sheet), `aprovechamiento` (% of the sheet the pieces cover).

**Rules:**

- X runs along the sheet's length (`largoFormato`) and takes margin X; Y runs along its width
  (`anchoFormato`) and takes margin Y. Each margin is kept at **both** edges of its axis — a 1000 mm
  sheet with margen 10 leaves 980 mm *(Confire's assumption; the axes are confirmed, the both-edges
  rule is not)*.
- Gap X separates neighbours along X and gap Y along Y, **whichever way a piece faces** — the gaps
  belong to the sheet's axes, not the piece.
- Pieces are rectangles that may turn 90°, mixed freely in one layout.
- **Guillotine layouts only** (every cut runs straight across the piece of sheet it divides). Every
  machine can cut these, the shear included; on laser or punching a cleverer interlocking layout
  might rarely fit one more. *(Confire's call; revisit if a real quote shows it matters.)*
- Every placed piece lies inside the margins and keeps its gaps — a test checks the returned layout
  geometrically, not only its count.
- **Reference cases:** 1000×500, laser fibra (margen 10/10, paso 3/3), piece 120×70 → **48**
  (uniform: 42). Same sheet and piece, punzonado esq. redondeadas (margen 45/50, paso 5/12) → **36**.
- **Bounded time.** Hera's formats today are 1000×500 and 500×600, but standard sheets reach
  3000×1500, and hera's items have widths down to 6 mm. One calculation stays within **50 ms** on any
  input in that range *(Confire's call)* and, when the budget runs out, returns the best layout found
  so far (still valid).
- `aprovechamiento` is the pieces' total area ÷ the whole sheet's area, margins included, rounded to
  a whole percent *(Confire's call)*.
- **Compact view.** A guillotine layout is a few blocks of identical pieces, so the view is the sheet,
  its margins and a list of blocks `{ x, y, columns, rows, rotated }` — not one rectangle per piece
  (the 48-piece layout is seven blocks).
- **Drawing** (mockup A): the sheet, the usable area, upright and rotated pieces in two colours, and
  "48 piezas/formato · 81% aprovechado" under it.

**Model changes in ALUMIGRAF** (authoring in the builder, not code):

- a select parameter `mec_metodo` over MEC_Metodos, beside Mecanizado, so a combined row such as
  "Punzonado + cizalla" brings its own margins and gaps;
- a visual `hoja` in the Formato group with inputs `largoFormato`, `anchoFormato`,
  `IF(items_count == 1, items_salesLength, null)`, `IF(items_count == 1, items_salesWidth, null)`,
  `mec_metodo_pasox`, `mec_metodo_pasoy`, `mec_metodo_margenx`, `mec_metodo_margeny` — more than one
  items row leaves it undecided and empty;
- `formato_qty` = `hoja_piezas`.

## Known limits

- Every tenant's visual code ships in the one SPA bundle (the calculation inside the engine, the
  drawing as a lazy chunk). Nothing in it is secret today. `// ponytail:` upgrade path if a tenant's
  logic must stay private: calculate on the server only and draw from the view, with per-tenant
  chunks.
- Tenants are named by slug. Slugs do not change today; if they ever can, the registry moves to
  tenant ids.
- A test fixture copied from a tenant's model (`apps/server/test/assistant-extract.test.ts` uses
  ALUMIGRAF) runs under a test tenant, so it keeps no visual of that tenant's — or the save check
  refuses it.

## Left to the builder

- The layout search itself, within the rules, reference cases and time budget above.
- The memo's size and eviction.
- File names, registry shape and the builder's page for a visual.
- The empty state's wording and the drawing's exact styling (Horizon theme parameters, no raw
  colours).

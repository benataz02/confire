# Configurator Model Builder — User Guide

The Model Builder is where an **admin** defines a configurable product: the questions a
salesperson answers, the rules between those answers, and the bill of materials, routing and
price that fall out of them. You build against a **live test-drive** — the right-hand pane is
the real configurator running your unsaved draft on every keystroke, so you always see exactly
what a user will see.

> **Who can use it:** organization **owners/admins** only. The "Configurator models" item in the
> side navigation is hidden for regular members, and the server enforces the same boundary.

---

## 1. Getting in

1. Sign in and open your tenant (e.g. `acme.lvh.me`).
2. In the left navigation, click **Configurator models** (below Settings).
3. You land on the **models list**. Click **New model** — you're dropped straight into the
   builder. Nothing is stored until you **Save**.

**New model**, **Duplicate** and **Delete** all sit on the bar directly above the table, next to
the row count. To edit an existing model, click its row.

- **Delete** removes every ticked model. One that is already used by a saved configuration can't be
  deleted — you'll get a message saying so.
- **Duplicate** needs exactly one model ticked. It copies the whole definition — parameters, rules,
  tables, BOM, routing, pricing — under the name `<name> (copy)`, and opens it. The copy is
  **never published to the client portal**, even when the original is: publish it yourself once
  you've looked it over.

A brand-new model starts minimal but valid: one empty section, a default price of `unitCost * 1.2`,
and batch sizes `1, 10, 100`. The page title is **New model** until you name it on the **Settings**
tab; **Save** is the first write.
Nothing else is required until you add it.

---

## 2. The builder at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│ Cable assembly        ● Unsaved changes         [▲ 2]   [ Save model ] │  ← header
├───────────────────────────────┬──────────────────────────────────────┤
│ Parameters Rules BOM Routing … │  Live preview            [Reset]      │
│                               │                                        │
│   (the editor for the         │   (the actual configurator form,       │
│    selected tab)              │    running the real engine on your     │
│                               │    current draft)                      │
│                               │                                        │
│                               │  ✓ Consistent · 3 open · ~24 candidates│  ← status line
└───────────────────────────────┴──────────────────────────────────────┘
```

**Header:**
- **Model name** and an **"Unsaved changes"** marker when the draft differs from what's saved.
- **Message button `[▲ N]`** — the number of problems in the whole model. Click it to see the
  list; click any item to jump to the exact field that's wrong.
- **Save model** — **disabled while the model has any errors** or when there's nothing to save.
  If it's green, the model is valid and the save cannot be rejected.

**Tabs** each carry a red badge with a count when that tab contains errors, so you always know
where to look.

**Live preview (right):** the same form your users get, driven by your draft. The **status line**
at the bottom answers one question continuously:

- `✓ Consistent · N open · ~M candidates` — the model is coherent; `N` params still unanswered,
  roughly `M` valid combinations remain.
- A red strip instead — the current selections conflict; the message names the rule.

Use **Reset** to clear the test-drive's answers and start poking at it fresh.

> While the draft has errors, the preview keeps showing the **last valid version** (with a hint),
> so one half-typed expression never blanks your test-drive.

---

## 3. Expression fields

Many fields are **expressions**, not plain values — they're shown in a monospace font. An
expression can reference parameters, computed values, and functions.

- **Errors are underlined precisely.** Type `unitCost *` and the field turns red with
  `expected … — at «end»`; the message button counts it; Save is blocked until you fix it.
- **Suggestions.** As you type an identifier, a popover offers matching parameters, computed
  values, and functions (`IF`, `MIN`, `MAX`, `ROUND`, `CEIL`, `FLOOR`, `ABS`, `CONCAT`, `HAS`,
  `LOOKUP`). Click one to complete it; functions insert an opening `(`.

**What's in scope depends on the field:**

| Field | Can reference |
|-------|---------------|
| Computed values, constraints, parameter defaults/visibility | parameters + computed values |
| BOM and routing expressions | the above **+ `qty`** (the batch size) |
| Unit price expression | the above **+ `qty` + `unitCost`** |

Examples:
- Quantity: `cross_section * 0.01`
- Item code (a string expression): `material == "steel" ? "CBL-STL" : "CBL-ALU"`
- Price from a table: `LOOKUP("prices", "material", material, "price_per_mm2")`

---

## 4. Parameters tab — the form your users fill in

This tab defines both **what** users answer and **how it's laid out**.

### Structure

The tree **is** the form: **sections → groups → parameters, tables and formulas**. Everything the
user will see lives in it, in the order they will see it. Build it top-down:

1. **Add section** → **Add group** (adds to the last section) → **Add parameter** / **Add table** /
   **Add formula**. The toolbar buttons always attach to the last compatible row, so nothing is
   ever created loose.
2. **Rename** a section or group by clicking its row and typing a new title.
3. **Open** a parameter or a table by clicking its row — each has its own dialog.
4. **Reorder / move** by dragging rows. The drop marker only appears on **legal** targets:
   - a **parameter** can drop *into* a group, or before/after another parameter;
   - a **table** can drop *into* a group, or before/after another table;
   - a **group** can drop *into* a section, or before/after another group;
   - a **section** can reorder before/after another section.
5. **Delete** a row with its delete action. Deleting a **group or section** keeps its parameter
   *definitions* — they just become unplaced (see below). The **item grid has no delete**: every
   model needs one.

Row backgrounds tell the levels apart at a glance — sections darkest, groups a shade lighter,
leaves plain.

A group renders its parameters first, then its tables, and that is what the form does too.

If a parameter isn't in any group, a red strip lists it: *"Not shown where the tree says — place
each into a group."* Unplaced parameters don't appear to users at all.

### Adding / editing a parameter

The parameter dialog captures:

- **Key** — a valid identifier (letters, digits, underscore; can't start with a digit). This is
  what expressions reference. It's fixed once created.
- **Label** — what the user sees.
- **Type** — `string`, `number`, or `boolean`.
- **Control** — how it's rendered: `input`, `select`, `radio`, `checkbox`, `multicombo`, `step`.
- **Place in** — which group it goes into (new parameters only).
- **Value domain** — where its allowed values come from (see below).
- **Default (expression)**, **Visible when**, **Required when** — optional expressions.
- **Unit** and **Help text** — optional display hints.

### Value domains

The **domain** decides which values are offered:

| Domain | Use it for | You provide |
|--------|-----------|-------------|
| **None (free entry)** | open text/number | nothing |
| **Manual list** | a fixed short list | value + optional label rows (numeric values stay numeric) |
| **Table** | values from a masterdata table | table name, value column, optional label column |
| **Query (B1/Beas)** | values pulled live from SAP | the name of a masterdata query, value field, optional label field |
| **Number range** | a bounded number | min, max, step |

A half-built domain (a table with no value column, a query with no source) blocks **Save** and says
so at the top of the **Value domain** tab. To see the resolved options, save and use the live
preview pane — it runs the same resolution a real configuration does.

### Formulas (computed values)

A **formula** is a named expression derived from parameters (e.g. `area = cross_section * 1.1`).
It shows in the tree as a `ƒ` row **underneath a parameter** — purely so related things sit
together. That link is cosmetic: a formula is global and usable anywhere a parameter key is, from
any section, in BOM, routing, pricing or a rule.

Click a formula row to edit its name and expression; it reads as plain text otherwise, so it lines
up with the rows around it. The **Add formula** action on a parameter row puts a new one directly
beneath that parameter.

---

## 5. Rules tab — relationships between answers

Two kinds of rules:

### Expression constraints

Each row is: **When (optional)** · **Must hold** · **Message**.

- *Must hold* is a boolean expression that has to be `true` for a valid configuration, e.g.
  `material == "alu" ? cross_section >= 16 : true`.
- *When* limits the rule to certain configurations (leave empty to always apply).
- *Message* is shown to the user when the rule is violated.

A typo'd identifier turns the field red, badges the Rules tab, and the message button jumps you
straight to it.

### Combination tables

For "these specific combinations are (dis)allowed" logic that's easier as a grid than a formula:

1. **Add combination table**, then in the dialog pick **2+ parameters** (only parameters with a
   finite domain — selects, manual lists, or booleans — are eligible).
2. Choose a **mode**: **Forbid these** (block the listed rows) or **Allow only these** (nothing
   outside the list is permitted).
3. **Add row** and fill each cell. Cells with a known option list become dropdowns; otherwise
   they're free entry. Leave a cell as `—` to mean "any value".

Example: forbid `material = alu` together with `coating = silicone`.

In the live preview, a value made impossible by a constraint or combination table appears
**greyed out** with the rule's name in its tooltip, and the candidate count updates immediately.

---

## 6. Tables — repeated rows, and several items from one configuration

Some things a salesperson fills in are not one answer but *n rows*: the twelve machined holes in a
sheet, or the four different panels that come out of one nesting run. A **table** is that: a grid
whose columns you define, filled in per configuration.

Whatever the table is for, it hands the rest of the model **numbers**:

- `<table>_<column>` — the **sum** of that column over all rows (numeric columns only),
- `<table>_count` — how many rows there are.

These behave exactly like a parameter everywhere: BOM quantities, routing times, conditions,
price. That is the whole interface — a table never adds BOM or routing *lines*, only figures that
feed the ones you already wrote.

> Not to be confused with the **masterdata tables** of section 8. Those are shared lists of values
> you look values *up* in. These are per-configuration rows the salesperson *fills in*.

### Columns

Each column has a key (the name formulas use), a label, a type, an optional unit, and a **cell
kind**:

| Cell | The salesperson… | Notes |
|---|---|---|
| **Typed in** | types a value | number / text / checkbox, per the column's type |
| **Options** | picks from a list | a comma-separated list you type here, or a masterdata table/query |
| **Computed** | sees a result | an expression, evaluated per row |

A **computed** column's expression sees the whole model *plus its own row's earlier columns*, and
a row's own cells win over a parameter of the same name. Columns are evaluated **top to bottom**,
so a formula may use the columns above it but not the ones below — referencing a later column is
reported as *unknown identifier* and blocks the save.

**Worked example — machining time.** A calculation table `holes`, placed in the sheet's group:

| Key | Type | Cell | |
|---|---|---|---|
| `shape` | string | Options → `circular, rectangular` | |
| `size` | number (mm) | Typed in | |
| `perimeter` | number (mm) | Computed | `shape == "circular" ? 3.14159 * size : 4 * size` |

Now a routing operation's **Run/unit (min)** can read `holes_perimeter / feed_rate`, and
`holes_count` is there if setup is per hole. The salesperson adds rows; the price moves.

Rows can be pasted straight from Excel — a block of tab-separated cells appends as rows, mapped
positionally onto the columns you can type in (computed columns are skipped).

### Item grid — n items from one configuration

Every model carries exactly one **item grid**, seeded when the model is created and impossible to
delete: its rows are the **quotation lines**. (A model without one cannot be saved.)
This is merge production: one configuration, one BOM, one routing, but several *different* items
out of the run. The cost is genuinely joint, so it is not computed per item — the configuration's
total is **split** across the rows.

Two things drive the split:

- The grid's **`quantity`** column — how many of this item per finished unit. Line `Quantity` is
  `quantity × batch quantity`. The column is always called `quantity`; its key cannot be renamed
  and it cannot be deleted.
- **Cost basis** — an **expression**, written in the box above the field list, not a column the
  salesperson fills in. It is evaluated **once per row**, with that row's own columns in scope
  (plus every parameter, formula and table aggregate), and says what the split is proportional to:
  `width * height / 1000000` for area, `weight` for mass, `1` to split by quantity alone.

Each row's share is `basis × quantity ÷ Σ(basis × quantity)` of the configuration total, rounded to
whole cents so **the lines add up to the quoted total exactly**. A row with zero quantity ships
nothing and gets no share; a basis that cannot be evaluated weighs nothing. Step 4 of a
configuration shows the resulting lines with a line total, so the reconciliation is visible before
anything is posted.

**Item code without an article master.** Every line still carries the model's own
`quoteItemCode` as the B1 `ItemCode` — you do not create an item per configuration. The
customer-facing code goes in a **user field on the quotation line** instead, which your Crystal
layout prints. Set that per column under **B1 line field**: the dropdown lists your own B1's
DocumentLine UDFs, read live from SAP. `ItemCode`, `Quantity`, `UnitPrice` and `LineNum` are not
offered — the split owns them.

> If SAP is unreachable the dropdown becomes a plain text box rather than disappearing, so a down
> tunnel never stops you authoring a model.

Every other table you add is a **calculation table** — same shape, but its rows only feed numbers
into your formulas.

### Where a table appears

Wherever you drag it in the structure tree: a table sits in a **group**, and the form draws it full
width after that group's fields. A table left outside every group still renders — the form appends
it as a trailing section of its own, because a table nobody can reach is a table whose sums are
permanently zero.

**Min rows / Max rows** bound how many rows a *calculation* table may end up with (0 = no bound).
The item grid has neither: it always keeps at least one row and is never capped.

---

## 7. BOM & Routing tabs — what it costs

These are **"150%" definitions**: list every line that *could* apply, and let each line's
**condition** decide whether it applies to a given configuration.

**BOM** — each line has:
- **Id** (stable handle), **Item code** (expression), **Description** (optional),
- **Condition** (optional; empty = always), **Qty per unit**, **Unit price**, **Scrap %**.

Item, qty and price are expressions with parameters and `qty` in scope, so:
`qty = cross_section * 0.01`, `price = LOOKUP("prices", "material", material, "price_per_mm2")`.

**Routing** — each operation has **Resource**, **Condition**, **Setup (min)**, **Run/unit (min)**,
**Rate/hour**. Times and rate are expressions; setup is amortized across the batch by the engine.

Break an expression and the tab badges + the save gate stop you, pointing at the exact token —
e.g. `LOOKUP("nope", …)` flags *unknown table 'nope'* on the literal.

---

## 8. Where values come from — the Masterdata page

Tables are **not** part of a model. Both kinds — values you maintain by hand and live B1/Beas
queries — are workspace masterdata, managed under **Configurator → Masterdata** and referenced by
name from `LOOKUP()` and from **Table**/**Query** domains. One definition, every model.

See **[docs/masterdata-guide.md](masterdata-guide.md)** for creating and editing them.

A name the workspace does not have flags as *unknown table* on the literal, and blocks the save.

---

## 9. Settings tab — the model's frame

- **Name** — the model's display name.
- **Default batch sizes** — comma-separated positive integers (e.g. `1, 10, 100`) offered when a
  configuration is created. At least one is required.
- **Unit price expression** — how the sell price is derived, with `unitCost` and `qty` in scope
  (e.g. `unitCost * 1.4`).
- **Quote item code** — the SAP item code the resulting quote line uses.

---

## 10. Saving

When the model is valid (**message button green, no tab badges**), **Save model** is enabled.
Saving runs the same validation on the server, so a green save can't be rejected for model
errors. After saving, "Unsaved changes" clears; reload the page any time — your model persists.

If you left something broken, open the **message button**, click a problem to jump to its field,
fix it, and Save lights up.

**Duplicate** and **Delete** sit beside Save in the builder's header, and do the same as on the
list. Duplicate copies what is *saved*, so it greys out while "Unsaved changes" is showing — save
first. Delete does not: it discards whatever you were editing along with the model.

---

## Quick reference

| I want to… | Go to |
|------------|-------|
| Ask the user a question | **Parameters** → Add parameter |
| Offer a fixed list of choices | Parameter → domain **Manual list** |
| Offer choices from SAP | **Masterdata** → Create → kind **Query** → Parameter → domain **Query** |
| Offer choices from a spreadsheet | **Masterdata** → Create → kind **Table** → Parameter → domain **Table** |
| Enforce a rule between answers | **Rules** → Add constraint (or combination table) |
| Add up n repeated features (holes, welds, bends) | **Parameters** → Add table |
| Quote several items out of one configuration | **Parameters** → the model's item grid |
| Print a custom item code on the quotation | **Parameters** → item grid → column → **B1 line field** |
| Add a material / price line | **BOM** → Add line |
| Add a labor step | **Routing** → Add operation |
| Set the sell price / batch sizes | **Settings** |
| See what the user will see | The **Live preview** pane (always on) |

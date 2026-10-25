# Confire — go-to-market and pricing strategy: Basque Country manufacturers on SAP Business One

2026-10-25 · strategy draft, for the founder's decision

Every figure marked **[est]** is my own estimate or an assumption to validate in the first ten customer
conversations. Everything else is either read from this repo or sourced in §12. Where I could not find a
number, I say so instead of filling the gap.

---

## 1. The short version

1. **Who:** Basque make-to-order manufacturers (machining, fabrication, tooling, stamping, castings, machine
   builders) with 15–250 staff that run **on-prem SAP Business One** and quote from a client's drawing.
2. **Why they buy:** a quote takes hours of an estimator's time, the knowledge sits in two or three heads, and
   SAP B1 has no configurator of its own. Confire turns the estimator's rules into a model, prices from live SAP
   cost data, and posts the quotation into SAP B1 without retyping.
3. **How we reach them:** through SAP B1 partners and a handful of design-partner customers first, direct
   outreach through the Basque industrial clusters second. Not through paid ads or a self-serve funnel.
4. **What it costs them:** three annual-contract tiers at **€390 / €890 / €1,790 per month** (3 / 8 / 20 staff
   seats), a one-time **€2,900 setup**, **€1,800 per product-family model** (or a €6,500 launch bundle), and
   the customer's own clients on the portal included free. AI is an included allowance with metered overage.
5. **The honest constraint:** the Basque market alone is a beachhead of roughly **50–120 reachable accounts
   [est]**, worth about **€0.5–1M ARR** at best. The Basque plan is the proof and the reference base; the
   business is Iberia, then B1's DACH heartland, reached through partners. Plan the first year for ~15 paying
   customers, not 150.

---

## 2. What the repo says the product is

Read from `CLAUDE.md`, `docs/superpowers/specs/2026-10-24-ai-assistant-design.md`, the code layout and `DEPLOY.md`.
(`CLAUDE.md` refers to an `AGENTS.md` and to portal and notification specs that are not in the repo, so I have
not relied on them.)

| Capability | What it does | Why a buyer cares |
|---|---|---|
| **Model builder + rules engine** (`packages/config-engine`) | A product's parameters, rules, BOM, routing, cost and price live in one model. Impossible options are eliminated as you configure. | The estimator's experience stops living in one head or one Excel file. |
| **Live SAP B1 data, cached** (`packages/b1`, masterdata sync) | Item prices, price lists and lookups come from the customer's B1. The configurator still renders with the SAP link down. | Prices are the ERP's, not a copy that drifts. |
| **Idempotent quotation write-back** | Posts, re-quotes and closes a B1 Quotation; a double click or a lost response never creates a duplicate. Copy-to Order/Delivery/Invoice is built. | No retyping, no duplicate quotes in SAP. |
| **Customer portal** (`apps/portal`) | The manufacturer's own clients request quotes, see their quotes, orders, deliveries and invoices, upload files, get notified. | Faster response to RFQs, and a visible upgrade to the manufacturer's image. |
| **Windows agent** (`apps/agent`, Go) | One self-installing exe on the SAP server, outbound-only tunnel, SAP credentials never leave the customer, allowlisted calls only. | Passes an IT manager's first question: "what do I have to open?" Answer: nothing. |
| **AI assistant** (designed 2026-10-24, not yet built) | Reads a dropped drawing plus the email text, fills the configuration with a source for every value, asks for what it cannot settle. Also reachable over MCP from the user's own Claude or ChatGPT. | Turns the 2-hour RFQ into minutes, and onboards new salespeople. The demo moment. |
| **Operational base** | Multi-tenant, Better Auth, Postgres, Sentry, Resend mail, Spanish and English UI, a Hetzner deploy with nightly backups. | Cheap to run: the cost of serving a tenant is small. |

**State of the product for selling:** 64 commits since 2026-09-20, with the server, both SPAs, the portal and
the agent built. What is **not** built, and matters for this plan: billing and plan limits (the AI spec lists
"billing, invoicing, plans" as a non-goal), the AI meter itself, the AI assistant, AI-assisted model building
("later"), and any Basque-language UI. There are no operator or user guides in `docs/` yet. §10 turns these into a
work list.

---

## 3. The market

### 3.1 Size (what I could verify)

- Euskadi had **9,828 manufacturing establishments employing 176,685 people** on 1 Jan 2025 (Eustat business
  directory; I read the column order from the table layout, so confirm against the table).
- The average industrial establishment has **17.9 employees**, and **82.3% have fewer than 20**. Many are too
  small for SAP B1 at all.
- Industry employed **19.8% of the working population** in 2024, above the Spanish and EU averages (Eustat, via
  press). Industrial output was slightly negative in 2024–25, so owners are focused on margin and speed, not
  expansion.

### 3.2 Reachable accounts (my estimate, [est])

Eustat does not tell us who runs B1, and SAP does not publish installs by region, so this is a funnel built from
assumptions:

| Step | Assumption [est] | Result |
|---|---|---|
| Manufacturing establishments | Eustat: 9,828 | 9,828 |
| With roughly 15–250 employees | ~20–25% of the above (82% are under 20) | 2,000–2,500 |
| Running SAP B1 | 3–6% (B1 is one of several ERPs here; Odoo, Sage, A3, local ERPs compete) | 60–150 |
| Quote from a drawing or a variant list (configure-to-order or engineer-to-order) | ~60–80% | **40–120** |

Treat **50–120 accounts** as the planning range and replace it with a counted list in week 2 (§9). The
count itself is a deliverable: build it from SAP's Partner Finder, the partners' reference pages, cluster member
lists, and LinkedIn "SAP Business One" mentions on Basque industrial firms.

### 3.3 Where the buyers sit

Basque industry clusters are the natural lists and the natural trust network: machine tool and advanced
manufacturing (AFM), automotive (ACICAE), energy, steel and foundry, and the electronics/ICT cluster (GAIA). I
am naming them from general knowledge; confirm each one's current member list and events before contacting.
The best-fitting sub-sectors are those where **every order starts from a drawing**: subcontract machining,
sheet-metal and boiler work, tooling and dies, stamping, castings and forgings, and the machine builders'
component suppliers.

### 3.4 The channel: SAP B1 partners

- The only Basque-headquartered B1 partner I could find is **Itaktion** (Donostia). Search coverage was thin, so
  this is a lead, not a census: check SAP's Partner Finder for Spain filtered to Gipuzkoa, Bizkaia and Araba.
- The big Spanish B1 partners are headquartered elsewhere (SEIDOR, the world's largest B1 partner by its own
  account, is in Vic, Catalonia; others in Madrid, Castellón, Barcelona). They serve Basque customers remotely
  and by local office, so the Basque installed base is likely **served by non-Basque partners**.
- Partners need a reason to talk to their base: B1 has no native CPQ, partners are measured on add-on and
  service revenue, and Boyum's Beas (which Confire already speaks to) is the manufacturing add-on they
  already know.

### 3.5 What B1 customers already pay (the price anchor)

Third-party estimates (no official list price exists; partners quote):

| Item | Estimate | Source |
|---|---|---|
| B1 cloud, Professional user | ~$90–200 / user / month (central ~$100–150) | ERP Research, SEIDOR, HCO, Hyperbots |
| B1 cloud, Limited user | ~$47–120 / user / month | same |
| B1 on-prem, Professional | ~$2,700–5,500 per user one-time, plus 18–22% annual maintenance | same |
| Implementation | $15,000–$150,000+ | ERP Research |

An 8-user B1 customer therefore spends roughly **€800–1,200 a month** on the ERP alone and has already paid a
five-figure implementation. A quoting add-on in the same order of magnitude as one more ERP seat group is
believable; one at several times that is not.

---

## 4. Customer, pain and positioning

### 4.1 Ideal customer profile (first 12 months)

- Basque make-to-order manufacturer, **20–150 employees**, €5–40M revenue [est].
- **On-prem SAP B1** with a partner they like, already using Quotations, ideally with price lists and BOMs
  maintained (otherwise onboarding turns into a data-cleaning project).
- **40+ RFQs a month** or a quote that takes more than an hour. Below that the payback is too slow.
- A named person who feels the pain: the **head of estimating or oficina técnica**, or a commercial director
  with a team of juniors.
- Exclusion: companies wanting full ERP replacement, make-to-stock firms, anyone without B1.

### 4.2 Roles in the deal

| Role | Who | What they need to hear |
|---|---|---|
| Champion | Estimator / head of oficina técnica | "Your rules, in one place, applied the same way every time. You stop retyping." |
| Economic buyer | Gerente / commercial director | "Reply to RFQs the same day. Fewer errors, protected margin." |
| Gatekeeper | IT / SAP partner | "Outbound-only, nothing to open, SAP credentials stay on your server, allowlisted calls." |
| Blocker | Anyone whose Excel is their job security | Model-building is their new role, not their loss. |

### 4.3 Positioning

- **Spanish line:** *"Cotiza desde el plano, en minutos, directo en tu SAP Business One."*
- **Category:** configure-price-quote for SAP B1 manufacturers. Not a generic CPQ, not an ERP replacement.
- **Three proof points:** (1) prices and posts to **your** SAP, with idempotent write-back; (2) the model
  encodes your estimator's rules, and the server is the single source of every figure; (3) a branded customer portal
  that your clients use.
- **Against alternatives:**

| Alternative | Their strength | Our answer |
|---|---|---|
| Excel + the estimator's head (the real #1 competitor) | Free, flexible | Keeps the knowledge when the person leaves; same rules for every salesperson; posts to SAP. |
| SAP B1 native quotations | Already there | No configurator, no rules, no portal. Confire writes into it. |
| Custom quoting tool built by the B1 partner | Fits exactly | Costs five figures, lives with one developer. Confire is a product with the portal and AI included. |
| Enterprise CPQ (Epicor CPQ ~$150/user/month, Salesforce CPQ ~$75–150, Tacton, Configit) | Deep | Priced and scoped for large enterprises; weeks to months to start; none native to B1. |
| Drawing-to-quote tools for job shops (e.g., Paperless Parts, US-led, general knowledge) | Strong for machining | Not integrated to B1, English-first, no variant rules engine. |
| Boyum Beas | Manufacturing suite already installed at some B1 shops | Complement, not competitor: Confire already speaks to Beas. |

---

## 5. Go-to-market

### 5.1 Principles

1. **Partner-led, founder-supported.** The B1 partner owns the relationship, the SAP side and the trust; Confire
   owns the product and the model. Direct selling is for design partners and for accounts with no partner.
2. **Sell the proof on the customer's own data.** The most persuasive thing Confire can do is quote three of
   their *past* RFQs live, with their prices from their SAP. The product is built to make that cheap
   (agent pairing in one wizard, masterdata cache, seeded forms).
3. **The model is the product, so the modelling service is part of the product.** A rules engine empty of
   rules is worth nothing. Onboarding is a billable, scoped, repeatable service, and its length is the main limit
   on how fast Confire can grow (§8).
4. **Stay narrow until the first ten are live.** One ICP, one region, one ERP.

### 5.2 Phases (dated from today, 2026-10-25)

| Phase | When | Goal | Exit criteria |
|---|---|---|---|
| **0. Learn and recruit** | Nov – Dec 2026 | 3–5 design partners, a counted account list, partner conversations | 3 signed design-partner agreements; list of ≥100 named accounts; 5 partner calls done |
| **1. Prove** | Jan – Jun 2027 | Design partners live and quoting; first partner co-sells | 3 customers using Confire for real quotes weekly; 2 written case studies with a number each (hours saved, response time); first 5 paying contracts at list price |
| **2. Repeat through partners** | Jul – Dec 2027 | A repeatable motion | 2–3 active partners; 15 paying customers; onboarding down to ≤6 weeks from signature to first live quote |
| **3. Expand** | 2028 | Spain, then B1's DACH base | Navarra, Cantabria, Rioja, Aragón, Catalonia through partners; one non-Spanish pilot; AI model-building ships |

### 5.3 Phase 0 in detail (the next 8 weeks)

**Weeks 1–2: count and call**
- Build the account list (§3.2). Tag each with sector, size, partner (if known), RFQ volume signals.
- Call the B1 partners with a Basque presence. The pitch: "A configurator for your B1 base that posts into B1.
  You keep the services revenue and earn recurring commission. We need two partners to co-run a design-partner."
- Book 10 discovery interviews with estimators and commercial directors from the list. Questions that decide
  the pricing: RFQs per month, hours per quote, who prices, where prices live, what goes wrong.

**Weeks 3–6: recruit design partners**
- Offer (see §6.5): 50% off year-one licence, setup included, in exchange for weekly feedback, a case study,
  a logo and two reference calls, with a 12-month commitment. Never a free open-ended pilot.
- Demo structure (45 min): their last three RFQs → their model sketched → configuration with live B1 prices →
  post a quotation to their *test* company → the same request through the portal.
- Prerequisites check before signing: B1 version and Service Layer reachable, a Windows host that can run
  the agent, the `U_CF_Key` UDF can be created (the idempotent write refuses to run without it), price lists
  are maintained.

**Weeks 6–8: install and model**
- Agent pairing on the customer's SAP server, masterdata sync, then **one** model for **one** product family.
  Target: a first real quotation posted in 3 weeks from kickoff. Write down every hour spent; this is the cost base
  for the setup fee.

### 5.4 Channels, in order of expected return

| # | Channel | How | Cost | Expected role |
|---|---|---|---|---|
| 1 | **B1 partners** | Co-selling, certification, a partner portal page, joint demos at their customer events | Founder time, 20% commission | Most deals once running |
| 2 | **Design partners → references** | Case study, video, reference calls | Discount | Credibility for everything else |
| 3 | **Clusters and associations** | Short talks and workshops on "quote faster from a drawing" at AFM, ACICAE, GAIA and similar; their newsletters | Low | Lead generation and trust |
| 4 | **Direct outbound to the counted list** | Personalised email and LinkedIn to estimators and commercial directors, in Spanish; a phone call follows | Founder time | Fills the pilot pipeline |
| 5 | **Grant-assisted selling** | Help customers fit Confire into SPRI programmes (§7) | Low | Removes the budget objection |
| 6 | **Trade shows** | Basque industrial fairs (machine tool and subcontracting shows in Bilbao; confirm dates) | Medium | Only after case studies exist |
| 7 | **Content / SEO** | "Presupuestar desde plano", "SAP Business One cotizador", B1 user-community posts | Low | Slow compounding |

Not worth doing in the first year: paid ads, self-serve sign-up, a free tier, enterprise sales to large Basque groups.

### 5.5 Sales process

1. **Qualify** (20 min call): B1 on-prem? RFQs per month? Who quotes? Hours per quote?
2. **Discovery** (60 min, onsite or video): walk through three real quotes.
3. **Proof**: a paid **8-week pilot, €1,500, credited in full against year one**. Includes agent install, one model,
   five users. The fee filters tyre-kickers and funds the work.
4. **Decision**: pilot review against two numbers agreed up front (hours per quote, time to reply).
5. **Contract**: annual, auto-renewing, SEPA direct debit, Spanish-language contract with a DPA.
   Expect a **2–4 month** cycle from first call to signature [est].

### 5.6 The partner programme

| Item | Proposal |
|---|---|
| Commission | **20% of the licence for the life of the customer** the partner originates or co-sells (recurring) |
| Services | Partner may deliver the modelling and keeps 100% of its fee; Confire certifies the partner's modeller |
| Certification | Free, two days: model builder, agent install, write-back, support |
| Support | Partner is first line, Confire second line, with a response target by tier |
| Conflict rule | Customer originated by Confire stays Confire's; registered deals protected 6 months |
| Exclusivity | None. Never give a partner exclusivity for the region before the first ten customers |

Risk: partners selling their own bespoke quoting development may see Confire as competition. Mitigation: the
modelling service is theirs, and the portal and AI features are things a custom build cannot match cheaply.

---

## 6. Pricing

### 6.1 Principles

- **Anchor to the ERP, not to enterprise CPQ.** An 8-user B1 customer pays ~€1,000/month for the ERP; a quoting
  system priced at the same order of magnitude is rational, at several times that is not. Enterprise CPQ at
  $75–150+ per user per month is the ceiling we are *not* trying to reach.
- **Charge for the value unit the buyer understands: staff seats in tiers.** Not per quote (it taxes the
  customer's success), not per model alone.
- **Never charge for the manufacturer's clients on the portal at the low tiers.** The portal is the customer's
  showcase and our growth loop. Cap it at the high tiers only to protect the platform.
- **Services are priced to be profitable, not to be loss-leaders.** Modelling is the work that makes the
  product succeed; price it, and let partners earn on it.
- **AI is a metered allowance, not an unlimited promise.** The design already plans a meter and a monthly
  per-workspace limit "with pricing decided later". This is that decision.

### 6.2 Subscription tiers (EUR, ex-VAT, annual contract; monthly billing +15%)

| | **Starter** | **Pro** | **Business** |
|---|---|---|---|
| Per month, billed annually | **€390** | **€890** | **€1,790** |
| Per year | €4,680 | €10,680 | €21,480 |
| Staff seats | 3 | 8 | 20 |
| Models (product families) | 3 | 12 | Unlimited |
| SAP company | 1 | 1 | 2 |
| Customer portal, client companies | — | 25 | 150 |
| AI assistant allowance (drawing-to-configuration runs per month) | 50 | 300 | 1,200 |
| Notifications, views, file attachments | ✓ | ✓ | ✓ |
| MCP connector for the user's own Claude/ChatGPT, REST/OpenAPI access | — | ✓ | ✓ |
| Support | Email, next business day | Email + chat, same day | Priority, named contact, quarterly review |
| Typical customer | 15–40 staff, 3 quoters | 40–120 staff, a sales team | 120–250 staff, several product lines |

**Add-ons**

| Item | Price |
|---|---|
| Extra staff seat | €45 / month |
| Extra 25 portal companies | €50 / month |
| Extra AI runs | €0.30 per run (see below) |
| Extra SAP company | €200 / month |
| Production SLA / dedicated environment (later) | by quote |

Two-year prepaid: **10% off**. Annual price increases are capped at CPI + 3%. No other discounting beyond §6.5.

### 6.3 One-time services

| Service | Price | Includes |
|---|---|---|
| **Puesta en marcha** (setup) | **€2,900** | Agent install and pairing, SAP connection, `U_CF_Key` UDF, masterdata sync and price-list mapping, users, two training sessions |
| **Modelización** (one product-family model) | **€1,800** each | Workshop with the estimator, model build, validation against 10 past quotes |
| **Launch bundle** | **€6,500** | Setup + 2 models + 4 weeks of hypercare (saves €0 on the sum of parts but fixes scope and the date) |
| Additional training / workshop day | €900 / day | |
| Portal go-live (branding, sign-up domain, onboarding) | €900 | Included in Business |

Typical first-year invoice for a 3-family machining shop on Pro: €10,680 + €2,900 + 3 × €1,800 = **€18,980**.
A partner delivering the services would invoice its own modelling price directly.

### 6.4 The AI allowance and its cost (assumptions to check against the meter)

The assistant spec states a drawing extraction call costs "a cent or so". A full run (extraction, a few clarifying
turns, a re-calculation) is more. **Assume €0.05–0.15 per run [est]**. At €0.30 overage the gross margin is
≥50% even at the top of that range, and the included allowances cost us at most about €5 (Starter), €45 (Pro)
and €180 (Business) a month if fully used, against a €390–1,790 subscription. Measure it in the first
month the meter exists and move the allowance, not the tier price, if the real cost is higher.

### 6.5 Discounts and the founding offer

- **Founding customers (first 5):** 50% off year-one licence, setup included, in return for a 12-month commitment,
  weekly feedback, a case study with numbers, a logo and two reference calls. Year two is list price, locked in writing.
- **Pilot:** €1,500, credited against year one.
- **Partner-sourced:** no extra discount; the partner's commission is the incentive.
- **No** free tier, **no** unlimited seats, **no** discount for a verbal promise.

### 6.6 Why these numbers (value check, illustrative)

A machining shop that receives 60 RFQs a month and spends about 2 hours of estimator and salesperson time on each,
and gets that to about 45 minutes with Confire, saves 75 hours a month. At a loaded €35/hour [est] that is
about **€2,600 a month** of time, against €890 for Pro: the licence pays for itself in ten days of the
month, before counting a faster reply or one extra order. Treat this as the template for an **ROI sheet** filled in
live in discovery with the buyer's own numbers; if their numbers don't clear 3× the tier price, they are not an ICP
fit yet.

### 6.7 Unit economics (rough, [est])

- **Serving cost per tenant:** a cheap shared server, Postgres, mail, Cloudflare tunnels and AI. Likely
  **€15–60 per month**, which puts software gross margin at **~90%+** before support.
- **The real cost is people:** onboarding hours (record them in Phase 0), support and the founder's time. Price
  the setup so that it covers the hours at a blended rate of ~€90/hour [est]; €2,900 + €1,800 per model is about
  32 hours + 20 hours per model at that rate.
- **CAC via partner:** 20% of year-one licence (€936 for Pro) plus founder time per deal.
- **Payback on the licence alone:** well under a year; on a 5-seat Starter the partner commission is under €1,000
  a year, so the setup fee is what pays for the effort.

### 6.8 How to publish it

Publish the tier table and "desde €390/mes" on the website; keep the services as a scoped quote. SME buyers in
Spain distrust "contact us" pricing, and a visible price filters out the unserious. Do not publish partner
commission terms.

---

## 7. Funding the customer's purchase

The Basque government's SPRI agency runs regular programmes that fund industrial digitalisation. The ones I
found for 2026 (verify each against the BOPV text and SPRI before putting them in front of a customer):

| Programme | What it is | Status I found |
|---|---|---|
| **Renove Smart Industry 2026** | Funds advanced machinery and equipment including software for Industry 4.0 projects | Call published 11 Mar 2026, closed 16 Apr 2026; expect a similar window around March–April 2027 |
| **Inteligencia Artificial Aplicada 2026** | Grants for applied AI projects, reportedly 50–60% of cost, up to €100,000 | Reported open until 2 Nov 2026 by a single commercial blog; too late for most but confirm |
| **Fast Track Innobideak 2026** | For industrial SMEs, product and process innovation line | Open call in 2026 |
| **Ciberseguridad Industrial 2026** | IT/OT security projects | Not ours, but a competing claim on the same budget |

I could not confirm the current status of **Kit Digital** or an "Industria Digitala" line. The lever: build a two-page
grant dossier for prospects ("how to describe a Confire project to SPRI") and learn the submission calendar a quarter
ahead, so a deal can be timed to a window. Using the AI assistant as the centrepiece of an application is the
strongest fit. Check the eligibility rules on recurring SaaS fees versus one-time project costs before
promising anything: the setup and modelling fees are the natural grantable part.

---

## 8. Constraints and risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Small addressable base** | 50–120 reachable accounts [est] in Euskadi | Treat Basque as the proof; plan Iberia through partners from Phase 2; count the list before committing to numbers |
| **Modelling is a bottleneck** | A model takes ~20 hours; one founder can onboard perhaps 2 customers a month | Charge for it, certify partners, ship vertical starter templates (machining, sheet metal, tooling), prioritise AI-assisted model building |
| **Partner conflict** | A partner may prefer its own bespoke quote tool | Partner keeps modelling revenue and earns recurring commission; no exclusivity |
| **Drawings are customer IP and the AI provider is US-based** | The assistant spec explicitly leaves out an EU-region provider; Basque manufacturers guard drawings | Ship AI as **opt-in per workspace**, publish a data-handling note and DPA (no training on data, retention terms), measure whether prospects object; pursue an EU-region option if two or more deals stall on it |
| **Agent install friction** | A signed Windows service on the SAP server needs IT approval | Code-sign the exe, one-page IT security sheet (outbound-only, allowlist, credentials stay local), install with the partner |
| **On-prem assumption** | Customers moving B1 to partner-hosted cloud still work only if the agent can sit next to the Service Layer | Test one hosted-B1 setup in Phase 1; do not assume it works |
| **Trust in a young vendor** | 5-week-old git history, one maker | Founding-customer references, backups documented in `DEPLOY.md`, escrow-style continuity promise, partner as second line |
| **Founder bandwidth** | Selling, modelling, supporting and building | Hire or contract a modelling consultant first, not a salesperson |
| **Price pressure** | Spanish SME buyers negotiate | Hold list price, trade scope or term, not rate; use the ROI sheet |

---

## 9. Metrics

| Metric | Phase 1 target (Jun 2027) | Phase 2 target (Dec 2027) |
|---|---|---|
| Named accounts on the list | 150 | 300 |
| Discovery interviews | 25 | 60 |
| Pilots started | 6 | 15 |
| Paying customers | 5 | 15 |
| Average annual contract value [est] | €8,000 | €10,000 |
| ARR | ~€40,000 | ~€150,000 |
| Time, signature to first live quote | 4 weeks | ≤6 weeks incl. models |
| Partners with at least one live deal | 1 | 3 |
| Pilot-to-contract conversion | 50% | 60% |
| Gross logo retention | n/a | ≥95% |
| Hours saved per quote at customer (case study) | measured | published |

A plausible three-year path [est]: 15 customers by end 2027, 45 by end 2028 (€0.4–0.5M ARR), 100 by end 2029
(~€1M ARR), of which Euskadi is perhaps a third.

---

## 10. What to build or write to make this sellable

Ranked by when each blocks a sale:

1. **Before the first pilot:** one-page IT security sheet; DPA and data-handling note (including the AI provider);
   a signed Windows agent; a Spanish contract template; an ROI sheet; a discovery script.
2. **Before the first paying customer:** subscription billing or at least a manual invoicing process with SEPA
   debit; plan limits (seats, models, portal companies) enforced in the server; the AI meter and monthly cap
   that the assistant spec already calls for. A first customer can run on manual invoices; do not build billing
   before three contracts exist.
3. **Before partners:** the partner one-pager, certification material, and a **model builder guide** (the repo
   has none; `CLAUDE.md` says operator guides belong in `docs/`).
4. **For the demo:** the AI assistant (drawing in, configuration out, sources shown). It is the headline, and
   today it is a design document. Ship it before the cluster talks.
5. **Next:** vertical starter models; AI-assisted model building; Basque-language UI (the i18n framework is in
   place; do this when a Basque-speaking buyer asks, or for cluster credibility); a published case study.

---

## 11. First 90 days (from 2026-10-25)

| By | Do |
|---|---|
| **Week 1** | Decide the pricing in §6 as the working draft. Start the account list. Write the one-page pitch in Spanish. |
| **Week 2** | Call Itaktion and 4–5 other B1 partners. Finalise list v1 (≥100 accounts). Book 10 interviews. |
| **Week 4** | Interviews done; revise the ICP, tiers and the ROI sheet from what you heard. Sign the first design partner. |
| **Week 6** | Two more design partners signed. Security sheet, DPA and contract template ready. |
| **Week 8** | First agent paired in a real customer. Time every onboarding hour. |
| **Week 10** | First real quotation posted from a design partner's configuration. Start the case study. |
| **Week 13 (end Jan 2027)** | Review: do the numbers hold (hours saved, setup effort, willingness to pay)? Adjust §6 before the first paying customers. Choose the channel to scale. |

---

## 12. Decisions for you

1. **Do you accept the "partner-led, services-priced" model**, or do you want a direct, productised, low-touch
   product? This plan assumes the former because modelling cannot be removed yet.
2. **Is AI part of the standard pitch from day one**, given the drawing-IP question? I recommend yes, as opt-in.
3. **Who does the modelling** in Phase 1: you, a contractor, or the partner?
4. **Entity, VAT and invoicing:** the plan assumes a Spanish entity invoicing in EUR with SEPA debit.
5. **How far outside Euskadi** do you want to go in 2027, and with which partner?

---

## Sources and limits

Everything from the web is a search result I did not verify at the source; check the figures before you quote them to a customer.

- Eustat, establishments and employment by activity section, 1 Jan 2025: <https://en.eustat.eus/elementos/ele0014700/ti_establecimientos-y-personas-empleadas-en-la-ca-de-euskadi-por-sexo-seccion-de-actividad-a21-segun-territorio-01012025/tbl0014731_i.html>
- Eustat, Basque industrial sector 2024: <https://es.eustat.eus/elementos/ele0025500/ti_sector-industrial-de-la-ca-de-euskadi-2024/not0025531_c.html>
- Industry's 19.8% share of employment (Deia, 2026-10-21): <https://www.deia.eus/economia/2026/10/21/industria-absorbio-19-8-empleo-11672716.html>
- Basque government 2026 Industry order (83% of industrial firms under 20 staff): <https://www.euskadi.eus/web01-bopv/es/bopv2/datos/2025/12/2505528a.shtml>
- SAP B1 pricing estimates: [ERP Research](https://erpresearch.com/pricing/sap-business-one), [SEIDOR](https://www.seidor.com/en-ae/blog/what-price-sap-business-one), [HCO](https://www.hco.com/insights/sap-business-one-pricing-costs-usa), [Hyperbots](https://blog.hyperbots.com/sap-business-one-pricing-explained-licensing-cloud-costs-hidden-fees-in-2026)
- CPQ pricing anchors (Epicor, Salesforce, CPQuick): [Software Advice](https://www.softwareadvice.com/cpq/salesforce-profile/), [Capterra](https://www.capterra.com/p/205245/Quote-Tool/reviews/), [Monetizely](https://www.getmonetizely.com/articles/how-are-cpq-solutions-priced-for-enterprises-a-complete-procurement-guide)
- Basque B1 partner lead (Itaktion) and Spanish partners: [ERP Research partner list](https://www.erpresearch.com/en-gb/sap-business-one-partners), [Seidor / Beas](https://seidor.com/en-qa/blog/boyum-beas-manufacturing-industry)
- SPRI 2026 programmes: [BOPV, March 2026](https://www.euskadi.eus/web01-bopv/es/bopv2/datos/2026/03/2601266a.shtml), [Euskaltel summary](https://blog.euskaltel.com/empresas/ayudas-euskadi-digitalizacion-2026/)

**What I could not verify:** the number of Basque companies on SAP B1 (no public source), Basque B1 partner
coverage beyond one name, Kit Digital's current status, exact cluster membership and event dates, and
every figure tagged [est]. The first ten interviews exist to replace these.

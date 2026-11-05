# Direct Crystal printing — design

2026-11-05. Status: agreed in conversation, not built. The spike (§8) gates the build.

## 1. Why

Printing today is one route: Confire → agent `/print` → the SAP B1 **API Gateway**'s Reporting
Service (`apps/agent/gateway.go`, `ExportPDFData`). It is slow everywhere, and one client's B1
version answers it with an internal error whose SAP note says the only fix is upgrading B1 — not an
option in the short or medium term. That client cannot print from Confire at all.

So: a second print engine that renders the same Crystal layouts **on the client's SAP server,
beside the agent**, with no API Gateway and no B1 version requirement. The Gateway stays the
default; an admin switches a workspace to the new engine in Settings.

Callers, all existing and unchanged: Print on the Object Page and the List Report (one selected
row) in the staff app, the portal's documents, the timeline — every one goes through
`printDocument` (`apps/server/src/print.ts`). Next (not this work): attaching a document's PDF to
client mail, which will call the same `printDocument`.

## 2. Goals, non-goals, anti-goals

**Goals**
- Print Quotations, Orders, DeliveryNotes and Invoices (`PRINTABLE`, unchanged) through Crystal on
  the SAP server, on any B1 version, SQL Server only.
- Print **what B1 would print**: the document's default layout from `GetDefaultReport`, per
  customer, for both engines. The per-entity layouts in `agent.json` go.
- Faster than the Gateway. The spike's warm figure is the baseline.
- Per-workspace engine choice in Settings → SAP agent; the Gateway stays the default.

**Non-goals**
- Mail attachments (next; they reuse `printDocument`).
- HANA for the direct engine. PLD layouts. Choosing a layout in the UI. Per-B1-user defaults (a
  Confire user is not a B1 user). Printing several documents into one PDF.
- Falling back from one engine to the other: one engine per workspace, its errors shown as they are.

**Anti-goals** (would be a failure even if it printed)
- The SQL login reaching the cloud. It lives in `agent.json` on the box, like the SAP passwords.
- A new port or door on the client's server: the engine listens nowhere.
- SAP's Crystal DLLs in our repo or our image.
- Layout-picking logic in the agent, so a change to it needs every agent updated (the agent is thin
  — CLAUDE.md).

## 3. Constraints

- The client's box: SQL Server, Crystal Reports runtime for .NET **13.0.31.4010** (SP31) installed
  (from its Control Panel). Windows Server 2012 R2 must work (the agent's Go 1.26 rule, see
  `apps/server/Dockerfile`), so the engine targets **.NET Framework 4.8**.
- Crystal's runtime is .NET-only; the Go agent cannot host it. Hence a second exe.
- Agents in the field update on their own schedule: Confire must cope with an old agent's `/health`
  and an old agent's `/print` during rollout.

## 4. Decided (by the user)

- A print service on the client's server, along the agent, rendering Crystal layouts.
- An **alternative** to SAP's solution, which stays the main one; the admin activates it in
  Settings (`apps/app/src/routes/$slug/settings.tsx`).
- The layout is **`ReportLayoutsService_GetDefaultReport`**, cached **when someone prints**, for
  **2 hours**. Layouts in `agent.json` are removed; GetDefaultReport is the only source.

## 5. How it works

```
printDocument(tenant, entity, docEntry)                       apps/server/src/print.ts
  ├─ PRINTABLE fence (unchanged)
  ├─ read the document: CardCode, DocType                    b1.readEntity(…, { select })
  ├─ reportCode = QUT|RDR|DLN|INV + (DocType items ? "2" : "1")
  ├─ layout = cache[tenant, companyDb, reportCode, CardCode]  2 h, in process memory
  │     miss → GetDefaultReport { ReportCode, CardCode } → LayoutCode
  │            GetReportLayout  { LayoutCode }           → Category (must be rlcCrystal)
  ├─ engine = sap_connection.print_engine                    "gateway" (default) | "crystal"
  └─ agentPost /print { entity, docEntry, layout, engine }
        agent: layout must start with the entity's type prefix (QUT for Quotations…)
          ├─ gateway → ExportPDFData?DocCode=<layout>        (gateway.go, minus its layouts map)
          └─ crystal → confire-print.exe (child, stdin/stdout) → { pdf, fileName }
```

### 5.1 Confire side

- **`print.ts`** resolves the layout as above, with no new transport method: `readEntity` with a
  `select`, and the two service calls through `createEntity(<Service_Method>, body)` — how
  `SeriesService_GetDocumentSeries` is already called (`orpc/routers/portal.ts`). Both are
  one-segment POSTs the agent's allowlist already passes. `companyDb` comes from the connector the
  call itself uses (`Connector.companyDb`, CLAUDE.md's rule), so a company switch can never serve
  another company's layout. The cache is a plain `Map` with an expiry per entry; the two processes
  each keep their own. The portal's `docs.print` already reads the document (`ownDoc`); pass that
  row in rather than reading it twice.
- **Report codes**: `{ Quotations: "QUT", Orders: "RDR", DeliveryNotes: "DLN", Invoices: "INV" }`
  + `"2"` for `dDocument_Items`, `"1"` for `dDocument_Service`.
- **`sap_connection.print_engine`**: `text` enum `gateway | crystal`, not null, default `gateway`,
  with its migration. Pairing's upsert writes only its own columns, so a re-pair keeps the choice.
- **Settings → SAP agent** (`AgentCard`): a Printing choice — *SAP API Gateway* / *Direct
  (Crystal on the SAP server)* — saved by a new `adminProcedure`. Each option shows whether the
  paired agent has that engine set up (from `/health`). *Direct* can be picked only while the
  agent reports it set up (the procedure checks `agentStatus` too). So the order is: setup on the
  box first, then the switch. An agent too old to know `engine` never reports it, so it is never
  sent one. The Gateway can always be picked. The "Printing" row stops listing entities and shows
  the configured engines instead.
- **`agentStatus`** reads both `/health` shapes: an old agent's `print: string[]` means "gateway
  configured" when non-empty. An old agent given `layout` ignores it and prints its own
  `agent.json` layout, so the Gateway keeps working through the rollout.
- **Errors** (server i18n, en/es/eu): the default layout isn't Crystal (names the layout). An engine
  that disappears from the box later answers the agent's 503, which says what to set up.

### 5.2 Agent (Go)

- **`/print`** takes `{ entity, docEntry, layout, engine }`. `layout` is required and must start with
  the entity's type prefix — the allowlist idea: a leaked secret still prints only these four
  document types. `engine` absent = `gateway`.
- **`gateway.go`**: `Export(layout, docEntry)`; the `layouts` map and `Printable()` go.
- **`config.go`**: `Print.Layouts` goes (an old `agent.json` still loads: Go's JSON decoding skips
  unknown keys). A new optional block for the direct engine: SQL server, user, password.
- **`/health`** `services.print` becomes `{ gateway: bool, crystal: bool }`.
- **Wizard**: the Printing step loses its layout questions. A second optional step, *Direct printing
  (Crystal, SQL Server)*, asks the SQL server (default: the Service Layer's host), user and password,
  and tests them by running `confire-print.exe --check`: SQL login, the company's `RDOC` readable,
  Crystal runtime loaded. The test reports the runtime version on success and the reason on failure.
- **The child**: run like `cloudflared` (`tunnel.go`) — embedded in the agent exe
  (`bin/confire-print.exe`), written beside it on install, started with the service when configured,
  restarted when it exits. The SQL login goes in through its environment, never its command line.
  One request at a time (a mutex); a print that takes longer than 60 s kills the child, and the
  next print starts a fresh one.
  `// ponytail: one child, prints in series — a small pool if prints ever queue.`

### 5.3 The print service (`confire-print.exe`, C#)

- .NET Framework 4.8 console exe, built on Linux/CI with `dotnet build` and the official
  `Microsoft.NETFramework.ReferenceAssemblies` package. **Crystal is bound at runtime** from the
  box's GAC, through reflection or `dynamic`, so no SAP DLL is referenced at build time. Built in
  the Dockerfile's agent stage, beside the cloudflared download, and embedded before `go build`.
- Protocol: one JSON line in, one out. In: `{ layout, docEntry, objectId }`. Out:
  `{ pdf: <base64> }` or `{ error }`.
- Per request: load the layout's `.rpt` from `RDOC.Template` by `DocCode` (keyed by layout code,
  kept 2 h, held loaded). Refuse bytes that are not an `.rpt` (`D0CF11E0`). Apply the logon to every
  table of the report and its subreports: the configured SQL server, user and password, and the
  database **`companyDb`** (B1's company *is* its SQL database, so the engine cannot print another
  company than the agent serves). Set `DocKey@` (typed by the parameter's kind) and
  `ObjectId@` when the layout has it (23/17/15/13). Then `ExportToStream(PortableDocFormat)`.
- File name as today: `<entity>-<docEntry>.pdf` (the agent sets it).

## 6. Verified on the live B1 (tenant hera, 2026-11-05)

- `GetDefaultReport { ReportCode: "QUT2" }` → `LayoutCode: "QUT20009"`, `CardCode: "-1"`. RDR2 →
  RDR20011, DLN2 → DLN20013, INV2 → INV20017 — identical to hera's old `agent.json` layouts.
  ~50–75 ms per call warm through the tunnel (658 ms cold).
- With `CardCode: "C168"` it answers for that customer (no customer default set there, so the
  general one).
- `GetReportLayout { LayoutCode: "QUT20009" }` → `"Category": "rlcCrystal"`.
- `ReportTypes`: QUT1 = service quotation, QUT2 = item quotation, QUT3 = summary. The other three
  prefixes' `1`/`2` are assumed by the same pattern: **verify** with GetDefaultReport.

## 7. Unverified — what the spike answers

- That a B1 Crystal layout renders outside B1 once the logon is replaced. A layout whose tables use
  a connection only B1 can open would not.
- That `RDOC.Template` holds a plain `.rpt`.
- The runtime's bitness (the engine is built x64) and the warm time per print.

## 8. The spike — the gate

`~/dev/print-spike/print-crystal.ps1`, outside the repo, throwaway. On the failing client's box:
`-List QUT`, then `-Layout <GetDefaultReport's LayoutCode> -DocEntry <two quotations>`, and the
same for one order, delivery and invoice. Build the C# service only once it renders all four.
If the logon fails on a connection type, stop and revisit this design. The spike's load
approach (`LoadWithPartialName` from the GAC) is the one the service uses.

## 9. Left to the builder

The `agent.json` key names; the Settings control (a `SegmentedButton` or `Select`); i18n wording;
the C# project layout under `apps/agent`; how `bun --cwd apps/agent build` builds the exe locally
(`dotnet` is installed on the dev machine). Update CLAUDE.md (the agent paragraph), DEPLOY.md
(agents) and `docs/superpowers/specs/2026-10-21-agent-autosetup-design.md`'s Printing step.

## 10. Calls made in the design (not the user's)

- The cache lives on Confire's server, not the agent (thin agent).
- Per-customer defaults are honoured (one GetDefaultReport per (report code, customer) per 2 h).
- A non-Crystal default is refused with a clear error, checked with one GetReportLayout per cache fill.
- The engine ships inside the agent, like cloudflared, and talks over stdin/stdout. No second
  installer, no port.
- C# over a long-running PowerShell child: an encoded PowerShell started by a service is a classic
  antivirus/EDR alarm on a customer's server.
- No fallback between engines. Prints run one at a time.
- *Direct* can be chosen in Settings only once the agent reports it set up. This also keeps it
  away from agents too old to know it, with no extra check per print.
- The SQL database is the agent's `companyDb`, never asked separately.

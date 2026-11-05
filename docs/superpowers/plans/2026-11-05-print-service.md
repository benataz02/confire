# Direct Crystal Printing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Print SAP documents with B1's own default layout, through the API Gateway (default) or a new
Crystal engine that runs beside the agent on the client's SAP server, chosen per workspace in Settings.

**Architecture:** `printDocument` (`apps/server/src/print.ts`) reads the document, resolves its default
layout through `ReportLayoutsService_GetDefaultReport` (cached 2 h in process memory) and sends
`{ entity, docEntry, layout, engine }` to the agent's `/print`. The agent checks the layout against the
entity and hands it to the Gateway or to `confire-print.exe`, a .NET Framework 4.8 child process it
embeds, installs and supervises like `cloudflared`, speaking one JSON line in, one out.

**Tech Stack:** Bun + oRPC v2 + Drizzle (server), React + UI5 Web Components (app), Go 1.26 (agent),
C# / .NET Framework 4.8 with Crystal Reports for .NET bound at runtime (print service).

**Spec:** `docs/superpowers/specs/2026-11-05-print-service-design.md`

## Global Constraints

- Bun only; type-check per project: `bunx tsc -p apps/server/tsconfig.json --noEmit`, `bunx tsc -p apps/app/tsconfig.json --noEmit`, `bunx tsc -p packages/db/tsconfig.json --noEmit`.
- Server tests run from the repo root (`bun test apps/server/test/<file>`; the root `bunfig.toml` preload drops real keys). Dev Postgres must be up.
- A schema change ships as a migration: `bun run db:push` then `bun run db:generate`, commit the SQL.
- Agent: `cd apps/agent && go test ./... && GOOS=windows go vet ./...`; the exe is built only with `bun --cwd apps/agent build` (Go 1.26; must load on Windows Server 2012 R2).
- The layout cache lives 2 hours (`LAYOUT_TTL_MS = 2 * 60 * 60 * 1000`), keyed by tenant, the call's `Connector.companyDb`, report code and CardCode.
- `agent.json` holds no layouts; `GetDefaultReport` is the only source.
- The SQL login never leaves the SAP server and never appears on a command line (environment only).
- No SAP/Crystal DLL is referenced at build time or committed; Crystal is loaded from the box's GAC.
- Print service: .NET Framework 4.8, x64, file name `confire-print.exe`; target box runtime 13.0.31.4010.
- Every `/print` timeout on the child: 60 s. One print at a time.
- New user-facing texts in en, es and eu (server `apps/server/src/i18n/{en,es,eu}.ts`; app `apps/app/src/i18n/parts/admin.{en,es,eu}.properties`).
- Deliberate shortcuts carry a `// ponytail:` comment naming the ceiling and the upgrade path.
- Work on a branch off `main`: the `saved-reports` working tree holds unrelated uncommitted changes.

## Review Focus

- A **service-type document** (`DocType: "dDocument_Service"`) prints with its `…1` layout (QUT1), not the items one → Task 1 test.
- A **company switch** inside the 2 h window never serves the old company's layout → Task 1 test.
- An **old agent** (health `print: string[]`) keeps printing through the Gateway and can never be switched to Direct → Task 2 tests.
- A **hung or crashed print child** costs one failed print, never the agent: killed after the timeout, and the next print works → Task 6 tests.
- A **default layout that is a PLD form** is refused with a message naming it, and nothing is sent to the agent → Task 1 test.

---

### Task 0: Spike gate (the user, on the client's SAP server)

Blocks Task 5 and Task 6 only. Tasks 1–4 ship value without it (B1's defaults for the Gateway).

- [ ] **Step 1:** The user runs `~/dev/print-spike/print-crystal.ps1` on the failing client's box for one quotation, order, delivery and invoice, each with its `GetDefaultReport` layout (spec §8).
- [ ] **Step 2:** Record the result in spec §7 (renders yes/no, connection types seen, 64-bit, warm seconds per print, whether `RDOC.Template` starts `D0CF11E0`). If any layout fails on its connection, stop and revisit the spec before Task 5.

---

### Task 1: Confire prints with B1's default layout

**Files:**
- Modify: `packages/db/src/schema/sap.ts` (column on `sapConnection`)
- Create: `packages/db/drizzle/NNNN_*.sql` (generated)
- Modify: `apps/server/src/print.ts`
- Modify: `apps/server/src/portal/orpc/docs.ts:105-109` (pass the row it read)
- Modify: `apps/server/src/i18n/{en,es,eu}.ts` (`PRINT_NOT_CRYSTAL`)
- Modify: `apps/server/test/mock-agent.ts`
- Create: `apps/server/test/print.test.ts`
- Modify: `apps/server/test/portal-docs.test.ts:174-181`

**Interfaces:**
- Produces: `sapConnection.printEngine: "gateway" | "crystal"` (column `print_engine`, not null, default `"gateway"`); `export type PrintEngine = "gateway" | "crystal"` from `@confire/db`.
- Produces: `export const REPORT_PREFIX: Record<string, string> = { Quotations: "QUT", Orders: "RDR", DeliveryNotes: "DLN", Invoices: "INV" }` and `export function reportCode(entity: string, docType: unknown): string` (prefix + `"1"` for `"dDocument_Service"`, else `"2"`) in `print.ts`.
- Produces: `printDocument(tenantId: string, entity: string, docEntry: number, doc?: { CardCode?: unknown; DocType?: unknown }): Promise<PrintedDocument>`; the `/print` body is exactly `{ entity, docEntry, layout, engine }`.
- Produces (mock agent): `MockAgent.defaultLayouts: Record<string, string>` (key `"QUT2"` or `"QUT2|C1"`; unset → `` `${ReportCode}0001` ``), `MockAgent.pldLayouts: Set<string>`.

- [ ] **Step 0: Verify the report codes on the live B1** (spec §6; memory `live-b1-probe`, read-only). Send `GetDefaultReport` for `RDR1`, `DLN1` and `INV1` on tenant hera. Expected: each answers a `LayoutCode` starting with its own code. If one doesn't exist, record it in spec §6 and map that entity's service documents to `"2"` in `reportCode`.

- [ ] **Step 1: Extend the mock agent.** In `/create`, before the generic `Service_` branch: `ReportLayoutsService_GetDefaultReport` answers `{ ReportCode, LayoutCode, CardCode: CardCode ?? "-1" }` from `defaultLayouts` (the `"<code>|<CardCode>"` key first, then `"<code>"`, then `` `${code}0001` ``); `ReportLayoutsService_GetReportLayout` answers `{ LayoutCode, Category: pldLayouts.has(code) ? "rlcPLD" : "rlcCrystal" }`.

- [ ] **Step 2: Write the failing tests** in `apps/server/test/print.test.ts` (setup as `portal-docs.test.ts`: `makeTenant`, `connectTenant`, `makeUser("member")`, a fresh tenant per test; call `router.entities.print`). The store: `Quotations: [{ DocEntry: 1, CardCode: "C1", DocType: "dDocument_Items" }, { DocEntry: 2, CardCode: "C2", DocType: "dDocument_Items" }, { DocEntry: 3, CardCode: "C1", DocType: "dDocument_Service" }]`.

```ts
const printCalls = () => agent.calls.filter((c) => c.route === "/print").map((c) => c.body);
const defaultCalls = () => agent.calls.filter((c) => c.body.entitySet === "ReportLayoutsService_GetDefaultReport").map((c) => c.body.data);

test("prints with the document's default layout and the workspace's engine", async () => {
  agent.defaultLayouts.QUT2 = "QUT20009";
  expect((await call(router.entities.print, { entity: "Quotations", docEntry: 1 }, s.memberCtx)).fileName).toBe("Quotations-1.pdf");
  expect(printCalls().at(-1)).toEqual({ entity: "Quotations", docEntry: 1, layout: "QUT20009", engine: "gateway" });
  expect(defaultCalls().at(-1)).toEqual({ ReportParams: { ReportCode: "QUT2", CardCode: "C1" } });
});
test("a customer's own default wins", /* defaultLayouts["QUT2|C2"] = "QUT20011" → layout "QUT20011" for docEntry 2 */);
test("a service document prints with its service layout", /* docEntry 3 → ReportCode "QUT1", layout "QUT10001" */);
test("the layout is looked up once per 2 hours", /* print 1 twice → defaultCalls().length 1; setSystemTime(Date.now() + 2*3600_000 + 1) → print → 2; setSystemTime() after */);
test("a company switch looks the layout up again", /* print 1; agent.company.db = "OTHER"; await adoptCompany(tenantId, "OTHER"); print 1 → defaultCalls().length 2 */);
test("a default that is not Crystal is refused, naming it", /* pldLayouts.add("QUT20009") → code "PRECONDITION_FAILED", message contains "QUT20009"; printCalls() empty */);
test("the workspace's engine choice is sent", /* db.update(sapConnection).set({ printEngine: "crystal" }) → printCalls().at(-1).engine === "crystal" */);
```

- [ ] **Step 3: Run them to see them fail.** Run: `bun test apps/server/test/print.test.ts` — Expected: FAIL (no `layout`/`engine` in the body, no GetDefaultReport call).

- [ ] **Step 4: Add the column.** `printEngine: text("print_engine", { enum: ["gateway", "crystal"] }).notNull().default("gateway")` on `sapConnection`, with a doc comment ("the engine `/print` uses; Direct only once the agent reports it set up — `sap.setPrintEngine`"); export `PrintEngine`. Run `bun run db:push`, then `bun run db:generate`.

- [ ] **Step 5: Implement `printDocument`** in `print.ts`. Order: the `PRINTABLE` fence → `agentTarget` → a transport `new DirectTransport(agentRequester(target, "b1"))` → the document (`doc` when given, else `readEntity(entity, docEntry, { select: ["CardCode", "DocType"] })`) → the layout from `layouts: Map<string, { layout: string; until: number }>` under key `` `${tenantId}|${target.companyDb}|${code}|${cardCode}` ``, filled on a miss by `createEntity("ReportLayoutsService_GetDefaultReport", { ReportParams: { ReportCode, CardCode } })` then `createEntity("ReportLayoutsService_GetReportLayout", { ReportLayoutParams: { LayoutCode } })` → `PRECONDITION_FAILED` with `t("PRINT_NOT_CRYSTAL", layout)` unless `Category === "rlcCrystal"` (a refused layout is not cached) → the engine (one select of `sapConnection.printEngine`) → `agentPost(target, "/print", { entity, docEntry, layout, engine })`. All SAP calls inside `viaB1`. Rewrite the file's header comment to describe this flow, and mark the cache `// ponytail: per-process Map, never pruned — a few keys per customer; prune if a tenant ever has thousands of customers printing`.
  Texts: en `"The default print layout {0} is not a Crystal Reports layout. Make a Crystal layout the default in SAP Business One (Report and Layout Manager)."`; es `"El formato de impresión por defecto {0} no es de Crystal Reports. Defina un formato Crystal como predeterminado en SAP Business One (Gestor de informes y formatos)."`; eu `"{0} inprimatze-formatu lehenetsia ez da Crystal Reports-ena. Ezarri Crystal formatu bat lehenetsi gisa SAP Business One-n (Txosten- eta formatu-kudeatzailea)."`

- [ ] **Step 6: Portal passes its row.** `docs.print`: `const row = await ownDoc(b1, context, input.entity, input.docEntry, ["CardCode", "DocType"]); return printDocument(context.tenantId, input.entity, input.docEntry, row);`. In `portal-docs.test.ts` "one is cut to the schema; print renders after the check", assert the print made exactly one `/entity` read of Quotations 1 (count `agent.calls` with `route === "/entity" && body.key === 1` before and after the print call: +1).

- [ ] **Step 7: Run the tests.** Run: `bun test apps/server/test/print.test.ts apps/server/test/portal-docs.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit && bunx tsc -p packages/db/tsconfig.json --noEmit` — Expected: PASS, no type errors.

- [ ] **Step 8: Commit.** `git add packages/db apps/server/src/print.ts apps/server/src/portal/orpc/docs.ts apps/server/src/i18n apps/server/test/mock-agent.ts apps/server/test/print.test.ts apps/server/test/portal-docs.test.ts && git commit -m "print: B1's default layout, cached 2 h, and the workspace's engine"`

---

### Task 2: The engine switch on the server

**Files:**
- Modify: `apps/server/src/agent-pairing.ts` (`Health`, `agentStatus`)
- Modify: `apps/server/src/orpc/routers/sap.ts` (`setPrintEngine`)
- Modify: `apps/server/src/i18n/{en,es,eu}.ts` (`PRINT_DIRECT_NOT_SET_UP`)
- Modify: `apps/server/test/mock-agent.ts` (`health`)
- Modify: `apps/server/test/sap-connect.test.ts`

**Interfaces:**
- Consumes: `sapConnection.printEngine`, `PrintEngine` (Task 1).
- Produces: `export function printServices(p: unknown): { gateway: boolean; crystal: boolean }` (an array = old agent → `{ gateway: p.length > 0, crystal: false }`; an object → its two booleans; else both false).
- Produces: `agentStatus()` returns `services: { b1: boolean; beas: boolean; print: { gateway: boolean; crystal: boolean } } | null` and `printEngine: PrintEngine` (from the row; `"gateway"` when unpaired).
- Produces: `sap.setPrintEngine: adminProcedure.input(z.object({ engine: z.enum(["gateway", "crystal"]) }))` → `{ engine }`.
- Produces (mock agent): `MockAgent.health: { print: unknown }`, default `{ print: ["Quotations"] }` (the old agent shape), served in `/health`'s `services.print`.

- [ ] **Step 1: Write the failing tests** in `sap-connect.test.ts`: change the green expectation to `services: { b1: true, beas: false, print: { gateway: true, crystal: false } }, printEngine: "gateway"`; add:

```ts
test("Direct printing can be chosen only once the agent reports it set up", async () => {
  // admin of a tenant connected to the mock (old agent shape: print: ["Quotations"])
  expect(await codeOf(call(router.sap.setPrintEngine, { engine: "crystal" }, adminCtx))).toBe("PRECONDITION_FAILED");
  agent.health.print = { gateway: true, crystal: true };
  expect(await call(router.sap.setPrintEngine, { engine: "crystal" }, adminCtx)).toEqual({ engine: "crystal" });
  expect((await call(router.sap.agentStatus, undefined, adminCtx)).printEngine).toBe("crystal");
  agent.health.print = { gateway: false, crystal: false };
  expect(await call(router.sap.setPrintEngine, { engine: "gateway" }, adminCtx)).toEqual({ engine: "gateway" });
});
test("a member cannot switch the engine", /* member ctx → "FORBIDDEN" */);
```
  Reset `agent.health.print` to `["Quotations"]` in the test's end.

- [ ] **Step 2: Run them to see them fail.** Run: `bun test apps/server/test/sap-connect.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `printServices`, the `Health` type (`print: unknown` on the wire), `agentStatus`'s normalised `services` and `printEngine` (add `printEngine` to its row select), and `setPrintEngine` (for `"crystal"`: `agentStatus(tenantId)`; unless `connected && services.print.crystal` → `PRECONDITION_FAILED` with `t("PRINT_DIRECT_NOT_SET_UP")`; then update the row). Texts: en `"Direct printing is not set up on the SAP server. Run the agent's setup there (Direct printing) first."`; es `"La impresión directa no está configurada en el servidor SAP. Ejecute primero allí la configuración del agente (Impresión directa)."`; eu `"Zuzeneko inprimatzea ez dago SAP zerbitzarian konfiguratuta. Exekutatu lehenik agentearen konfigurazioa bertan (Zuzeneko inprimatzea)."`

- [ ] **Step 4: Run the tests.** Run: `bun test apps/server/test/sap-connect.test.ts apps/server/test/print.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit` — Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "sap: the print engine switch, and both agent health shapes"` (add the test files).

---

### Task 3: Settings → SAP agent shows and switches the engine

**Files:**
- Modify: `apps/app/src/routes/$slug/settings.tsx` (`AgentCard`)
- Modify: `apps/app/src/i18n/parts/admin.{en,es,eu}.properties`

**Interfaces:**
- Consumes: `orpc.sap.agentStatus` → `services.print: { gateway; crystal }`, `printEngine`; `orpc.sap.setPrintEngine` (Task 2).

- [ ] **Step 1: Implement.** The "Printing" `FormItem` shows the configured engines (`ADMIN_AGENT_PRINT_GATEWAY`, `ADMIN_AGENT_PRINT_DIRECT`, joined by ", "; `—` for none). A new `FormItem` `ADMIN_AGENT_PRINT_ENGINE` holds a UI5 `SegmentedButton` with two `SegmentedButtonItem`s (`data-engine="gateway"` / `"crystal"`, `selected` from `s.printEngine`). The Direct item is `disabled` unless `s.connected && s.services?.print.crystal`, and carries `tooltip={ADMIN_AGENT_PRINT_DIRECT_HINT}`. Selection change → `useMutation(orpc.sap.setPrintEngine.mutationOptions())`, then `status.refetch()`; a mutation error shows in the card's existing Negative `MessageStrip` pattern. Check `SegmentedButtonItem`'s `disabled`/`tooltip` with the ui5 MCP (`get_component_api`) before relying on them.
  Texts (en / es / eu):
  `ADMIN_AGENT_PRINT_ENGINE=Print with` / `Imprimir con` / `Inprimatu honekin`
  `ADMIN_AGENT_PRINT_GATEWAY=SAP API Gateway` (same in all three)
  `ADMIN_AGENT_PRINT_DIRECT=Direct (Crystal on the SAP server)` / `Directa (Crystal en el servidor SAP)` / `Zuzenean (Crystal SAP zerbitzarian)`
  `ADMIN_AGENT_PRINT_DIRECT_HINT=Set up direct printing in the agent's setup on the SAP server first.` / `Configure primero la impresión directa en la configuración del agente, en el servidor SAP.` / `Konfiguratu lehenik zuzeneko inprimatzea agentearen konfigurazioan, SAP zerbitzarian.`

- [ ] **Step 2: Verify.** Run: `bunx tsc -p apps/app/tsconfig.json --noEmit && bun --cwd apps/app build` — Expected: no errors. Then open Settings → SAP agent on a dev tenant connected to an agent (or the headless probe in memory `headless-browser-probe`) and see: Gateway selected, Direct disabled with its tooltip.

- [ ] **Step 3: Commit.** `git commit -am "settings: choose the print engine"`

---

### Task 4: The agent prints the layout it is given

**Files:**
- Modify: `apps/agent/config.go` (`Print` loses `Layouts`)
- Modify: `apps/agent/gateway.go` (`Export(layout, docEntry)`; `layouts`, `Printable` go)
- Modify: `apps/agent/server.go` (`/print` body and checks, `/health` shape, the wire comment)
- Modify: `apps/agent/wizard.go` (Printing step loses its layout questions and `printable`)
- Create: `apps/agent/print_test.go`

**Interfaces:**
- Produces: `var printPrefix = map[string]string{"Quotations": "QUT", "Orders": "RDR", "DeliveryNotes": "DLN", "Invoices": "INV"}` and `var objectType = map[string]int{"Quotations": 23, "Orders": 17, "DeliveryNotes": 15, "Invoices": 13}` in `server.go`.
- Produces: `func (g *Gateway) Export(layout string, docEntry int64) (pdf string, err error)`.
- Produces: `/print` input `{ entity, docEntry, layout, engine }`; reply `{ pdf, fileName: "<entity>-<docEntry>.pdf" }`. Checks in order: entity not in `printPrefix` → 400; `docEntry` not a positive integer → 400; `layout` not matching `^` + prefix + `[0-9]{1,8}$` → `refuse(…)` (403 `AGENT_REFUSED`); `engine` `""`/`"gateway"` → the Gateway (nil → 503 as today), `"crystal"` → 503 `"Direct printing is not set up on the SAP server's agent. Add it in the agent's setup."` (Task 6 fills it), anything else → 400.
- Produces: `/health` `services.print = {"gateway": bool, "crystal": bool}` (crystal false until Task 6).

- [ ] **Step 1: Write the failing tests** in `print_test.go`, using an `httptest` fake Gateway (`POST /login` → 200 + a `B1SESSION` cookie; `POST /rs/v1/ExportPDFData` → records `DocCode` and the body's `DocKey@` value, answers the JSON string `"JVBERi0="`), and `newAgent` with `cfg.Print.URL` = the fake, then requests through `a.routes()` with the Bearer and `X-Confire-Company`:

```go
func TestPrintChecksTheLayoutAgainstTheEntity(t *testing.T) // table: {Quotations,QUT20009}→200; {Orders,QUT20009}→403 AGENT_REFUSED; {Quotations,"QUT2000;x"}→403; {Quotations,""}→403; {Items,ITM0001}→400; docEntry 0 → 400
func TestPrintGatewayExportsTheGivenLayout(t *testing.T) // DocCode == "QUT20009", DocKey@ == "5", reply {pdf:"JVBERi0=", fileName:"Quotations-5.pdf"}
func TestPrintCrystalNotSetUp(t *testing.T)              // engine "crystal" → 503, message mentions the agent's setup
func TestHealthReportsEngines(t *testing.T)              // services.print == {"gateway":true,"crystal":false}
```

- [ ] **Step 2: Run them to see them fail.** Run: `cd apps/agent && go test ./... -run 'Print|Health'` — Expected: FAIL (compile errors on `Export`'s signature).

- [ ] **Step 3: Implement** the changes listed under Files/Interfaces. `newAgent` builds `&Gateway{s: newSession(...)}`. The wizard's `print()` asks URL, user and password only (its `maps` import goes if unused).

- [ ] **Step 4: Run the tests.** Run: `cd apps/agent && go vet ./... && GOOS=windows go vet ./... && go test ./...` — Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "agent: print the layout Confire resolved; no layouts in agent.json"` (add `print_test.go`).

---

### Task 5: `confire-print.exe` (after Task 0 passes)

**Files:**
- Create: `apps/agent/print/ConfirePrint.csproj`
- Create: `apps/agent/print/Program.cs`
- Modify: `apps/agent/package.json` (`build` runs the dotnet build first)
- Modify: `apps/server/Dockerfile` (a `print` stage; the agent stage copies its exe into `bin/`)
- Modify: `.gitignore` (`apps/agent/bin/confire-print.exe*`, `apps/agent/print/bin/`, `apps/agent/print/obj/`)

**Interfaces:**
- Produces: `confire-print.exe`, reading `CONFIRE_SQL_SERVER`, `CONFIRE_SQL_USER`, `CONFIRE_SQL_PASS`, `CONFIRE_COMPANY_DB` from its environment.
  - `confire-print.exe --check`: SQL login to the company database, `SELECT COUNT(*) FROM RDOC`, the Crystal engine assembly loaded; prints `ok Crystal <file version>` and exits 0, else prints the reason and exits 1.
  - No arguments: a loop, one JSON line in `{"layout":"QUT20009","docEntry":5,"objectId":23}`, one JSON line out `{"pdf":"<base64>"}` or `{"error":"<message>"}`; never exits on a bad request; stdout flushed per line; logs to stderr only.

- [ ] **Step 0: Prerequisite.** The dev box has no .NET SDK (`dotnet --list-sdks` is empty). Ask the user to install one (e.g. `mise use -g dotnet@9`, or the distro's `dotnet-sdk`) before going on.

- [ ] **Step 1: Write the project.** `ConfirePrint.csproj`: `Microsoft.NET.Sdk`, `OutputType` `Exe`, `TargetFramework` `net48`, `PlatformTarget` `x64`, `AssemblyName` `confire-print`, `LangVersion` `latest`, `Nullable` `disable`, `DebugType` `none`, PackageReference `Microsoft.NETFramework.ReferenceAssemblies` (latest 1.0.x, `PrivateAssets="all"`), References `Microsoft.CSharp` (for `dynamic`) and `System.Web.Extensions` (`JavaScriptSerializer`).

- [ ] **Step 2: Write `Program.cs`.** Crystal via `Assembly.LoadWithPartialName("CrystalDecisions.CrystalReports.Engine")` and `"CrystalDecisions.Shared"` (the spike's approach), `ReportDocument` created with `Activator.CreateInstance` and driven as `dynamic`; `ExportFormatType.PortableDocFormat` by `Enum.Parse` on the Shared assembly's type. Per request:
  1. Get the layout from `Dictionary<string, (dynamic Doc, DateTime Until)>`, valid for 2 h. On a miss or expiry, `Close()`/`Dispose()` the old one. Read `SELECT Template FROM RDOC WHERE DocCode = @c` (parameterised). Refuse unless the bytes start `D0 CF 11 E0`, with the error `"Layout {0} in RDOC is not a Crystal .rpt"`. Write the bytes to `%TEMP%\confire-print\{layout}.rpt`, then `Load` it.
  2. Apply the logon to every table of the report and of each `Subreports` item: `LogOnInfo.ConnectionInfo` `ServerName`/`DatabaseName`(= company DB)/`UserID`/`Password`, then `ApplyLogOnInfo`.
  3. Main-report parameters (`ReportName == ""`): `DocKey@` set as a string or a double by `ParameterValueKind.ToString() == "StringParameter"`; `ObjectId@` likewise when present.
  4. `ExportToStream(PortableDocFormat)` → base64.
  Each error replies `{error}`, with inner exceptions' messages joined by `": "`. Add `// ponytail: layouts held loaded per code, 2 h — Crystal's job limit (75) is far off at 4 document types`.

- [ ] **Step 3: Build it.** `package.json` `build`: prefix `dotnet build print -c Release -o bin &&`. Run: `bun --cwd apps/agent build && file apps/agent/bin/confire-print.exe` — Expected: `PE32+ executable … Mono/.Net assembly`, and the agent exe still passes its subsystem check.

- [ ] **Step 4: Dockerfile.** Before the agent stage: `FROM mcr.microsoft.com/dotnet/sdk:9.0 AS print`, `COPY apps/agent/print/ /src/`, `RUN dotnet build /src -c Release -o /out`. In the agent stage, after `COPY apps/agent/ .`: `COPY --from=print /out/confire-print.exe bin/`. Run: `docker build -f apps/server/Dockerfile --target agent .` if Docker is available. If it isn't (memory `docker-socket-denied`), say so and leave it to CI.

- [ ] **Step 5: On the box (the user).** Copy `confire-print.exe` to the client's server. Set the four variables, then run `confire-print.exe --check`, then pipe in one request line for a real quotation and decode the PDF. Expected: `ok Crystal 13.0.31…`, then a PDF that matches B1's print.

- [ ] **Step 6: Commit.** `git add apps/agent/print apps/agent/package.json apps/server/Dockerfile .gitignore && git commit -m "agent: confire-print.exe, Crystal through the box's runtime"`

---

### Task 6: The agent runs Direct printing (after Task 5)

**Files:**
- Modify: `apps/agent/config.go` (`Crystal` block)
- Create: `apps/agent/crystal.go`
- Create: `apps/agent/crystal_test.go`
- Modify: `apps/agent/server.go` (the `crystal` engine, health, logout, warm-up)
- Modify: `apps/agent/service_windows.go` (install writes `confire-print.exe`; `printExe()`)
- Modify: `apps/agent/service_other.go` (`printExe()` stub)
- Modify: `apps/agent/wizard.go` (Direct printing step, the modify menu, `changeCompany`)
- Modify: `CLAUDE.md` (the agent paragraph), `DEPLOY.md` (agents), `docs/superpowers/specs/2026-10-21-agent-autosetup-design.md` (Printing step)

**Interfaces:**
- Consumes: Task 4's `objectType`, the `/print` checks; Task 5's exe contract.
- Produces: `type Crystal struct { Server string \`json:"server"\`; User string \`json:"user"\`; Pass string \`json:"pass"\` }`, `Config.Crystal *Crystal \`json:"crystal,omitempty"\``.
- Produces in `crystal.go`:
  - `func crystalEnv(cfg *Config) []string`: `os.Environ()` plus the four `CONFIRE_*` variables.
  - `type crystalChild struct{ … }`, `func newCrystalChild(exe string, env []string, timeout time.Duration, lg *log.Logger) *crystalChild`.
  - `func (c *crystalChild) Render(layout string, docEntry int64, objectID int) (pdf string, err error)`: serialised by a mutex. It starts the child if none is running, writes one line and waits for one line. After `timeout` it kills the child and returns `&SAPError{Status: 504, Message: "Direct printing took longer than 60 s; the print service was restarted."}`. A dead child gives `502`. A `{error}` reply gives `&SAPError{Status: 400, Message: "Direct printing: " + msg}`.
  - `func (c *crystalChild) Warm()` starts the child if it isn't running. `func (c *crystalChild) Close()`.
  - `func checkCrystal(exe string, cfg *Config) error`: runs `exe --check` with `crystalEnv`; non-zero exit → its output as the error.
- Produces: `func printExe() (string, error)` (Windows: the installed copy beside the running exe, else the embedded `bin/confire-print.exe` written to `%TEMP%\confire-print-<version>.exe`; elsewhere: an error "direct printing runs on Windows only").

- [ ] **Step 1: Write the failing tests** in `crystal_test.go`. The fake child is the test binary itself: `TestMain` acts as the child when `CONFIRE_FAKE_PRINT=1` (test sets it with `t.Setenv`, so `crystalEnv` passes it on). It answers each layout as follows. `"QUT20009"`: `{pdf: base64("<layout>:<docEntry>:<objectId>")}`, but `{error}` if `CONFIRE_SQL_PASS` is missing from its environment or appears in its `os.Args`. `"QUT29999"`: `{error:"boom"}`. `"QUT28888"`: hangs. `"QUT27777"`: `os.Exit(3)`. `"QUT26666"`: sleeps 100 ms, then answers like QUT20009.

```go
func TestCrystalRenders(t *testing.T)                 // Render("QUT20009", 5, 23) → base64 of "QUT20009:5:23"
func TestCrystalPasswordOnlyInEnvironment(t *testing.T) // the same call succeeds with cfg.Crystal.Pass = "s3cret" (the fake refuses otherwise)
func TestCrystalErrorReply(t *testing.T)              // "QUT29999" → *SAPError Status 400, Message contains "boom"
func TestCrystalTimeoutRestarts(t *testing.T)         // timeout 200ms: "QUT28888" → Status 504; then "QUT20009" succeeds
func TestCrystalChildDeathRecovers(t *testing.T)      // "QUT27777" → error; then "QUT20009" succeeds
func TestCrystalOneAtATime(t *testing.T)              // two goroutines on "QUT26666" both succeed; elapsed ≥ 200ms
func TestPrintCrystalEngine(t *testing.T)             // an Agent whose crystal is the fake: POST /print engine "crystal" → {pdf, fileName:"Quotations-5.pdf"}; /health print.crystal == true
```

- [ ] **Step 2: Run them to see them fail.** Run: `cd apps/agent && go test ./... -run Crystal` — Expected: FAIL (undefined `newCrystalChild`).

- [ ] **Step 3: Implement `crystal.go`** with the interfaces above. The child's stderr goes to the agent's log. Mark it `// ponytail: one child, prints in series — a small pool if prints ever queue`.

- [ ] **Step 4: Wire it into the agent.** In `server.go`, `newAgent` builds `a.crystal` when `cfg.Crystal != nil`: exe = `confire-print.exe` beside `os.Executable()`, timeout `60 * time.Second`, and `go a.crystal.Warm()` in `serve`. Engine `"crystal"` → `a.crystal.Render(layout, docEntry, objectType[entity])`. Health `crystal: a.crystal != nil`; `logout` closes it. In `service_windows.go`, `install()` writes the bundled `bin/confire-print.exe` beside the agent when present, and `printExe()` follows the interface above.

- [ ] **Step 5: Add the wizard step.** After the Gateway question: `w.yes("Direct printing (Crystal, SQL Server) — configure?", false)` → `w.crystal(cfg)`. It asks SQL server (default: the B1 URL's host), user (default `sa`) and password (`w.password`), and tests with `w.test("SQL Server and Crystal ready", …)` running `checkCrystal(printExe(), &next)` until it passes. Also add a modify-menu entry "Change direct printing" (keep / remove / change, like "Change printing"), and in `changeCompany` re-test with `checkCrystal` and re-ask on failure.

- [ ] **Step 6: Run the tests.** Run: `cd apps/agent && go vet ./... && GOOS=windows go vet ./... && go test ./... && cd ../.. && bun --cwd apps/agent build` — Expected: PASS, and the exe builds.

- [ ] **Step 7: Update the docs.** `CLAUDE.md` agent paragraph: `/print` takes `{ entity, docEntry, layout, engine }`, `print.ts` resolves the layout through `GetDefaultReport` (2 h), `confire-print.exe` is the Direct engine (a child like `cloudflared`), and `sap_connection.print_engine` is the switch. `DEPLOY.md` agents: the Direct printing setup step and its prerequisite, the Crystal Reports runtime for .NET (64-bit) on the server. The autosetup spec: the Printing step has no layouts, plus the new step.

- [ ] **Step 8: On the box (the user).** Install the new agent on the client's server, run setup's Direct printing step, switch the workspace to Direct in Settings, then print from the Object Page, the List Report and the portal. Expected: the PDFs come from the client's default layouts, faster than the spike's first print.

- [ ] **Step 9: Commit.** `git add apps/agent CLAUDE.md DEPLOY.md docs/superpowers/specs/2026-10-21-agent-autosetup-design.md && git commit -m "agent: Direct printing through confire-print.exe"`

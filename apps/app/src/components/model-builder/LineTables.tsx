import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import {
  Bar, Button, Dialog, FlexBox, Form, FormGroup, FormItem, Input, Label, SegmentedButton, SegmentedButtonItem, Tag, Text,
} from "@ui5/webcomponents-react";
import {
  bomItemCodes, checkModel, OPERATION_VARS, routingOperationIds, type ModelDef, type ResolvedLookups,
} from "@confire/config-engine";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { Grid, GridForm, type GridState } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { useI18n } from "../../i18n.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import {
  asCode, FIGURES, missingFields, newBomLine, newOpLine, pickOperation, withCatalogFigures, type BomLine, type OpLine,
} from "./lines.ts";

// The Outputs section's BOM and routing (spec 2026-11-08): a table that only shows the lines, and
// one dialog that edits a line — picked from SAP Items or the Beas catalog, or chosen by a formula.
// A routing line linked to an operation reads its figures from the catalog by name (beasSetup…),
// live on every calculation, the way a BOM line reads its price.

type Kind = "bom" | "routing";
type Line = BomLine | OpLine;
type Update = (fn: (d: ModelDef) => ModelDef) => void;

/** A grid row's place in its list — what a selection and a click hand back. */
const AT = "#at";
const MONO: CSSProperties = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8125rem" };
const SUB: CSSProperties = { color: "var(--sapContent_LabelColor)", fontSize: "var(--sapFontSmallSize)" };
const W = { width: "100%" } as const;

/** The code an item/operation expression names, if it is one literal; else the expression. */
const codeCell = (expr: string | undefined) => {
  const code = asCode(expr ?? "");
  return code !== undefined ? { code } : { formula: expr ?? "" };
};

/** What this one line's item/operation expression can give, over the preview's domains. */
const codesOfLine = (kind: Kind, draft: ModelDef, line: Line, domains?: ResolvedLookups["domains"]): string[] =>
  kind === "bom"
    ? bomItemCodes({ ...draft, bom: [line as BomLine] }, domains)
    : routingOperationIds({ ...draft, routing: [line as OpLine] }, domains);

export function LineTables({ kind, draft, lookups, tables, update }: {
  kind: Kind;
  draft: ModelDef;
  lookups?: ResolvedLookups;
  tables: TableCols[];
  update: Update;
}): ReactElement {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const lines: Line[] = kind === "bom" ? draft.bom : draft.routing;
  // null = closed; `at` undefined = a new line, which exists only once its dialog says OK.
  const [editing, setEditing] = useState<{ at?: number; line: Line } | null>(null);

  const columns = useMemo<ListColumn[]>(() => [
    { key: "no", label: "#", width: 48, sortable: false },
    { key: "what", label: t(kind === "bom" ? "MODEL_ITEM" : "MODEL_OPERATION"), sortable: false },
    { key: "when", label: t("MODEL_CONDITION"), sortable: false },
    ...(kind === "bom"
      ? [{ key: "qty", label: t("MODEL_QTY_PER"), sortable: false }]
      : [
          { key: "setupMin", label: t("MODEL_SETUP"), sortable: false },
          { key: "runMinPerUnit", label: t("MODEL_RUN"), sortable: false },
          { key: "ratePerHour", label: t("MODEL_RATE"), sortable: false },
        ]),
  ], [i18n, kind]);
  const state = useMemo<GridState>(() => ({ columns: columns.map((c) => c.key), sortBy: [], groupBy: [] }), [columns]);
  const rows = lines.map((l, at): Row => ({ [AT]: at, ...l }));
  const open = (at: number) => setEditing({ at, line: structuredClone(lines[at]!) });

  const cellTemplates = {
    no: (r: Row) => <Text>{Number(r[AT]) + 1}</Text>,
    what: (r: Row) => {
      const at = Number(r[AT]);
      const l = lines[at]!;
      const expr = kind === "bom" ? (l as BomLine).itemCode : (l as OpLine).operationId;
      const c = codeCell(expr);
      const sub = kind === "bom" ? l.desc : [l.desc, (l as OpLine).resource].filter(Boolean).join(" · ");
      const n = c.formula ? codesOfLine(kind, draft, l, lookups?.domains).length : 0;
      return (
        // The messages popover focuses this to reach the line (builderMessages' anchor). Out of the
        // tab order, so only that jump focuses it — and opening the dialog on focus is safe.
        <FlexBox direction="Column" data-line={`${kind}:${at}`} tabIndex={-1} onFocus={() => open(at)} style={{ minWidth: 0 }}>
          {c.code !== undefined ? <Text style={{ fontWeight: "bold" }}>{c.code || "—"}</Text>
            : c.formula ? <Text style={MONO}>{c.formula}</Text>
            : <Text style={SUB}>—</Text>}
          {c.formula ? <Text style={SUB}>{t(kind === "bom" ? "MODEL_N_ITEMS" : "MODEL_N_OPS", String(n))}</Text>
            : sub ? <Text style={SUB}>{sub}</Text> : null}
        </FlexBox>
      );
    },
    when: (r: Row) => {
      const cond = lines[Number(r[AT])]!.condition;
      return cond?.trim() ? <Text style={MONO}>{cond}</Text> : <Tag design="Neutral" hideStateIcon>{t("MODEL_ALWAYS")}</Tag>;
    },
    ...Object.fromEntries((["qty", ...FIGURES] as const).map((k) => [
      k, (r: Row) => <Text style={MONO}>{String((lines[Number(r[AT])] as Record<string, unknown>)[k] ?? "")}</Text>,
    ])),
  };

  const setLines = (next: Line[]) => update((d) => (kind === "bom" ? { ...d, bom: next as BomLine[] } : { ...d, routing: next as OpLine[] }));

  return (
    <>
      <GridForm name={t(kind === "bom" ? "MODEL_BOM" : "MODEL_ROUTING")}>
        <Grid title={t(kind === "bom" ? "MODEL_BOM" : "MODEL_ROUTING")} columns={columns} state={state} rows={rows}
          fill={false} showSettings={false} selectionMode="Multiple" cellTemplates={cellTemplates}
          onRowClick={(row) => open(Number(row[AT]))}
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => setEditing({ line: kind === "bom" ? newBomLine() : newOpLine() })}>
                {t("MODEL_ADD_LINE")}
              </Button>
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={() => {
                  const gone = new Set(sel.rows.map((r) => Number(r[AT])));
                  // row ids are positions, so a kept selection would land on the rows that moved up
                  sel.clear();
                  setLines(lines.filter((_, i) => !gone.has(i)));
                }}>
                {t("MODEL_DELETE")}
              </Button>
            </>
          )} />
      </GridForm>
      {editing ? (
        <LineDialog kind={kind} draft={draft} lookups={lookups} tables={tables} at={editing.at} initial={editing.line}
          onCancel={() => setEditing(null)}
          onOk={(line) => {
            setLines(editing.at === undefined ? [...lines, line] : lines.map((l, i) => (i === editing.at ? line : l)));
            setEditing(null);
          }} />
      ) : null}
    </>
  );
}

/** One line, buffered: nothing reaches the model until OK. Checked as it will be once saved — the
 *  draft with this line in its place — so an OK that would break the model waits. */
function LineDialog({ kind, draft, lookups, tables, at, initial, onCancel, onOk }: {
  kind: Kind;
  draft: ModelDef;
  lookups?: ResolvedLookups;
  tables: TableCols[];
  at?: number;
  initial: Line;
  onCancel: () => void;
  onOk: (line: Line) => void;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const [line, setLine] = useState<Line>(initial);
  const i = at ?? (kind === "bom" ? draft.bom.length : draft.routing.length);
  const scope = useMemo<ModelDef>(() => (kind === "bom"
    ? { ...draft, bom: [...draft.bom.slice(0, i), line as BomLine, ...draft.bom.slice(i + 1)] }
    : { ...draft, routing: [...draft.routing.slice(0, i), line as OpLine, ...draft.routing.slice(i + 1)] }), [draft, line, kind, i]);
  const issues = useMemo(() => checkModel(scope, tables).filter((x) => x.path.startsWith(`${kind}[${i}].`)), [scope, tables, kind, i]);
  const missing = missingFields(kind, line);
  // An empty required box is not an error yet, as in FormulaDialog: OK waits for it either way.
  const issueOf = (key: string) => (missing.includes(key) ? undefined : issues.find((x) => x.path === `${kind}[${i}].${key}`));
  const ok = !issues.length && !missing.length;

  const exprKey = kind === "bom" ? "itemCode" : "operationId";
  const expr = (line as Record<string, string | undefined>)[exprKey] ?? "";
  const [mode, setMode] = useState<"pick" | "formula">(() => (!expr.trim() || asCode(expr) !== undefined ? "pick" : "formula"));
  const op = kind === "routing" ? (line as OpLine) : undefined;
  const opCode = op?.operationId === undefined ? undefined : asCode(op.operationId);
  const catalog = opCode === undefined ? undefined : lookups?.operations?.[opCode];
  const figureVars = useMemo(() => ["qty", ...(op?.operationId ? OPERATION_VARS : [])], [op?.operationId]);
  const qtyVars = useMemo(() => ["qty"], []);

  const setExpr = (v: string | undefined) => setLine((l) => (kind === "bom"
    ? { ...(l as BomLine), itemCode: v ?? "" }
    // A routing line linked by formula follows the catalog like a picked one; unlinked, it is manual.
    : v?.trim() ? withCatalogFigures({ ...(l as OpLine), operationId: v }) : { ...(l as OpLine), operationId: undefined }));
  const switchMode = (next: "pick" | "formula") => {
    // A formula has no single code to show in a picker: switching empties it (Cancel undoes).
    if (next === "pick" && asCode(expr) === undefined) setExpr(undefined);
    setMode(next);
  };
  const can = mode === "formula" && expr.trim() ? codesOfLine(kind, draft, line, lookups?.domains) : [];
  const hint = (f: (typeof FIGURES)[number]) => {
    if (opCode === undefined || !lookups) return null;
    if (!catalog) return <Text style={SUB}>{t("MODEL_NOT_IN_OPS")}</Text>;
    const v = f === "setupMin" ? catalog.setupMin : f === "runMinPerUnit" ? catalog.runMinPerUnit : catalog.ratePerHour;
    return <Text style={SUB}>{t("MODEL_FROM_BEAS", String(v))}</Text>;
  };
  const field = (label: string, required: boolean, control: ReactElement, below?: ReactElement | null) => (
    <FormItem labelContent={<Label showColon required={required}>{label}</Label>}>
      <FlexBox direction="Column" gap="0.25rem" style={W}>{control}{below}</FlexBox>
    </FormItem>
  );
  const exprField = (key: string, extraVars: string[], optional: boolean, placeholder?: string) => (
    <ExprInput value={(line as Record<string, string | undefined>)[key]} model={scope} tables={tables} extraVars={extraVars}
      optional={optional} placeholder={placeholder} issue={issueOf(key)}
      onChange={(v) => setLine((l) => ({ ...l, [key]: optional ? v : (v ?? "") }))} />
  );

  const header = at === undefined
    ? t(kind === "bom" ? "MODEL_NEW_MATERIAL" : "MODEL_NEW_OPERATION")
    : t(kind === "bom" ? "MODEL_LINE_MATERIAL" : "MODEL_LINE_OPERATION", String(at + 1));

  return (
    <Dialog open onClose={onCancel} className="confire-pd" headerText={header} style={{ width: "min(44rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!ok} onClick={() => onOk(line)}>{t("MODEL_OK")}</Button>
            <Button design="Transparent" onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }>
      {/* One column, as in FormulaDialog: an M-sized dialog would halve the formulas' width. */}
      <Form layout="S1 M1 L1 XL1" style={{ padding: "1rem" }}>
        <FormGroup accessibleName={header}>
          {field(t(kind === "bom" ? "MODEL_ITEM" : "MODEL_OPERATION"), kind === "bom", (
            <>
              <SegmentedButton itemsFitContent accessibleName={t(kind === "bom" ? "MODEL_ITEM" : "MODEL_OPERATION")}
                onSelectionChange={(e) => switchMode(e.detail.selectedItems[0]?.dataset.mode === "formula" ? "formula" : "pick")}>
                <SegmentedButtonItem data-mode="pick" selected={mode === "pick"}>{t("MODEL_PICK")}</SegmentedButtonItem>
                <SegmentedButtonItem data-mode="formula" selected={mode === "formula"}>{t("MODEL_FORMULA")}</SegmentedButtonItem>
              </SegmentedButton>
              {mode === "formula" ? (
                <ExprInput value={expr} model={scope} tables={tables} extraVars={qtyVars} rows={2} optional={kind === "routing"}
                  issue={issueOf(exprKey)} onChange={setExpr} />
              ) : kind === "bom" ? (
                <CflField config={{ dialogConfig: cfl.items() }} accessibleName={t("MODEL_ITEM")} value={asCode(expr) ?? null}
                  error={issueOf(exprKey)?.message}
                  onValueChange={(code) => setExpr(code === null || code === undefined || code === "" ? "" : JSON.stringify(String(code)))}
                  onRowSelect={(row) => { if (row.ItemName != null) setLine((l) => ({ ...l, desc: String(row.ItemName) })); }} />
              ) : (
                // Typed text stays even when Beas cannot be reached (mustExist off): a code typed
                // there is checked by the calculation, which flags one the cache lacks.
                <CflField config={{ dialogConfig: cfl.beasOperations() }} mustExist={false} accessibleName={t("MODEL_OPERATION")}
                  value={opCode ?? null}
                  onValueChange={(code) => setExpr(code === null || code === undefined || code === "" ? undefined : JSON.stringify(String(code).trim()))}
                  onRowSelect={(row) => setLine((l) => pickOperation(l as OpLine, row))} />
              )}
            </>
          ), can.length ? <Text style={SUB}>{t("MODEL_CAN_GIVE", can.join(", "))}</Text> : null)}
          {field(t("MODEL_DESC"), false, (
            <Input style={W} value={line.desc ?? ""} accessibleName={t("MODEL_DESC")}
              placeholder={t(kind === "bom" ? "MODEL_DESC_FROM_ITEM" : "MODEL_OP_DESC_PH")}
              onInput={(e) => { const desc = e.target.value; setLine((l) => ({ ...l, desc: desc || undefined })); }} />
          ))}
          {op ? field(t("MODEL_RESOURCE"), false, (
            <CflField config={{ dialogConfig: cfl.beasResources() }} mustExist={false} accessibleName={t("MODEL_RESOURCE")}
              value={op.resource || null}
              placeholder={t(op.operationId ? "MODEL_RESOURCE_FROM_OP" : "MODEL_RESOURCE_PH")}
              onValueChange={(v) => setLine((l) => ({ ...l, resource: v === null || v === undefined || v === "" ? undefined : String(v) }))} />
          )) : null}
          {field(t("MODEL_CONDITION"), false,
            exprField("condition", qtyVars, true, t(kind === "bom" ? "MODEL_COND_EMPTY" : "MODEL_OP_COND_EMPTY")))}
          {kind === "bom"
            ? field(t("MODEL_QTY_PER"), true, exprField("qty", qtyVars, false))
            : FIGURES.map((f) => (
                <FormItem key={f} labelContent={<Label showColon required>{t(f === "setupMin" ? "MODEL_SETUP" : f === "runMinPerUnit" ? "MODEL_RUN" : "MODEL_RATE")}</Label>}>
                  <FlexBox direction="Column" gap="0.25rem" style={W}>{exprField(f, figureVars, false)}{hint(f)}</FlexBox>
                </FormItem>
              ))}
        </FormGroup>
      </Form>
    </Dialog>
  );
}

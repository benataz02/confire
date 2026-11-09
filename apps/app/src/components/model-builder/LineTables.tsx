import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import {
  Bar, Button, Dialog, FlexBox, Form, FormGroup, FormItem, Input, Label, SegmentedButton, SegmentedButtonItem, Tag, Text,
} from "@ui5/webcomponents-react";
import {
  checkModel, OPERATION_VARS, type ModelDef,
} from "@confire/config-engine";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { Grid, GridForm, type GridState } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { useI18n } from "../../i18n.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import {
  asCode, asLiteral, FIGURES, missingFields, newBomLine, newOpLine, pickOperation, withCatalogFigures, withoutCatalogFigures, type BomLine, type OpLine,
} from "./lines.ts";
import { usePreviewLookups } from "./usePreviewLookups.ts";

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

/** The description under a line's code: a BOM line's is an expression, shown as its text when it
 *  is one literal and as the formula otherwise; a routing line's is plain text. */
const descCell = (kind: Kind, desc: string | undefined) => {
  if (!desc?.trim()) return null;
  const text = kind === "bom" ? asCode(desc) : desc;
  return <Text maxLines={1} style={text === undefined ? { ...SUB, ...MONO } : SUB}>{text ?? desc}</Text>;
};

export function LineTables({ kind, draft, tables, update }: {
  kind: Kind;
  draft: ModelDef;
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
          { key: "resource", label: t("MODEL_RESOURCE"), sortable: false },
          { key: "runMinPerUnit", label: t("MODEL_RUN"), sortable: false },
          { key: "ratePerHour", label: t("MODEL_RATE"), sortable: false },
        ]),
  ], [i18n, kind]);
  // Grid takes a column's declared width as its floor only; a fixed width is the view's, as a resize.
  const state = useMemo<GridState>(
    () => ({ columns: columns.map((c) => c.key), sortBy: [], groupBy: [], columnWidths: { no: 48 } }),
    [columns],
  );
  const rows = lines.map((l, at): Row => ({ [AT]: at, ...l }));
  const open = (at: number) => setEditing({ at, line: structuredClone(lines[at]!) });

  const cellTemplates = {
    no: (r: Row) => <Text>{Number(r[AT]) + 1}</Text>,
    what: (r: Row) => {
      const at = Number(r[AT]);
      const l = lines[at]!;
      const expr = kind === "bom" ? (l as BomLine).itemCode : (l as OpLine).operationId;
      const c = codeCell(expr);
      // Two lines in all, as Grid's CELL_TEXT: the code (or formula) and its description, one each.
      return (
        // The messages popover focuses this to reach the line (builderMessages' anchor). Out of the
        // tab order, so only that jump focuses it — and opening the dialog on focus is safe.
        <FlexBox direction="Column" data-line={`${kind}:${at}`} tabIndex={-1} onFocus={() => open(at)} style={{ minWidth: 0 }}>
          {c.code !== undefined ? <Text maxLines={1} style={{ fontWeight: "bold" }}>{c.code || "—"}</Text>
            : c.formula ? <Text maxLines={1} style={MONO}>{c.formula}</Text>
            : <Text style={SUB}>—</Text>}
          {descCell(kind, l.desc)}
        </FlexBox>
      );
    },
    when: (r: Row) => {
      const cond = lines[Number(r[AT])]!.condition;
      return cond?.trim() ? <Text maxLines={2} style={MONO}>{cond}</Text> : <Tag design="Neutral" hideStateIcon>{t("MODEL_ALWAYS")}</Tag>;
    },
    resource: (r: Row) => <Text maxLines={1}>{(lines[Number(r[AT])] as OpLine).resource ?? ""}</Text>,
    ...Object.fromEntries((["qty", ...FIGURES] as const).map((k) => [
      k, (r: Row) => <Text maxLines={2} style={MONO}>{String((lines[Number(r[AT])] as Record<string, unknown>)[k] ?? "")}</Text>,
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
        <LineDialog kind={kind} draft={draft} tables={tables} at={editing.at} initial={editing.line}
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
function LineDialog({ kind, draft, tables, at, initial, onCancel, onOk }: {
  kind: Kind;
  draft: ModelDef;
  tables: TableCols[];
  at?: number;
  initial: Line;
  onCancel: () => void;
  onOk: (line: Line) => void;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const [line, setLine] = useState<Line>(initial);
  const [height, setHeight] = useState<number>();
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
  // The catalog figures come from a resolve asked about this very line — the page's lookups were
  // resolved for the saved draft, which does not hold a fresh pick yet. Until that answer is in
  // (`isPlaceholderData` = the previous line's), no hint: "not in the source" would be a guess.
  const preview = usePreviewLookups(scope);
  const resolved = !!preview.data && !preview.isPlaceholderData;
  const catalog = opCode === undefined ? undefined : preview.data?.operations?.[opCode];
  const figureVars = useMemo(() => ["qty", ...(op?.operationId ? OPERATION_VARS : [])], [op?.operationId]);
  const qtyVars = useMemo(() => ["qty"], []);

  const setExpr = (v: string | undefined) => setLine((l) => (kind === "bom"
    ? { ...(l as BomLine), itemCode: v ?? "" }
    // A routing line linked by formula follows the catalog like a picked one; unlinked, it is manual.
    : v?.trim() ? withCatalogFigures({ ...(l as OpLine), operationId: v }) : withoutCatalogFigures({ ...(l as OpLine), operationId: undefined })));
  const switchMode = (next: "pick" | "formula") => {
    // A formula has no single code to show in a picker: switching empties it (Cancel undoes).
    if (next === "pick" && asCode(expr) === undefined) setExpr(undefined);
    setMode(next);
  };
  const hint = (f: (typeof FIGURES)[number]) => {
    if (opCode === undefined || !resolved) return null;
    if (!catalog) return <Text style={SUB}>{t("MODEL_NOT_IN_OPS")}</Text>;
    const v = f === "setupMin" ? catalog.setupMin : f === "runMinPerUnit" ? catalog.runMinPerUnit : catalog.ratePerHour;
    return <Text style={SUB}>{t("MODEL_FROM_BEAS", String(v))}</Text>;
  };
  const field = (label: string, required: boolean, control: ReactElement) => (
    <FormItem labelContent={<Label showColon required={required}>{label}</Label>}>
      <FlexBox direction="Column" gap="0.25rem" style={W}>{control}</FlexBox>
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
    // Sized by its content once, then held: Pick ↔ Formula and the hints would
    // otherwise resize it, and UI5 re-centres a dialog on every resize, so it jumped. More content
    // than the opening size scrolls inside.
    <Dialog open onClose={onCancel} className="confire-pd" headerText={header}
      onOpen={(e) => { const opened = e.target.offsetHeight; setHeight((h) => h ?? opened); }}
      style={{ width: "min(44rem, 96vw)", height }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!ok} onClick={() => onOk(line)}>{t("MODEL_OK")}</Button>
            <Button design="Transparent" onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }>
      {/* One column, as in FormulaDialog: an M-sized dialog would halve the formulas' width. Labels
          at 3/12, not UI5's 4: short labels right-aligned in a third left the formulas narrow
          beside empty space. Narrow (S) still puts them on top. */}
      <Form layout="S1 M1 L1 XL1" labelSpan="S12 M3 L3 XL3" style={{ padding: "1rem" }}>
        <FormGroup accessibleName={header}>
          {field(t(kind === "bom" ? "MODEL_ITEM" : "MODEL_OPERATION"), kind === "bom", (
            <>
              <SegmentedButton itemsFitContent accessibleName={t(kind === "bom" ? "MODEL_ITEM" : "MODEL_OPERATION")}
                onSelectionChange={(e) => switchMode(e.detail.selectedItems[0]?.dataset.mode === "formula" ? "formula" : "pick")}>
                <SegmentedButtonItem data-mode="pick" selected={mode === "pick"}>{t("MODEL_PICK")}</SegmentedButtonItem>
                <SegmentedButtonItem data-mode="formula" selected={mode === "formula"}>{t("MODEL_FORMULA")}</SegmentedButtonItem>
              </SegmentedButton>
              {mode === "formula" ? (
                <ExprInput value={expr} model={scope} tables={tables} extraVars={qtyVars} optional={kind === "routing"}
                  issue={issueOf(exprKey)} onChange={setExpr} />
              ) : kind === "bom" ? (
                <CflField config={{ dialogConfig: cfl.items() }} accessibleName={t("MODEL_ITEM")} value={asCode(expr) ?? null}
                  error={issueOf(exprKey)?.message}
                  onValueChange={(code) => setExpr(code === null || code === undefined || code === "" ? "" : asLiteral(String(code)))}
                  onRowSelect={(row) => { if (row.ItemName != null) setLine((l) => ({ ...l, desc: asLiteral(String(row.ItemName)) })); }} />
              ) : (
                // Typed text stays even when Beas cannot be reached (mustExist off): a code typed
                // there is checked by the calculation, which flags one the cache lacks.
                <CflField config={{ dialogConfig: cfl.beasOperations() }} mustExist={false} accessibleName={t("MODEL_OPERATION")}
                  value={opCode ?? null}
                  onValueChange={(code) => setExpr(code === null || code === undefined || code === "" ? undefined : asLiteral(String(code).trim()))}
                  onRowSelect={(row) => setLine((l) => pickOperation(l as OpLine, row))} />
              )}
            </>
          ))}
          {field(t("MODEL_DESC"), false, kind === "bom" ? exprField("desc", qtyVars, true, t("MODEL_DESC_FROM_ITEM")) : (
            <Input style={W} value={line.desc ?? ""} accessibleName={t("MODEL_DESC")}
              placeholder={t("MODEL_OP_DESC_PH")}
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

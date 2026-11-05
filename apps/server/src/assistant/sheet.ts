import { CFB, read, utils, type WorkBook } from "xlsx";
import { XMLParser } from "fast-xml-parser";

// Spreadsheets as the model reads them (a report rebuilt from an old Excel, a client's parts list):
// each sheet's first rows as CSV, then its formulas, which say how a figure is computed, and an xlsx's
// pivot tables by their definition (rows, columns, values, filters, source), which say how a report's
// table is built — its cells alone are only the last refresh's numbers. Claude's
// document block takes PDF and plain text only, and reading xlsx natively needs the code-execution
// sandbox, which the TanStack adapter cannot attach files to (no `container_upload` part) — so the
// text is made here, from the stored bytes, every time a thread is read (files.ts `filePart`).
// ponytail: first 200 rows and 200 formulas a sheet, ~100k characters in all — a report's layout and
// formulas are what a migration needs; the code-execution sandbox once the adapter can attach files,
// if a request hinges on rows past that or on Word files.

const ROWS = 200;
const FORMULAS = 200;
const MAX_CHARS = 100_000;

const zip = (b: Buffer) => b.length > 4 && b.readUInt32BE(0) === 0x504b0304;
const cfb = (b: Buffer) => b.length > 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1;
/** CSV has no magic bytes: told by its name and by being text (UTF-8, no NUL). */
const csvText = (b: Buffer, name: string) => {
  if (!/\.csv$/i.test(name) || b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
};

/** The workbook behind the bytes, or null: a zip or a compound file SheetJS opens as one (xlsx, xls,
 *  ods — a Word or PowerPoint file is not), or a CSV. */
function workbook(b: Buffer, name: string, sheetRows?: number): WorkBook | null {
  if (!zip(b) && !cfb(b) && !csvText(b, name)) return null;
  try {
    const wb = read(b, { type: "buffer", cellFormula: true, cellDates: true, dense: false, ...(sheetRows ? { sheetRows } : {}) });
    return wb.SheetNames.length ? wb : null;
  } catch {
    return null;
  }
}

/** Whether the bytes are a spreadsheet the assistant reads. */
export const isSheet = (b: Buffer, name: string): boolean => workbook(b, name, 1) !== null;

/** The spreadsheet as text for the model, or null when it is none. */
export function sheetText(name: string, b: Buffer): string | null {
  const wb = workbook(b, name, ROWS + 1);
  if (!wb) return null;
  const out: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]!;
    const csv = utils.sheet_to_csv(ws, { blankrows: false });
    const formulas = Object.entries(ws)
      .filter(([addr, c]) => !addr.startsWith("!") && (c as { f?: string }).f)
      .map(([addr, c]) => `${addr} = ${(c as { f: string }).f}`);
    out.push(
      `## Sheet ${sheetName}`,
      csv,
      ...(formulas.length ? ["Formulas:", ...formulas.slice(0, FORMULAS), ...(formulas.length > FORMULAS ? [`(${formulas.length - FORMULAS} more formulas not shown)`] : [])] : []),
      "",
    );
  }
  // The first rows only: SheetJS stops parsing at `sheetRows`, and the full range says what was cut.
  const cut = wb.SheetNames.some((s) => (wb.Sheets[s]!["!fullref"] as string | undefined) && utils.decode_range(wb.Sheets[s]!["!fullref"] as string).e.r >= ROWS);
  if (zip(b)) out.push(...pivotText(b));
  let text = out.join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n(truncated: the rest of the file is not shown)`;
  else if (cut) text += `\n(only the first ${ROWS} rows of each sheet are shown)`;
  return `<file name="${name.replaceAll('"', "'")}">\n${text}\n</file>`;
}

/** A process's converted texts, by file id: a thread's files are read again on every turn, and a
 *  stored file never changes. ponytail: one process's Map of the latest 50. */
const cache = new Map<string, string>();
export function cachedSheetText(id: string, name: string, b: Buffer): string | null {
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const text = sheetText(name, b);
  if (text === null) return null;
  cache.set(id, text);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return text;
}

// --- Pivot tables ---------------------------------------------------------------------------------
// SheetJS's free build reads no pivot definitions (their parts are "TODO" in its reader), so they are
// read here off the xlsx zip with SheetJS's own zip reader. ponytail: xlsx only (an .xls or .ods pivot
// shows as its cells); item filters and grouping not read — the fields and their aggregation are what a
// report rebuild needs.

const xml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true,
  isArray: (name) => ["field", "pageField", "dataField", "cacheField", "Relationship", "sheet"].includes(name),
});
type Rel = { Id: string; Target: string };
type Attrs = Record<string, string | undefined>;

/** Each pivot table as one block of text, or none. Never throws: a pivot it cannot read is left out. */
export function pivotText(b: Buffer): string[] {
  try {
    const zipped = CFB.read(b, { type: "buffer" });
    const file = (path: string) => {
      const e = CFB.find(zipped, `/${path}`);
      return e?.content ? xml.parse(Buffer.from(e.content as Uint8Array).toString("utf8")) : null;
    };
    const rels = (path: string): Rel[] => file(path)?.Relationships?.Relationship ?? [];
    // A target relative to the part that names it: "../pivotTables/pivotTable1.xml" from xl/worksheets/.
    const resolve = (from: string, target: string) => {
      const parts = [...from.split("/").slice(0, -1), ...target.split("/")];
      const out: string[] = [];
      for (const p of parts) p === ".." ? out.pop() : p && p !== "." && out.push(p);
      return out.join("/");
    };
    const wbRels = rels("xl/_rels/workbook.xml.rels");
    const sheets = (file("xl/workbook.xml")?.workbook?.sheets?.sheet ?? []) as Attrs[];
    const blocks: string[] = [];
    for (const sh of sheets) {
      const target = wbRels.find((r) => r.Id === sh.id)?.Target;
      if (!target) continue;
      const sheetPath = target.startsWith("/") ? target.slice(1) : resolve("xl/workbook.xml", target);
      const relPath = sheetPath.replace(/([^/]+)$/, "_rels/$1.rels");
      for (const r of rels(relPath).filter((x) => x.Target.includes("pivotTable"))) {
        const ptPath = resolve(sheetPath, r.Target);
        const pt = file(ptPath)?.pivotTableDefinition;
        if (!pt) continue;
        const cacheRel = rels(ptPath.replace(/([^/]+)$/, "_rels/$1.rels")).find((x) => x.Target.includes("pivotCacheDefinition"));
        const cache = cacheRel ? file(resolve(ptPath, cacheRel.Target))?.pivotCacheDefinition : null;
        const fields = (cache?.cacheFields?.cacheField ?? []) as Attrs[];
        const nameOf = (i: string | undefined) => (i === "-2" ? "(the values)" : fields[Number(i)]?.name ?? `field ${i}`);
        const list = (xs: Attrs[] | undefined, key = "x") => (xs ?? []).map((f) => nameOf(f[key])).join(", ") || "none";
        const src = cache?.cacheSource?.worksheetSource as Attrs | undefined;
        const source = src ? (src.name ?? `${src.sheet ? `${src.sheet}!` : ""}${src.ref ?? ""}`) : cache?.cacheSource?.type ?? "unknown";
        const values = ((pt.dataFields?.dataField ?? []) as Attrs[])
          .map((d) => `${d.name ?? nameOf(d.fld)} (${d.subtotal ?? "sum"} of ${nameOf(d.fld)}${d.showDataAs ? `, shown as ${d.showDataAs}` : ""})`).join("; ");
        const calculated = fields.filter((f) => f.formula).map((f) => `  calculated field ${f.name} = ${f.formula}`);
        blocks.push(
          `- "${pt.name ?? "PivotTable"}" on sheet ${sh.name} at ${pt.location?.ref ?? "?"}, from ${source}`,
          `  rows: ${list(pt.rowFields?.field)}; columns: ${list(pt.colFields?.field)}; filters: ${list(pt.pageFields?.pageField, "fld")}`,
          `  values: ${values || "none"}`,
          ...calculated,
        );
      }
    }
    return blocks.length ? ["## Pivot tables", ...blocks, ""] : [];
  } catch {
    return [];
  }
}

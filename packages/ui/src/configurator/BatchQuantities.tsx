import { MultiInput, Text, Token } from "@ui5/webcomponents-react";

/** Parse one typed quantity into the batch list: positive integers only, de-duped, ascending.
 *  A Number input still lets through "", "-3" and "2.5", so everything the guards reject here
 *  is reachable. */
export function addBatch(batches: number[], raw: string): number[] {
  const n = Number(raw.trim()); // "" and "  " both coerce to 0, which the n < 1 guard rejects
  if (!Number.isInteger(n) || n < 1 || batches.includes(n)) return batches;
  return [...batches, n].sort((a, b) => a - b);
}

/** The batch-quantity field both configuration pages draw (internal and portal). Type a quantity,
 *  Enter (or leaving the field) makes it a token. Uncontrolled: the typed text is cleared by hand
 *  once it has become a token. `anchor` is the message popover's data-param jump target. */
export function BatchQuantities({ batches, onChange, readOnly, anchor }: {
  batches: number[];
  onChange: (next: number[]) => void;
  readOnly?: boolean;
  anchor?: string;
}) {
  if (readOnly) return <Text>{batches.join(", ")}</Text>;
  return (
    <MultiInput type="Number" data-param={anchor} style={{ width: "100%" }}
      placeholder="Type a quantity, press Enter" accessibleName="Batch quantities"
      valueState={batches.length ? "None" : "Negative"}
      valueStateMessage={<div>Add at least one batch quantity.</div>}
      tokens={batches.map((b) => <Token key={b} text={String(b)} />)}
      onChange={(e) => {
        onChange(addBatch(batches, e.target.value ?? ""));
        e.target.value = "";
      }}
      onTokenDelete={(e) => {
        const gone = new Set(e.detail.tokens.map((t) => Number((t as HTMLElement).getAttribute("text"))));
        const left = batches.filter((b) => !gone.has(b));
        // Deleting the last quantity falls back to 1 rather than leaving nothing to price.
        onChange(left.length ? left : [1]);
      }} />
  );
}

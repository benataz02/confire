import { useEffect, useRef } from "react";
import { Input, type InputDomRef } from "@ui5/webcomponents-react";

/** The chat's title as a field: Enter or leaving it saves, Escape keeps the old one. */
export function RenameField({ value, label, onDone }: { value: string; label: string; onDone(v: string | null): void }) {
  const ref = useRef<InputDomRef>(null);
  const done = useRef(false);
  const finish = (v: string | null) => { if (!done.current) { done.current = true; onDone(v); } };
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Input ref={ref} value={value} maxlength={200} accessibleName={label} style={{ width: "20rem" }}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(ref.current?.value ?? value);
        if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      }}
      onBlur={() => finish(ref.current?.value ?? value)} />
  );
}

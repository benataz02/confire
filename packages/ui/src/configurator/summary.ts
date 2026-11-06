import type { FormState, ModelDef } from "@confire/config-engine";
import { formatLocale, formatValue } from "../format.ts";
import type { Option } from "../types.ts";

/** A configuration in one line's worth of parts (client-project-page spec, "Configuration line"):
 *  the batch quantities ("500 · 1,000"), then up to `max` "Label: value" of the visible fields that
 *  have one, in the model's parameter order, each as the form shows it (an option's label). */
export function configSummary(model: ModelDef, form: FormState, batches: number[], max = 3): string[] {
  const fields = model.parameters.flatMap((p) => {
    const f = form.fields[p.key];
    if (!f?.visible || f.value === undefined || f.value === "" || (Array.isArray(f.value) && !f.value.length)) return [];
    const options = f.options as Option[] | undefined;
    const value = Array.isArray(f.value)
      ? f.value.map((v) => formatValue(v, p.type, options)).join(", ")
      : formatValue(f.value, p.type, options);
    return value ? [`${p.label}: ${value}`] : [];
  });
  return [
    ...(batches.length ? [batches.map((n) => n.toLocaleString(formatLocale())).join(" · ")] : []),
    ...fields.slice(0, max),
  ];
}

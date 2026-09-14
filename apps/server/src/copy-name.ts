/** First free "<base> (copy)" / "<base> (copy 2)" … Only config_masterdata has a unique name index,
 *  but all three duplicate paths use this so the lists don't fill with identical names. */
export function copyName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let name = `${base} (copy)`;
  for (let n = 2; used.has(name); n++) name = `${base} (copy ${n})`;
  return name;
}

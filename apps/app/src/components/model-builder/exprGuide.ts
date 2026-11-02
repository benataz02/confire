// The expression guide beside every formula field. Names in scope stay in the suggestions;
// this is what those suggestions never say: what each function and operator does.
// `meaning` is an i18n key. Signatures and examples are the language itself.

export type FuncGuide = { name: string; sig: string; meaning: string; example: string };

/** Teaching order. The test checks this is exactly `FUNCS`, whatever the order. */
export const FUNC_GUIDE: FuncGuide[] = [
  { name: "IF", sig: "IF(condition, then, else)", meaning: "MODEL_FN_IF", example: 'IF(width > 1000, "large", "small")' },
  { name: "MIN", sig: "MIN(a, b, ...)", meaning: "MODEL_FN_MIN", example: "MIN(width, height)" },
  { name: "MAX", sig: "MAX(a, b, ...)", meaning: "MODEL_FN_MAX", example: "MAX(width, 100)" },
  { name: "ROUND", sig: "ROUND(n, digits)", meaning: "MODEL_FN_ROUND", example: "ROUND(area, 2)" },
  { name: "CEIL", sig: "CEIL(n)", meaning: "MODEL_FN_CEIL", example: "CEIL(qty)" },
  { name: "FLOOR", sig: "FLOOR(n)", meaning: "MODEL_FN_FLOOR", example: "FLOOR(qty)" },
  { name: "ABS", sig: "ABS(n)", meaning: "MODEL_FN_ABS", example: "ABS(width - height)" },
  { name: "CONCAT", sig: "CONCAT(a, b, ...)", meaning: "MODEL_FN_CONCAT", example: 'CONCAT(width, " x ", height)' },
  { name: "ISBLANK", sig: "ISBLANK(name)", meaning: "MODEL_FN_ISBLANK", example: "ISBLANK(colour)" },
  { name: "SELECTED", sig: "SELECTED(name)", meaning: "MODEL_FN_SELECTED", example: "SELECTED(colour)" },
  { name: "HAS", sig: "HAS(list, value)", meaning: "MODEL_FN_HAS", example: 'HAS(finish, "gloss")' },
  { name: "LOOKUP", sig: "LOOKUP(table, keyColumn, key, valueColumn)", meaning: "MODEL_FN_LOOKUP", example: 'LOOKUP("prices", "code", material, "price")' },
];

export const OP_GUIDE: { symbols: string; meaning: string }[] = [
  { symbols: "+   -   *   /   %", meaning: "MODEL_OP_ARITH" },
  { symbols: "==   !=   <   <=   >   >=", meaning: "MODEL_OP_CMP" },
  { symbols: "&&   ||   !", meaning: "MODEL_OP_LOGIC" },
  { symbols: "condition ? then : else", meaning: "MODEL_OP_TERN" },
];

/** Every bundle key the guide reads, so a missing translation fails the test. */
export const EXPR_GUIDE_KEYS = [
  "MODEL_EXPR_GUIDE", "MODEL_EXPR_GUIDE_LEAD", "MODEL_EXPR_GUIDE_FUNCS", "MODEL_EXPR_GUIDE_OPS",
  ...FUNC_GUIDE.map((f) => f.meaning),
  ...OP_GUIDE.map((o) => o.meaning),
];

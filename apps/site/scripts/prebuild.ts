import { mkdir, copyFile } from "node:fs/promises";

// The site's theme, from SAP's own files (spec 2026-10-30 §5): Horizon's ~1,500 variables pruned to
// the ones the site's CSS uses, emitted for Morning, Evening (by media) and the `.evening` scope; the
// 72 fonts copied to public/; the icons' SVG paths. The variables used are the brand contract: a
// future brand.css overrides exactly that list. The build fails on a raw colour or an unknown name.

/** The mockup's sprite, plus what pages have needed since. */
export const ICONS = [
  "ai", "arrow-right", "attachment", "connected", "decision", "document-text", "email", "globe", "it-host",
  "list", "locked", "menu2", "navigation-down-arrow", "product", "sales-quote", "share-2", "shield", "sys-enter-2",
] as const;

const FONTS = ["72-Regular", "72-Bold", "72-Black", "72-Light"];

/** The CSS of an .astro file: its <style> blocks, and each style="…" attribute as a block. */
export const cssOf = (astro: string): string =>
  [...astro.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n") + "\n" +
  [...astro.matchAll(/\sstyle="([^"]*)"/g)].map((m) => `x{${m[1]}}`).join("\n");

export const usedSapVars = (css: string): string[] =>
  [...new Set([...css.matchAll(/var\(\s*--(sap[\w-]+)/g)].map((m) => m[1]!))].sort();

/** Every `--sap*: value;` of a theme's css_variables.css: one declaration per line. */
export const themeVars = (themeCss: string): Map<string, string> =>
  new Map([...themeCss.matchAll(/^\s*--(sap[\w-]+):\s*(.*?);\s*$/gm)].map((m) => [m[1]!, m[2]!]));

export function sapCss(names: string[], morning: Map<string, string>, evening: Map<string, string>): string {
  const unknown = names.filter((n) => !morning.has(n) || !evening.has(n));
  if (unknown.length) throw new Error(`Unknown SAP variables: ${unknown.join(", ")}`);
  const block = (theme: Map<string, string>) => `{${names.map((n) => `--${n}:${theme.get(n)}`).join(";")}}`;
  return `:root${block(morning)}\n@media (prefers-color-scheme: dark){:root${block(evening)}}\n.evening${block(evening)}\n`;
}

const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
  "burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod " +
  "darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
  "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
  "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
  "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
  "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
  "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid " +
  "mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
  "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen " +
  "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown " +
  "royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow " +
  "springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "));

/**
 * Each raw colour in the declarations of `css` (`prop: value` snippets). Only declaration values are
 * read — the innermost `{…}` blocks — so a selector (`#faq`, `.spark.blue`) is never a colour, and
 * url()s, strings and variable names are dropped first (`72-Black.woff2`, `--sapRedColor`).
 * `black`/`white` in a mask is alpha, not colour (spec §5.2).
 */
export function rawColours(css: string): string[] {
  const out: string[] = [];
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);
  for (const decl of blocks.flatMap((b) => b.split(";"))) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl.slice(i + 1).replace(/url\([^)]*\)|"[^"]*"|'[^']*'|--[\w-]+/g, "");
    const mask = prop === "mask-image" || prop === "-webkit-mask-image";
    const named = [...value.matchAll(/(?<![\w-])([a-z]+)(?![\w-])/gi)].map((m) => m[1]!.toLowerCase())
      .filter((w) => NAMED.has(w) && !(mask && (w === "black" || w === "white")));
    if (/#[0-9a-f]{3,8}\b/i.test(value) || /(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(value) || named.length) {
      out.push(decl.trim());
    }
  }
  return out;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const gen = `${root}src/generated/`;
  const offences: string[] = [];
  let css = "";
  for await (const file of new Bun.Glob("src/**/*.{css,astro}").scan({ cwd: root })) {
    if (file.startsWith("src/generated/")) continue;
    const text = await Bun.file(root + file).text();
    const own = file.endsWith(".astro") ? cssOf(text) : text;
    for (const c of rawColours(own)) offences.push(`${file}: raw colour in "${c}" — use a SAP variable or a color-mix() of them`);
    css += own + "\n";
  }
  const theme = async (id: string) => themeVars(await Bun.file(
    Bun.resolveSync(`@sap-theming/theming-base-content/content/Base/baseLib/${id}/css_variables.css`, root)).text());
  const names = usedSapVars(css);
  let sap = "";
  try {
    sap = sapCss(names, await theme("sap_horizon"), await theme("sap_horizon_dark"));
  } catch (e) {
    offences.push((e as Error).message);
  }
  if (offences.length) {
    console.error(`prebuild: ${offences.length} problem(s)\n${offences.join("\n")}`);
    process.exit(1);
  }

  await mkdir(`${root}public/fonts`, { recursive: true });
  await mkdir(gen, { recursive: true });
  const fonts = Bun.resolveSync("@sap-theming/theming-base-content/content/Base/baseLib/baseTheme/fonts/72-Regular.woff2", root)
    .replace(/72-Regular\.woff2$/, "");
  for (const f of FONTS) await copyFile(`${fonts}${f}.woff2`, `${root}public/fonts/${f}.woff2`);
  const paths = await Promise.all(ICONS.map(async (n) =>
    `  ${JSON.stringify(n)}: ${JSON.stringify((await import(`@ui5/webcomponents-icons/dist/v5/${n}.js`)).pathData)},`));
  await Bun.write(`${gen}icons.ts`,
    `// Generated by scripts/prebuild.ts from @ui5/webcomponents-icons (v5, 16×16). Do not edit.\n` +
    `export const ICON_PATHS = {\n${paths.join("\n")}\n} as const;\nexport type IconName = keyof typeof ICON_PATHS;\n`);
  await Bun.write(`${gen}sap.css`, `/* Generated by scripts/prebuild.ts from sap_horizon / sap_horizon_dark. Do not edit. */\n${sap}`);
  await Bun.write(`${gen}brand-contract.txt`, names.map((n) => `--${n}`).join("\n") + "\n");
  console.log(`prebuild: ${names.length} SAP variables, ${ICONS.length} icons, ${FONTS.length} fonts`);
}

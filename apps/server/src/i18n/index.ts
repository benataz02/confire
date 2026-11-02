import { AsyncLocalStorage } from "node:async_hooks";
import { ORPCError } from "@orpc/server";
import { en } from "./en.ts";
import { es } from "./es.ts";
import { eu } from "./eu.ts";

// What the server says to a person — a refusal, a validation problem, a notice in the view — is in
// the language the SPA shows (its oRPC link sends it as Accept-Language), the same three the SPAs'
// bundles have. English is the base each language is laid over, so a text nobody has translated yet
// reads in English. SAP's own messages stay in SAP's language, and a model's rule messages in the
// words its author wrote. Mail has its own rule (mail/layout.tsx `mailLang`): a mail has no request.

export type Lang = "en" | "es" | "eu";
export type TextKey = keyof typeof en;
const TEXTS: Record<Lang, Partial<Record<TextKey, string>>> = { en, es, eu };

const current = new AsyncLocalStorage<Lang>();

/** The most preferred language of an Accept-Language header that we have texts in; else English. */
export function langOf(header: string | null | undefined): Lang {
  const tags = (header ?? "").split(",").map((part) => {
    const [tag = "", ...rest] = part.trim().split(";");
    const q = rest.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { lang: tag.trim().toLowerCase().split("-")[0], q: q ? Number(q.slice(2)) : 1 };
  });
  const best = tags.filter((t) => t.q > 0).sort((a, b) => b.q - a.q).find((t) => t.lang! in TEXTS);
  return (best?.lang as Lang | undefined) ?? "en";
}

/** Runs `fn` — a request, in serve.ts — with every `t()` beneath it in `lang`. */
export const withLang = <T>(lang: Lang, fn: () => T): T => current.run(lang, fn);

/** The current request's language; English outside one (tests, scripts, the sync). */
export const lang = (): Lang => current.getStore() ?? "en";

/** A text in the request's language, `{0}`, `{1}` filled from `params` — the SPAs' getText. */
export function t(key: TextKey, ...params: (string | number)[]): string {
  const text = TEXTS[lang()][key] ?? en[key];
  return text.replace(/\{(\d+)\}/g, (m, i: string) => String(params[Number(i)] ?? m));
}

// oRPC's own English: the message a bare `new ORPCError("NOT_FOUND")` gets ("Not Found", its code
// title-cased) and the input validation's.
const CODE_TEXT: Partial<Record<string, TextKey>> = {
  BAD_REQUEST: "CODE_BAD_REQUEST", UNAUTHORIZED: "CODE_UNAUTHORIZED", FORBIDDEN: "CODE_FORBIDDEN",
  NOT_FOUND: "CODE_NOT_FOUND", CONFLICT: "CODE_CONFLICT", PAYLOAD_TOO_LARGE: "CODE_PAYLOAD_TOO_LARGE",
  TOO_MANY_REQUESTS: "CODE_TOO_MANY_REQUESTS", INTERNAL_SERVER_ERROR: "CODE_INTERNAL_SERVER_ERROR",
  BAD_GATEWAY: "CODE_BAD_GATEWAY", SERVICE_UNAVAILABLE: "CODE_SERVICE_UNAVAILABLE", GATEWAY_TIMEOUT: "CODE_GATEWAY_TIMEOUT",
};
const titleCase = (code: string) => code.split("_").map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");

/** An error on its way out of a handler, its oRPC default message said in the request's language.
 *  A crash (no ORPCError) becomes the INTERNAL_SERVER_ERROR oRPC would make of it, worded here. */
export function localizeError(e: unknown): unknown {
  if (!(e instanceof ORPCError)) return new ORPCError("INTERNAL_SERVER_ERROR", { message: t("CODE_INTERNAL_SERVER_ERROR"), cause: e });
  const key = e.message === "Input validation failed" ? "CODE_INPUT_INVALID"
    : e.message === titleCase(e.code) ? CODE_TEXT[e.code] : undefined;
  if (key) e.message = t(key);
  return e;
}

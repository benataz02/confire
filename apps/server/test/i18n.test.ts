import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { langOf, localizeError, t, withLang } from "../src/i18n/index.ts";

test("the language is the best one Accept-Language names that we have, else English", () => {
  expect(langOf("es-ES,es;q=0.9,en;q=0.8")).toBe("es");
  expect(langOf("fr-FR,eu;q=0.5,es;q=0.7")).toBe("es");
  expect(langOf("eu")).toBe("eu");
  expect(langOf("fr")).toBe("en");
  expect(langOf(undefined)).toBe("en");
});

test("a text is the request's language, English outside a request", async () => {
  expect(t("CODE_NOT_FOUND")).toBe("Not found");
  expect(await withLang("es", async () => t("CODE_NOT_FOUND"))).not.toBe("Not found");
});

test("a bare code and a validation failure get a sentence; a written message and its data stand", () => {
  withLang("en", () => {
    expect((localizeError(new ORPCError("NOT_FOUND")) as ORPCError<string, unknown>).message).toBe("Not found");
    const own = new ORPCError("CONFLICT", { message: "Quoted and locked", data: { reason: "x" } });
    expect(localizeError(own)).toBe(own);
    expect(own.message).toBe("Quoted and locked");
    const crash = localizeError(new Error("boom")) as ORPCError<string, unknown>;
    expect([crash.code, crash.message.includes("boom")]).toEqual(["INTERNAL_SERVER_ERROR", false]);
  });
});

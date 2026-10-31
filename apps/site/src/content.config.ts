import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// Long-form pages are Markdown per language (spec 2026-10-30 §8): `legal/<lang>/<page>.md`, the same
// file name in each language. A page missing in one language is simply not offered in it.
const legal = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/legal" }),
  schema: z.object({ title: z.string(), description: z.string() }),
});

export const collections = { legal };

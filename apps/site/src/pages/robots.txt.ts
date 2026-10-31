import type { APIRoute } from "astro";

// Everyone is welcome, the AI crawlers by name (spec §12): for a marketing site, being found,
// quoted and learned about is the point. A named group replaces `*` for that bot, so each allows all.
const BOTS = [
  "Googlebot", "Bingbot", "OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot",
  "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended",
];

export const GET: APIRoute = ({ site }) =>
  new Response(
    ["User-agent: *", "Allow: /", "", ...BOTS.flatMap((b) => [`User-agent: ${b}`, "Allow: /", ""]), `Sitemap: ${new URL("/sitemap-index.xml", site)}`, ""].join("\n"),
    { headers: { "content-type": "text/plain; charset=utf-8" } },
  );

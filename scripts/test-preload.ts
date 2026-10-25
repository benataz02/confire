// Loaded before every `bun test` file (bunfig.toml): Bun has read .env by now, the mailer and
// cloudflare.ts have not. Tests never send mail, and never create a real tunnel or DNS name: a dev
// .env that can pair a real agent (CF_API_TOKEN) would otherwise do both from every pairing test.
// Nor do they call a model: the assistant's tests answer through a fake adapter (useTestAdapter).
delete process.env.RESEND_API_KEY;
delete process.env.CF_API_TOKEN;
delete process.env.ANTHROPIC_API_KEY;

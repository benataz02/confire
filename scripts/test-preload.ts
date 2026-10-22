// Loaded before every `bun test` file (bunfig.toml): Bun has read .env by now, the mailer has not.
delete process.env.RESEND_API_KEY;

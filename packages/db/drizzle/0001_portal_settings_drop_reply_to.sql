-- Every mail is a no-reply notification and client mail goes from <slug>@mail.<domain>: the
-- portal_settings document's `replyTo` and the removed sender-domain feature's `senderDomain` are
-- read by nothing any more. Data only; the column keeps its jsonb shape.
UPDATE "portal_settings" SET "settings" = "settings" - 'replyTo' - 'senderDomain'
WHERE "settings" ?| array['replyTo', 'senderDomain'];

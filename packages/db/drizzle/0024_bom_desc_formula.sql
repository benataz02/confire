-- A BOM line's description is an expression now, like its item code: each stored text becomes the
-- string literal that evaluates to it (the DSL escapes \ and " with a backslash), and an empty one
-- is dropped — an empty expression would not parse. Not bumping updated_at: every line evaluates to
-- the text it held, so no figure moved and stored calculations stay fresh.
UPDATE "config_model" SET "definition" = jsonb_set("definition", '{bom}', (
  SELECT coalesce(jsonb_agg(
    CASE
      WHEN jsonb_typeof(l->'desc') <> 'string' THEN l
      WHEN btrim(l->>'desc') = '' THEN l - 'desc'
      ELSE jsonb_set(l, '{desc}', to_jsonb('"' || replace(replace(l->>'desc', '\', '\\'), '"', '\"') || '"'))
    END ORDER BY i), '[]'::jsonb)
  FROM jsonb_array_elements("definition"->'bom') WITH ORDINALITY AS x(l, i)))
WHERE "definition" @? '$.bom[*].desc';

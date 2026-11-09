-- BOM lines and routing operations have no id any more: a line is its place in the list, which is
-- what the builder's grid shows and what a calculation error names. Strips the key from every model
-- and from every stored calculation's outputs. Not bumping updated_at: no figure moved, so stored
-- calculations stay fresh.
UPDATE "config_model" SET "definition" = jsonb_set("definition", '{bom}', (
  SELECT coalesce(jsonb_agg(l - 'id' ORDER BY i), '[]'::jsonb)
  FROM jsonb_array_elements("definition"->'bom') WITH ORDINALITY AS x(l, i)))
WHERE "definition" @? '$.bom[*].id';
--> statement-breakpoint
UPDATE "config_model" SET "definition" = jsonb_set("definition", '{routing}', (
  SELECT coalesce(jsonb_agg(o - 'id' ORDER BY i), '[]'::jsonb)
  FROM jsonb_array_elements("definition"->'routing') WITH ORDINALITY AS x(o, i)))
WHERE "definition" @? '$.routing[*].id';
--> statement-breakpoint
UPDATE "config_project" SET "candidates" = (
  SELECT coalesce(jsonb_agg(
    jsonb_set(c, '{perBatch}', (
      SELECT coalesce(jsonb_agg(
        jsonb_set(jsonb_set(b,
          '{outputs,bom}', (SELECT coalesce(jsonb_agg(l - 'id' ORDER BY li), '[]'::jsonb)
            FROM jsonb_array_elements(b->'outputs'->'bom') WITH ORDINALITY AS z(l, li))),
          '{outputs,ops}', (SELECT coalesce(jsonb_agg(o - 'id' ORDER BY oi), '[]'::jsonb)
            FROM jsonb_array_elements(b->'outputs'->'ops') WITH ORDINALITY AS w(o, oi)))
        ORDER BY bi), '[]'::jsonb)
      FROM jsonb_array_elements(c->'perBatch') WITH ORDINALITY AS y(b, bi)))
    ORDER BY ci), '[]'::jsonb)
  FROM jsonb_array_elements("candidates") WITH ORDINALITY AS x(c, ci))
WHERE "candidates" @? '$[*].perBatch[*].outputs.bom[*].id' OR "candidates" @? '$[*].perBatch[*].outputs.ops[*].id';

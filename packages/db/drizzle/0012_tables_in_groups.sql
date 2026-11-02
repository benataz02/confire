-- A table is a field like a parameter now: a group lists table keys beside parameter keys, and the
-- `{ "table": key }` group is gone. Each one becomes a group holding just that table, which draws
-- exactly as before (a full-width, untitled FormGroup). Not bumping updated_at: the layout moved,
-- no figure did, so stored calculations stay fresh.
-- The group takes the table's key, or `<key>_group` where a group of that section already has it
-- (group keys are per section: `section/group` is the visibility id).
UPDATE "config_model" SET "definition" = jsonb_set("definition", '{structure,sections}', (
  SELECT coalesce(jsonb_agg(
    jsonb_set(s, '{groups}', (
      SELECT coalesce(jsonb_agg(
        CASE WHEN g ? 'table'
          THEN jsonb_build_object('key', CASE WHEN EXISTS (
              SELECT 1 FROM jsonb_array_elements(s->'groups') o WHERE o->>'key' = g->>'table'
            ) THEN (g->>'table') || '_group' ELSE g->>'table' END, 'title', '', 'params', jsonb_build_array(g->'table'))
          ELSE g END
        ORDER BY gi), '[]'::jsonb)
      FROM jsonb_array_elements(s->'groups') WITH ORDINALITY AS x(g, gi)))
    ORDER BY si), '[]'::jsonb)
  FROM jsonb_array_elements("definition"->'structure'->'sections') WITH ORDINALITY AS y(s, si)))
WHERE "definition" @? '$.structure.sections[*].groups[*].table';

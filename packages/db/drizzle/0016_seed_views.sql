-- Every workspace made before the seeding hook (auth.ts' afterCreateOrganization) gets the lists'
-- shared All / Open / Mine views (ui-views.ts' SEEDED_VIEWS — the same rows), authored by its
-- first owner. A name already shared on a table is left alone, and a table's default (Open on the
-- documents, All elsewhere) is set only where the table has no shared default yet.
INSERT INTO "ui_view" ("tenant_id", "user_id", "table_id", "name", "visibility", "is_default", "state")
SELECT o."id", m."user_id", v.table_id, v.name, 'shared',
  v.is_default AND NOT EXISTS (
    SELECT 1 FROM "ui_view" d WHERE d."tenant_id" = o."id" AND d."table_id" = v.table_id
      AND d."visibility" = 'shared' AND d."is_default"),
  v.state
FROM "organization" o
JOIN LATERAL (
  SELECT "user_id" FROM "member" WHERE "organization_id" = o."id" AND "role" = 'owner'
  ORDER BY "created_at" LIMIT 1
) m ON true
CROSS JOIN (VALUES
  ('b1:Quotations', 'Open', true, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"DocumentStatus":["bost_Open"]},"searchTerm":""}'::jsonb),
  ('b1:Quotations', 'All', false, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('b1:Quotations', 'Assigned to me', false, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"DocumentStatus":["bost_Open"],"mine":["yes"]},"searchTerm":""}'::jsonb),
  ('b1:Orders', 'Open', true, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"DocumentStatus":["bost_Open"]},"searchTerm":""}'::jsonb),
  ('b1:Orders', 'All', false, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('b1:Orders', 'Assigned to me', false, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"DocumentStatus":["bost_Open"],"mine":["yes"]},"searchTerm":""}'::jsonb),
  ('b1:DeliveryNotes', 'Open', true, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"DocumentStatus":["bost_Open"]},"searchTerm":""}'::jsonb),
  ('b1:DeliveryNotes', 'All', false, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('b1:DeliveryNotes', 'Assigned to me', false, '{"columns":[],"knownColumns":[],"sortBy":[{"field":"DocEntry","direction":"desc"}],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"DocumentStatus":["bost_Open"],"mine":["yes"]},"searchTerm":""}'::jsonb),
  ('b1:BusinessPartners', 'All', true, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('b1:BusinessPartners', 'Active', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"Frozen":["tNO"]},"searchTerm":""}'::jsonb),
  ('b1:BusinessPartners', 'Assigned to me', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"Frozen":["tNO"],"mine":["yes"]},"searchTerm":""}'::jsonb),
  ('b1:Items', 'All', true, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('b1:Items', 'Active', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"Frozen":["tNO"]},"searchTerm":""}'::jsonb),
  ('configs', 'All', true, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('configs', 'Open', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"status":["draft"]},"searchTerm":""}'::jsonb),
  ('configs', 'Created by me', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"status":["draft"],"mine":["yes"]},"searchTerm":""}'::jsonb),
  ('requests', 'All', true, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{},"searchTerm":""}'::jsonb),
  ('requests', 'Open', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"status":["submitted","in_review","returned"]},"searchTerm":""}'::jsonb),
  ('requests', 'Assigned to me', false, '{"columns":[],"knownColumns":[],"sortBy":[],"groupBy":[],"adaptFilterKeys":[],"filterValues":{"status":["submitted","in_review","returned"],"mine":["yes"]},"searchTerm":""}'::jsonb)
) AS v(table_id, name, is_default, state)
WHERE NOT EXISTS (
  SELECT 1 FROM "ui_view" u WHERE u."tenant_id" = o."id" AND u."table_id" = v.table_id
    AND u."visibility" = 'shared' AND lower(u."name") = lower(v.name));

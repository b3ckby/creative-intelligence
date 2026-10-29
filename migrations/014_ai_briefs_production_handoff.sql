BEGIN;

ALTER TABLE creative_briefs
  ADD COLUMN details jsonb;

ALTER TABLE creative_briefs
  ADD CONSTRAINT creative_briefs_details_object
  CHECK (details IS NULL OR jsonb_typeof(details) = 'object');

ALTER TABLE creative_brief_versions
  ADD COLUMN details jsonb;

ALTER TABLE creative_brief_versions
  ADD CONSTRAINT creative_brief_versions_details_object
  CHECK (details IS NULL OR jsonb_typeof(details) = 'object');

COMMIT;

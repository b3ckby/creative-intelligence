BEGIN;

ALTER TABLE creative_briefs
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT creative_briefs_tenant_identity UNIQUE (organization_id, id);

CREATE TABLE creative_brief_versions (
  organization_id text NOT NULL,
  brief_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  product_id text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived')),
  source_ad_id text,
  hook text NOT NULL CHECK (length(hook) <= 20000),
  call_to_action text CHECK (call_to_action IS NULL OR length(call_to_action) BETWEEN 1 AND 100),
  dimensions jsonb NOT NULL CHECK (jsonb_typeof(dimensions) = 'object'),
  brief_created_at timestamptz NOT NULL,
  changed_by text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 256),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, brief_id, version),
  FOREIGN KEY (organization_id, brief_id)
    REFERENCES creative_briefs(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products(organization_id, id) ON DELETE CASCADE
);

INSERT INTO creative_brief_versions (
  organization_id, brief_id, version, product_id, title, status, source_ad_id,
  hook, call_to_action, dimensions, brief_created_at, changed_by, changed_at
)
SELECT organization_id, id, version, product_id, title, status, source_ad_id,
       hook, call_to_action, dimensions, created_at, 'system:migration', created_at
FROM creative_briefs;

CREATE INDEX creative_brief_versions_history_lookup
  ON creative_brief_versions (organization_id, brief_id, version DESC);

GRANT SELECT, INSERT ON creative_brief_versions TO creative_intelligence_runtime;

ALTER TABLE creative_brief_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_brief_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_brief_versions_tenant ON creative_brief_versions TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

COMMIT;

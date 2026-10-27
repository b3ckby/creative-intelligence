BEGIN;

CREATE TABLE creative_ad_analyses (
  organization_id text NOT NULL,
  product_id text NOT NULL,
  competitor_ad_id text NOT NULL,
  analysis_version text NOT NULL CHECK (length(analysis_version) BETWEEN 1 AND 128),
  model_provider text NOT NULL CHECK (length(model_provider) BETWEEN 1 AND 64),
  model_name text NOT NULL CHECK (length(model_name) BETWEEN 1 AND 200),
  prompt_version text NOT NULL CHECK (length(prompt_version) BETWEEN 1 AND 128),
  input_fingerprint text NOT NULL CHECK (length(input_fingerprint) = 64),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  claim_token text CHECK (claim_token IS NULL OR claim_token ~ '^[a-f0-9]{64}$'),
  claim_expires_at timestamptz,
  tags jsonb,
  analyzed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, competitor_ad_id, analysis_version, input_fingerprint),
  FOREIGN KEY (organization_id, product_id, competitor_ad_id)
    REFERENCES competitor_ads(organization_id, product_id, id) ON DELETE CASCADE,
  CHECK (
    (status = 'pending' AND tags IS NULL AND analyzed_at IS NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR
    (status = 'completed' AND jsonb_typeof(tags) = 'object' AND analyzed_at IS NOT NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
    OR
    (status = 'failed' AND tags IS NULL AND analyzed_at IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL)
  )
);

CREATE INDEX creative_ad_analyses_product_lookup
  ON creative_ad_analyses (organization_id, product_id, analyzed_at DESC, competitor_ad_id);

CREATE TABLE creative_analysis_daily_usage (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  usage_count integer NOT NULL CHECK (usage_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, usage_date)
);

CREATE TABLE competitor_analytics_snapshots (
  organization_id text NOT NULL,
  product_id text NOT NULL,
  competitor_id text NOT NULL,
  snapshot_date date NOT NULL,
  active_ad_count integer NOT NULL CHECK (active_ad_count >= 0),
  new_ads_last_7d integer NOT NULL CHECK (new_ads_last_7d >= 0),
  new_ads_prev_7d integer NOT NULL CHECK (new_ads_prev_7d >= 0),
  launch_velocity_delta integer NOT NULL,
  avg_days_active numeric NOT NULL CHECK (avg_days_active >= 0),
  long_runner_count integer NOT NULL CHECK (long_runner_count >= 0),
  image_count integer NOT NULL CHECK (image_count >= 0),
  video_count integer NOT NULL CHECK (video_count >= 0),
  carousel_count integer NOT NULL CHECK (carousel_count >= 0),
  text_count integer NOT NULL CHECK (text_count >= 0),
  impression_weight numeric CHECK (impression_weight IS NULL OR impression_weight >= 0),
  scale_score integer NOT NULL CHECK (scale_score BETWEEN 0 AND 100),
  newly_tracked boolean NOT NULL,
  captured_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, competitor_id, snapshot_date),
  FOREIGN KEY (organization_id, product_id, competitor_id)
    REFERENCES competitors(organization_id, product_id, id) ON DELETE CASCADE
);

CREATE INDEX competitor_analytics_snapshots_product_lookup
  ON competitor_analytics_snapshots (organization_id, product_id, snapshot_date DESC, competitor_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON creative_ad_analyses, creative_analysis_daily_usage, competitor_analytics_snapshots TO creative_intelligence_runtime;

ALTER TABLE creative_ad_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_ad_analyses FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_ad_analyses_tenant ON creative_ad_analyses TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

ALTER TABLE creative_analysis_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_analysis_daily_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_analysis_daily_usage_tenant ON creative_analysis_daily_usage TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

ALTER TABLE competitor_analytics_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_analytics_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY competitor_analytics_snapshots_tenant ON competitor_analytics_snapshots TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

COMMIT;

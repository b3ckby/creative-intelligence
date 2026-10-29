BEGIN;

CREATE FUNCTION protect_completed_creative_analysis() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed creative analysis is immutable' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER protect_completed_creative_analysis
BEFORE UPDATE OR DELETE ON creative_ad_analyses
FOR EACH ROW EXECUTE FUNCTION protect_completed_creative_analysis();

CREATE TABLE creative_analysis_reviews (
  organization_id text NOT NULL,
  product_id text NOT NULL,
  competitor_ad_id text NOT NULL,
  analysis_version text NOT NULL CHECK (length(analysis_version) BETWEEN 1 AND 128),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  review_version integer NOT NULL CHECK (review_version >= 1),
  decision text NOT NULL CHECK (decision IN ('approved','rejected','corrected')),
  corrections jsonb,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000 AND reason = btrim(reason)),
  reviewer_user_id text NOT NULL CHECK (length(reviewer_user_id) BETWEEN 1 AND 256),
  reviewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (organization_id, competitor_ad_id, analysis_version, input_fingerprint, review_version),
  FOREIGN KEY (organization_id, product_id, competitor_ad_id)
    REFERENCES competitor_ads(organization_id, product_id, id),
  FOREIGN KEY (organization_id, competitor_ad_id, analysis_version, input_fingerprint)
    REFERENCES creative_ad_analyses(organization_id, competitor_ad_id, analysis_version, input_fingerprint),
  CHECK (
    (decision = 'corrected'
      AND jsonb_typeof(corrections) = 'object'
      AND jsonb_array_length(jsonb_path_query_array(corrections, '$.keyvalue()')) BETWEEN 1 AND 5
      AND corrections - ARRAY['hookCategory','angle','format','offerFrame','funnelStage'] = '{}'::jsonb
      AND (NOT corrections ? 'hookCategory' OR corrections->>'hookCategory' IN ('pain_point','results','pattern_interrupt','pov_hook','listicle_hook','curiosity','data','social_proof'))
      AND (NOT corrections ? 'angle' OR corrections->>'angle' IN ('emotional','rational','identity','urgency','authority'))
      AND (NOT corrections ? 'format' OR corrections->>'format' IN ('ugc','asmr','podcast','pov','review','teaser','stream','tutorial','documentary','news_story','meme','action','drama','cartoon'))
      AND (NOT corrections ? 'offerFrame' OR corrections->>'offerFrame' IN ('discount','demo','free_tool','bundle','guarantee','social_proof','none'))
      AND (NOT corrections ? 'funnelStage' OR corrections->>'funnelStage' IN ('awareness','consideration','conversion','retention')))
    OR (decision IN ('approved','rejected') AND corrections IS NULL)
  )
);

CREATE INDEX creative_analysis_reviews_latest
  ON creative_analysis_reviews (organization_id, competitor_ad_id, analysis_version, input_fingerprint, review_version DESC);
CREATE INDEX creative_analysis_reviews_reviewer
  ON creative_analysis_reviews (organization_id, reviewer_user_id, reviewed_at DESC);

ALTER TABLE creative_analysis_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_analysis_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_analysis_reviews_select ON creative_analysis_reviews
  FOR SELECT TO creative_intelligence_runtime
  USING (app_is_member(organization_id));
CREATE POLICY creative_analysis_reviews_insert ON creative_analysis_reviews
  FOR INSERT TO creative_intelligence_runtime
  WITH CHECK (app_is_member(organization_id) AND reviewer_user_id = app_verified_user_id());

GRANT SELECT, INSERT ON creative_analysis_reviews TO creative_intelligence_runtime;

COMMIT;

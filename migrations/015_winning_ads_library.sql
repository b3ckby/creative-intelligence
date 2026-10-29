BEGIN;

CREATE TABLE winning_ads (
  id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_ad_id text NOT NULL CHECK (length(source_ad_id) BETWEEN 1 AND 256 AND source_ad_id !~ '[[:cntrl:]]'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND title = btrim(title) AND title !~ '[[:cntrl:]]'),
  category text NOT NULL CHECK (category IN ('classic','modern','minimal','bold','lifestyle','product')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 2000 AND notes !~ '[[:cntrl:]]'),
  source_provider text NOT NULL CHECK (source_provider ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_platform text NOT NULL CHECK (source_platform IN ('meta')),
  source_external_id text NOT NULL CHECK (length(source_external_id) BETWEEN 1 AND 256 AND source_external_id !~ '[[:cntrl:]]'),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  advertiser_name text NOT NULL CHECK (length(advertiser_name) BETWEEN 1 AND 500),
  source_is_active boolean NOT NULL,
  body text NOT NULL CHECK (length(body) <= 20000),
  headline text CHECK (headline IS NULL OR length(headline) BETWEEN 1 AND 500),
  description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 2000),
  call_to_action text CHECK (call_to_action IS NULL OR length(call_to_action) BETWEEN 1 AND 100),
  analysis_tags jsonb CHECK (analysis_tags IS NULL OR jsonb_typeof(analysis_tags)='object'),
  analysis_provenance text CHECK (analysis_provenance IS NULL OR analysis_provenance IN ('manual','automatic')),
  analysis_version text CHECK (analysis_version IS NULL OR length(analysis_version) BETWEEN 1 AND 128),
  analysis_analyzed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at timestamptz,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,source_ad_id),
  CHECK ((analysis_tags IS NULL) = (analysis_provenance IS NULL)),
  CHECK ((analysis_tags IS NULL) = (analysis_version IS NULL)),
  CHECK ((analysis_tags IS NULL) = (analysis_analyzed_at IS NULL))
);

CREATE TABLE winning_ad_media (
  organization_id text NOT NULL,
  winning_ad_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  media_kind text NOT NULL CHECK (media_kind IN ('image','video','unknown')),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm')),
  checksum text NOT NULL REFERENCES creative_media_blobs(checksum) ON DELETE RESTRICT,
  PRIMARY KEY (organization_id,winning_ad_id,position),
  FOREIGN KEY (organization_id,winning_ad_id) REFERENCES winning_ads(organization_id,id) ON DELETE CASCADE
);

CREATE INDEX winning_ads_tenant_page ON winning_ads(organization_id,archived_at,created_at,id);
CREATE INDEX winning_ads_tenant_category_page ON winning_ads(organization_id,category,archived_at,created_at,id);
CREATE INDEX winning_ads_tenant_active_page ON winning_ads(organization_id,source_is_active,archived_at,created_at,id);
CREATE INDEX winning_ads_tenant_search ON winning_ads USING gin(to_tsvector('simple',title||' '||advertiser_name||' '||body||' '||coalesce(headline,'')||' '||notes));
CREATE INDEX winning_ad_media_blob ON winning_ad_media(checksum);

ALTER TABLE winning_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE winning_ads FORCE ROW LEVEL SECURITY;
ALTER TABLE winning_ad_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE winning_ad_media FORCE ROW LEVEL SECURITY;
CREATE POLICY winning_ads_member ON winning_ads FOR ALL TO creative_intelligence_runtime
  USING (app_is_member(organization_id)) WITH CHECK (app_is_member(organization_id));
CREATE POLICY winning_ad_media_member ON winning_ad_media FOR ALL TO creative_intelligence_runtime
  USING (app_is_member(organization_id)) WITH CHECK (app_is_member(organization_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON winning_ads,winning_ad_media TO creative_intelligence_runtime;
GRANT SELECT ON creative_media_blobs TO creative_intelligence_runtime;

COMMIT;

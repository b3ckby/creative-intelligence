BEGIN;

CREATE TABLE competitor_ad_bookmarks (
  organization_id text NOT NULL,
  user_id text NOT NULL,
  competitor_ad_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (organization_id, user_id, competitor_ad_id),
  FOREIGN KEY (organization_id, user_id)
    REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, competitor_ad_id)
    REFERENCES competitor_ads(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX competitor_ad_bookmarks_ad_lookup
  ON competitor_ad_bookmarks (organization_id, competitor_ad_id, user_id);

CREATE INDEX competitor_ads_discovery_search
  ON competitor_ads USING gin (
    to_tsvector('simple', coalesce(advertiser_name, '') || ' ' || coalesce(headline, '') || ' ' || coalesce(description, '') || ' ' || coalesce(body, '') || ' ' || coalesce(call_to_action, ''))
  );

CREATE INDEX competitor_ads_discovery_first_seen
  ON competitor_ads (organization_id, first_seen_at DESC, id DESC);

CREATE INDEX competitor_ads_discovery_last_seen
  ON competitor_ads (organization_id, last_seen_at DESC, id DESC);

CREATE INDEX competitor_ads_discovery_impressions
  ON competitor_ads (organization_id, impressions_upper_bound DESC NULLS LAST, id DESC);

GRANT SELECT, INSERT, DELETE ON competitor_ad_bookmarks TO creative_intelligence_runtime;

ALTER TABLE competitor_ad_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ad_bookmarks FORCE ROW LEVEL SECURITY;
CREATE POLICY competitor_ad_bookmarks_private ON competitor_ad_bookmarks TO creative_intelligence_runtime
  USING (app_is_member(organization_id) AND user_id = app_verified_user_id())
  WITH CHECK (app_is_member(organization_id) AND user_id = app_verified_user_id());

COMMIT;

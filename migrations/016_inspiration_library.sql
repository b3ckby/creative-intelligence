BEGIN;

CREATE TABLE inspiration_boards (
  id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200 AND name=btrim(name) AND name !~ '[[:cntrl:]]'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000 AND description !~ '[[:cntrl:]]'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at timestamptz,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  UNIQUE (organization_id,name)
);

CREATE TABLE inspiration_items (
  id text NOT NULL,
  organization_id text NOT NULL,
  board_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('competitor_ad','winning_ad')),
  source_ref_id text NOT NULL CHECK (length(source_ref_id) BETWEEN 1 AND 256 AND source_ref_id !~ '[[:cntrl:]]'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300 AND title=btrim(title) AND title !~ '[[:cntrl:]]'),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000 AND notes !~ '[[:cntrl:]]'),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 20),
  source_provider text NOT NULL CHECK (source_provider ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_platform text NOT NULL CHECK (source_platform='meta'),
  source_external_id text NOT NULL CHECK (length(source_external_id) BETWEEN 1 AND 256),
  source_url text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  advertiser_name text NOT NULL CHECK (length(advertiser_name) BETWEEN 1 AND 500),
  body text NOT NULL CHECK (length(body) <= 20000),
  headline text CHECK (headline IS NULL OR length(headline) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at timestamptz,
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,id),
  FOREIGN KEY (organization_id,board_id) REFERENCES inspiration_boards(organization_id,id) ON DELETE CASCADE,
  UNIQUE (organization_id,board_id,source_kind,source_ref_id),
  CHECK (array_position(tags,'') IS NULL),
  CHECK (length(array_to_string(tags,'')) <= 1200),
  CHECK (array_to_string(tags,'') !~ '[[:cntrl:]]')
);

CREATE TABLE inspiration_item_media (
  organization_id text NOT NULL,
  inspiration_item_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  media_kind text NOT NULL CHECK (media_kind IN ('image','video','unknown')),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm')),
  checksum text NOT NULL REFERENCES creative_media_blobs(checksum) ON DELETE RESTRICT,
  PRIMARY KEY (organization_id,inspiration_item_id,position),
  FOREIGN KEY (organization_id,inspiration_item_id) REFERENCES inspiration_items(organization_id,id) ON DELETE CASCADE
);

CREATE INDEX inspiration_boards_tenant_page ON inspiration_boards(organization_id,archived_at,created_at,id);
CREATE INDEX inspiration_items_tenant_page ON inspiration_items(organization_id,board_id,archived_at,created_at,id);
CREATE INDEX inspiration_items_tenant_source ON inspiration_items(organization_id,source_kind,source_ref_id);
CREATE INDEX inspiration_items_tenant_tags ON inspiration_items USING gin(tags);
CREATE INDEX inspiration_items_tenant_search ON inspiration_items USING gin(to_tsvector('simple',title||' '||advertiser_name||' '||body||' '||coalesce(headline,'')||' '||notes));
CREATE INDEX inspiration_item_media_blob ON inspiration_item_media(checksum);

ALTER TABLE inspiration_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspiration_boards FORCE ROW LEVEL SECURITY;
ALTER TABLE inspiration_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspiration_items FORCE ROW LEVEL SECURITY;
ALTER TABLE inspiration_item_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspiration_item_media FORCE ROW LEVEL SECURITY;
CREATE POLICY inspiration_boards_member ON inspiration_boards FOR ALL TO creative_intelligence_runtime USING (app_is_member(organization_id)) WITH CHECK (app_is_member(organization_id));
CREATE POLICY inspiration_items_member ON inspiration_items FOR ALL TO creative_intelligence_runtime USING (app_is_member(organization_id)) WITH CHECK (app_is_member(organization_id));
CREATE POLICY inspiration_item_media_member ON inspiration_item_media FOR ALL TO creative_intelligence_runtime USING (app_is_member(organization_id)) WITH CHECK (app_is_member(organization_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON inspiration_boards,inspiration_items,inspiration_item_media TO creative_intelligence_runtime;
GRANT SELECT ON creative_media_blobs TO creative_intelligence_runtime;

COMMIT;

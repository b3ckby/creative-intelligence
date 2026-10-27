BEGIN;

CREATE TABLE organizations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE products (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  markets jsonb NOT NULL DEFAULT '[]'::jsonb,
  platforms jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_audiences jsonb NOT NULL DEFAULT '[]'::jsonb,
  unique_selling_points jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE competitors (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 300),
  meta_page_url text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, product_id, id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products(organization_id, id) ON DELETE CASCADE
);

CREATE TABLE competitor_ads (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  ingestion_token text NOT NULL CHECK (length(ingestion_token) BETWEEN 1 AND 128),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  competitor_id text NOT NULL,
  provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 1 AND 64),
  platform text NOT NULL CHECK (platform IN ('meta')),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  advertiser_name text NOT NULL,
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 20000),
  call_to_action text,
  started_at timestamptz NOT NULL,
  is_active boolean NOT NULL,
  media_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_url text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (organization_id, provider_name, platform, external_id),
  UNIQUE (organization_id, product_id, id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id, competitor_id)
    REFERENCES competitors(organization_id, product_id, id) ON DELETE CASCADE
);

CREATE TABLE creative_briefs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
  status text NOT NULL CHECK (status IN ('draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived')),
  source_ad_id text,
  hook text NOT NULL DEFAULT '',
  call_to_action text,
  dimensions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES products(organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, product_id, source_ad_id)
    REFERENCES competitor_ads(organization_id, product_id, id)
);

CREATE INDEX creative_briefs_iteration_lookup
  ON creative_briefs (organization_id, product_id, created_at, id)
  WHERE status <> 'archived';

COMMIT;

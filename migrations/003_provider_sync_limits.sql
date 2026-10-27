BEGIN;

CREATE TABLE provider_sync_limits (
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_name text NOT NULL CHECK (length(provider_name) BETWEEN 1 AND 64),
  claim_token text NOT NULL CHECK (length(claim_token) BETWEEN 1 AND 128),
  last_started_at timestamptz NOT NULL,
  PRIMARY KEY (organization_id, provider_name)
);

COMMIT;

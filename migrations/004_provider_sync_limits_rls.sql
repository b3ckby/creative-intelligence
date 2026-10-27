BEGIN;

REVOKE ALL ON provider_sync_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON provider_sync_limits TO creative_intelligence_runtime;

ALTER TABLE provider_sync_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_sync_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_sync_limits_tenant ON provider_sync_limits TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

COMMIT;

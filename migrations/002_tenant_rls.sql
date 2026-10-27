BEGIN;

CREATE ROLE creative_intelligence_runtime
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE creative_intelligence_rls_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO creative_intelligence_runtime;
GRANT USAGE ON SCHEMA public TO creative_intelligence_rls_owner;
GRANT SELECT ON organization_members TO creative_intelligence_rls_owner;
GRANT SELECT, UPDATE ON organizations TO creative_intelligence_rls_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations,
  organization_members,
  products,
  competitors,
  competitor_ads,
  creative_briefs
TO creative_intelligence_runtime;

CREATE FUNCTION app_verified_user_id() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')
$$;

CREATE FUNCTION app_is_member(target_organization_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT public.app_verified_user_id() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = target_organization_id
      AND user_id = public.app_verified_user_id()
  )
$$;

CREATE FUNCTION app_is_admin(target_organization_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT public.app_verified_user_id() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = target_organization_id
      AND user_id = public.app_verified_user_id()
      AND role = 'admin'
  )
$$;

CREATE FUNCTION app_has_members(target_organization_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members
    WHERE organization_id = target_organization_id
  )
$$;

CREATE FUNCTION app_preserve_final_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE
  removes_admin boolean;
BEGIN
  PERFORM 1
  FROM public.organizations
  WHERE id = OLD.organization_id
  FOR UPDATE;

  -- A missing parent during DELETE means this row is being removed by the
  -- organization's ON DELETE CASCADE. The invariant no longer applies.
  IF NOT FOUND AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    removes_admin := OLD.role = 'admin';
  ELSE
    removes_admin := OLD.role = 'admin' AND (
      NEW.role <> 'admin'
      OR NEW.organization_id <> OLD.organization_id
      OR NEW.user_id <> OLD.user_id
    );
  END IF;

  IF removes_admin
     AND NOT EXISTS (
       SELECT 1
       FROM public.organization_members
       WHERE organization_id = OLD.organization_id
         AND user_id <> OLD.user_id
         AND role = 'admin'
     ) THEN
    RAISE EXCEPTION 'organization must retain an administrator' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION app_verified_user_id() OWNER TO creative_intelligence_rls_owner;
ALTER FUNCTION app_is_member(text) OWNER TO creative_intelligence_rls_owner;
ALTER FUNCTION app_is_admin(text) OWNER TO creative_intelligence_rls_owner;
ALTER FUNCTION app_has_members(text) OWNER TO creative_intelligence_rls_owner;
ALTER FUNCTION app_preserve_final_admin() OWNER TO creative_intelligence_rls_owner;

REVOKE ALL ON FUNCTION app_verified_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_admin(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_has_members(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_preserve_final_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_verified_user_id() TO creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_is_member(text) TO creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_is_admin(text) TO creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_has_members(text) TO creative_intelligence_runtime;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organizations_select ON organizations
  FOR SELECT TO creative_intelligence_runtime
  USING (app_is_member(id));
CREATE POLICY organizations_insert ON organizations
  FOR INSERT TO creative_intelligence_runtime
  WITH CHECK (app_verified_user_id() IS NOT NULL);
CREATE POLICY organizations_update ON organizations
  FOR UPDATE TO creative_intelligence_runtime
  USING (app_is_admin(id)) WITH CHECK (app_is_admin(id));
CREATE POLICY organizations_delete ON organizations
  FOR DELETE TO creative_intelligence_runtime
  USING (app_is_admin(id));

ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_members_select ON organization_members
  FOR SELECT TO creative_intelligence_runtime
  USING (app_is_member(organization_id));
CREATE POLICY organization_members_insert ON organization_members
  FOR INSERT TO creative_intelligence_runtime
  WITH CHECK (
    app_is_admin(organization_id)
    OR (
      app_verified_user_id() IS NOT NULL
      AND user_id = app_verified_user_id()
      AND role = 'admin'
      AND NOT app_has_members(organization_id)
    )
  );
CREATE POLICY organization_members_update ON organization_members
  FOR UPDATE TO creative_intelligence_runtime
  USING (app_is_admin(organization_id)) WITH CHECK (app_is_admin(organization_id));
CREATE POLICY organization_members_delete ON organization_members
  FOR DELETE TO creative_intelligence_runtime
  USING (app_is_admin(organization_id));
CREATE TRIGGER organization_members_preserve_admin
  BEFORE UPDATE OR DELETE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION app_preserve_final_admin();

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
CREATE POLICY products_tenant ON products TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitors FORCE ROW LEVEL SECURITY;
CREATE POLICY competitors_tenant ON competitors TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

ALTER TABLE competitor_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ads FORCE ROW LEVEL SECURITY;
CREATE POLICY competitor_ads_tenant ON competitor_ads TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

ALTER TABLE creative_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_briefs FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_briefs_tenant ON creative_briefs TO creative_intelligence_runtime
  USING (app_is_member(organization_id))
  WITH CHECK (app_is_member(organization_id));

COMMIT;

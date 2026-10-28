BEGIN;

-- Existing installations reach this migration with the original 002 role set.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='creative_intelligence_scheduled_worker') THEN
    CREATE ROLE creative_intelligence_scheduled_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
DO $$
DECLARE worker_oid oid;
BEGIN
  SELECT oid INTO worker_oid FROM pg_catalog.pg_roles WHERE rolname='creative_intelligence_scheduled_worker';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=worker_oid) THEN
    RAISE EXCEPTION 'unexpected scheduled worker role membership';
  END IF;
END $$;
ALTER ROLE creative_intelligence_scheduled_worker
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO creative_intelligence_scheduled_worker;

ALTER TABLE competitor_ads
  ADD COLUMN IF NOT EXISTS snapshot_scope_key text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='competitor_ads_snapshot_scope_key_length') THEN
    ALTER TABLE competitor_ads ADD CONSTRAINT competitor_ads_snapshot_scope_key_length
      CHECK (snapshot_scope_key IS NULL OR length(snapshot_scope_key) BETWEEN 1 AND 256) NOT VALID;
  END IF;
END $$;
ALTER TABLE competitor_ads VALIDATE CONSTRAINT competitor_ads_snapshot_scope_key_length;

CREATE TABLE competitor_ad_sync_schedules (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  competitor_id text NOT NULL,
  provider_name text NOT NULL DEFAULT 'apify-meta-ads' CHECK (provider_name = 'apify-meta-ads'),
  actor_user_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 60 AND 604800),
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (organization_id, competitor_id, provider_name),
  FOREIGN KEY (organization_id, product_id, competitor_id)
    REFERENCES competitors(organization_id, product_id, id) ON DELETE CASCADE
);

CREATE TABLE competitor_ad_sync_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 256),
  schedule_id text NOT NULL REFERENCES competitor_ad_sync_schedules(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  competitor_id text NOT NULL,
  provider_name text NOT NULL CHECK (provider_name = 'apify-meta-ads'),
  actor_user_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 20),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  lease_expires_at timestamptz,
  fence_token text CHECK (fence_token IS NULL OR length(fence_token) BETWEEN 1 AND 256),
  last_error_category text CHECK (last_error_category IS NULL OR last_error_category IN ('provider','network','validation','authorization','internal')),
  inserted_count integer CHECK (inserted_count IS NULL OR inserted_count >= 0),
  duplicate_count integer CHECK (duplicate_count IS NULL OR duplicate_count >= 0),
  retired_count integer CHECK (retired_count IS NULL OR retired_count >= 0),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((status='running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND fence_token IS NOT NULL)),
  CHECK ((status IN ('succeeded','failed','cancelled')) = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  CHECK ((status='succeeded') = (inserted_count IS NOT NULL AND duplicate_count IS NOT NULL AND retired_count IS NOT NULL)),
  CHECK (status='succeeded' OR (inserted_count IS NULL AND duplicate_count IS NULL AND retired_count IS NULL)),
  FOREIGN KEY (organization_id, product_id, competitor_id)
    REFERENCES competitors(organization_id, product_id, id) ON DELETE CASCADE
);

-- UNIQUE (competitor_id) WHERE status IN active states: database-enforced single flight.
CREATE UNIQUE INDEX competitor_ad_sync_runs_one_active
  ON competitor_ad_sync_runs (organization_id, competitor_id, provider_name)
  WHERE status IN ('queued','running','retry_wait');
CREATE INDEX competitor_ad_sync_schedules_due ON competitor_ad_sync_schedules (next_run_at,id) WHERE enabled;
CREATE INDEX competitor_ad_sync_runs_claim ON competitor_ad_sync_runs (next_attempt_at,id) WHERE status IN ('queued','running','retry_wait');

GRANT SELECT, INSERT, UPDATE, DELETE ON competitor_ad_sync_schedules TO creative_intelligence_runtime;
GRANT SELECT ON competitor_ad_sync_runs TO creative_intelligence_runtime;
GRANT SELECT, INSERT, UPDATE ON competitor_ad_sync_schedules, competitor_ad_sync_runs, competitor_ads TO creative_intelligence_rls_owner;
GRANT SELECT ON organization_members, products, competitors TO creative_intelligence_rls_owner;

ALTER TABLE competitor_ad_sync_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ad_sync_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY competitor_ad_sync_schedules_select ON competitor_ad_sync_schedules FOR SELECT TO creative_intelligence_runtime USING (app_is_member(organization_id));
CREATE POLICY competitor_ad_sync_schedules_write ON competitor_ad_sync_schedules FOR ALL TO creative_intelligence_runtime USING (app_is_admin(organization_id)) WITH CHECK (app_is_admin(organization_id));
ALTER TABLE competitor_ad_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ad_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY competitor_ad_sync_runs_select ON competitor_ad_sync_runs FOR SELECT TO creative_intelligence_runtime USING (app_is_member(organization_id));

CREATE FUNCTION app_claim_due_ad_sync_runs(claim_owner text, claim_lease_seconds integer, claim_max_attempts integer, claim_batch_size integer)
RETURNS SETOF competitor_ad_sync_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE db_now timestamptz := clock_timestamp();
BEGIN
  IF claim_owner IS NULL OR length(claim_owner) NOT BETWEEN 1 AND 256
     OR claim_lease_seconds IS NULL OR claim_lease_seconds NOT BETWEEN 10 AND 3600
     OR claim_max_attempts IS NULL OR claim_max_attempts NOT BETWEEN 1 AND 20
     OR claim_batch_size IS NULL OR claim_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid sync claim parameters' USING ERRCODE='22023';
  END IF;

  -- Invalid work is terminalized before claiming so the partial unique index is released.
  UPDATE public.competitor_ad_sync_runs r SET status='cancelled', completed_at=db_now,
    lease_owner=NULL, lease_expires_at=NULL, fence_token=NULL, last_error_category=NULL
  WHERE r.status IN ('queued','retry_wait','running') AND (
    NOT EXISTS (SELECT 1 FROM public.competitor_ad_sync_schedules s WHERE s.id=r.schedule_id AND s.enabled)
    OR NOT EXISTS (SELECT 1 FROM public.products p WHERE p.organization_id=r.organization_id AND p.id=r.product_id AND p.archived_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.competitors c WHERE c.organization_id=r.organization_id AND c.product_id=r.product_id AND c.id=r.competitor_id AND c.archived_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.organization_id=r.organization_id AND m.user_id=r.actor_user_id AND m.role='admin')
  );

  UPDATE public.competitor_ad_sync_runs SET
    status=CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
    next_attempt_at=db_now,
    completed_at=CASE WHEN attempt >= max_attempts THEN db_now ELSE NULL END,
    lease_owner=NULL, lease_expires_at=NULL, fence_token=NULL, last_error_category='internal'
  WHERE status='running' AND lease_expires_at <= db_now;
  UPDATE public.competitor_ad_sync_schedules s SET last_run_at=db_now,
    next_run_at=db_now+make_interval(secs=>s.interval_seconds),updated_at=db_now
  WHERE EXISTS (SELECT 1 FROM public.competitor_ad_sync_runs r WHERE r.schedule_id=s.id
    AND r.status='failed' AND r.completed_at=db_now AND r.last_error_category='internal');

  INSERT INTO public.competitor_ad_sync_runs(id,schedule_id,organization_id,product_id,competitor_id,provider_name,actor_user_id,status,max_attempts,scheduled_at,next_attempt_at)
  SELECT gen_random_uuid()::text,s.id,s.organization_id,s.product_id,s.competitor_id,s.provider_name,s.actor_user_id,'queued',claim_max_attempts,s.next_run_at,db_now
  FROM public.competitor_ad_sync_schedules s
  JOIN public.products p ON p.organization_id=s.organization_id AND p.id=s.product_id AND p.archived_at IS NULL
  JOIN public.competitors c ON c.organization_id=s.organization_id AND c.product_id=s.product_id AND c.id=s.competitor_id AND c.archived_at IS NULL
  JOIN public.organization_members m ON m.organization_id=s.organization_id AND m.user_id=s.actor_user_id AND m.role='admin'
  WHERE s.enabled AND s.next_run_at <= db_now AND NOT EXISTS (
    SELECT 1 FROM public.competitor_ad_sync_runs r WHERE r.organization_id=s.organization_id AND r.competitor_id=s.competitor_id AND r.provider_name=s.provider_name AND r.status IN ('queued','running','retry_wait'))
  ORDER BY s.next_run_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT claim_batch_size ON CONFLICT DO NOTHING;

  RETURN QUERY WITH candidates AS (
    SELECT r.id FROM public.competitor_ad_sync_runs r
    JOIN public.competitor_ad_sync_schedules s ON s.id=r.schedule_id AND s.enabled
    JOIN public.organization_members m ON m.organization_id=r.organization_id AND m.user_id=r.actor_user_id AND m.role='admin'
    JOIN public.products p ON p.organization_id=r.organization_id AND p.id=r.product_id AND p.archived_at IS NULL
    JOIN public.competitors c ON c.organization_id=r.organization_id AND c.product_id=r.product_id AND c.id=r.competitor_id AND c.archived_at IS NULL
    WHERE r.status IN ('queued','retry_wait') AND r.next_attempt_at <= db_now
    ORDER BY r.next_attempt_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT claim_batch_size
  ) UPDATE public.competitor_ad_sync_runs r SET status='running',attempt=r.attempt+1,
    started_at=COALESCE(r.started_at,db_now),lease_owner=claim_owner,
    lease_expires_at=db_now+make_interval(secs=>claim_lease_seconds),fence_token=gen_random_uuid()::text
  FROM candidates WHERE r.id=candidates.id RETURNING r.*;
END $$;
ALTER FUNCTION app_claim_due_ad_sync_runs(text,integer,integer,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_claim_due_ad_sync_runs(text,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_claim_due_ad_sync_runs(text,integer,integer,integer) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_claim_due_ad_sync_runs(text,integer,integer,integer) TO creative_intelligence_scheduled_worker;

CREATE FUNCTION app_is_canonical_stored_text(candidate text, maximum_length integer, allow_empty boolean)
RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT candidate IS NOT NULL
    AND maximum_length >= 0
    AND (allow_empty OR length(candidate) > 0)
    AND length(candidate) <= maximum_length
    AND candidate = btrim(candidate,
      chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
      chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||
      chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||
      chr(8287)||chr(12288)||chr(65279))
    -- PostgreSQL text cannot contain U+0000; retain an explicit UTF-8 byte guard.
    AND position(decode('00','hex') in convert_to(candidate,'UTF8')) = 0
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT generate_series(1,31) AS codepoint
        UNION ALL SELECT generate_series(127,159)
      ) controls
      WHERE strpos(candidate,chr(codepoint)) > 0
    )
$$;
ALTER FUNCTION app_is_canonical_stored_text(text,integer,boolean) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_is_canonical_stored_text(text,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_canonical_stored_text(text,integer,boolean) FROM creative_intelligence_runtime;
REVOKE ALL ON FUNCTION app_is_canonical_stored_text(text,integer,boolean) FROM creative_intelligence_scheduled_worker;

CREATE FUNCTION app_is_canonical_scheduled_https_url(candidate text, maximum_length integer)
RETURNS boolean
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT public.app_is_canonical_stored_text(candidate,maximum_length,false)
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY[
        9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,
        8200,8201,8202,8232,8233,8239,8287,12288,65279
      ]) codepoints(codepoint)
      WHERE strpos(candidate,chr(codepoint)) > 0
    )
    AND candidate ~ '^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?([/?][^#]*)?$'
    AND octet_length(substring(substring(candidate from 9) from '^[^/?]+')) <= 253
$$;
ALTER FUNCTION app_is_canonical_scheduled_https_url(text,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_is_canonical_scheduled_https_url(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_canonical_scheduled_https_url(text,integer) FROM creative_intelligence_runtime;
REVOKE ALL ON FUNCTION app_is_canonical_scheduled_https_url(text,integer) FROM creative_intelligence_scheduled_worker;

CREATE FUNCTION app_validate_scheduled_competitor_ad(ad_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  item jsonb;
  item_text text;
  item_index integer;
  started_at_value timestamptz;
  ended_at_value timestamptz;
  lower_value numeric;
BEGIN
  IF ad_payload IS NULL OR jsonb_typeof(ad_payload) <> 'object' OR octet_length(ad_payload::text) > 1048576
    OR (SELECT count(*) <> 22 OR bool_or(key <> ALL (ARRAY[
      'platform','externalId','pageId','advertiserName','body','headline','description','callToAction',
      'displayFormat','adType','startedAt','endedAt','isActive','publisherPlatforms','impressionsLowerBound',
      'impressionsUpperBound','spendLowerBound','spendUpperBound','currency','media','mediaUrls','sourceUrl'
    ])) FROM jsonb_object_keys(ad_payload) AS keys(key))
    OR jsonb_typeof(ad_payload->'platform') <> 'string' OR ad_payload->>'platform' <> 'meta'
    OR jsonb_typeof(ad_payload->'externalId') <> 'string'
    OR NOT public.app_is_canonical_stored_text(ad_payload->>'externalId',256,false)
    OR jsonb_typeof(ad_payload->'advertiserName') <> 'string'
    OR NOT public.app_is_canonical_stored_text(ad_payload->>'advertiserName',500,false)
    OR jsonb_typeof(ad_payload->'body') <> 'string' OR NOT public.app_is_canonical_stored_text(ad_payload->>'body',20000,true)
    OR jsonb_typeof(ad_payload->'callToAction') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'callToAction')='string' AND NOT public.app_is_canonical_stored_text(ad_payload->>'callToAction',100,false))
    OR jsonb_typeof(ad_payload->'pageId') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'pageId')='string' AND NOT public.app_is_canonical_stored_text(ad_payload->>'pageId',256,false))
    OR jsonb_typeof(ad_payload->'headline') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'headline')='string' AND NOT public.app_is_canonical_stored_text(ad_payload->>'headline',500,false))
    OR jsonb_typeof(ad_payload->'description') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'description')='string' AND NOT public.app_is_canonical_stored_text(ad_payload->>'description',2000,false))
    OR jsonb_typeof(ad_payload->'displayFormat') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'displayFormat')='string' AND NOT public.app_is_canonical_stored_text(ad_payload->>'displayFormat',100,false))
    OR jsonb_typeof(ad_payload->'adType') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'adType')='string' AND ad_payload->>'adType' NOT IN ('image','video','carousel','text'))
    OR jsonb_typeof(ad_payload->'startedAt') <> 'string'
    OR ad_payload->>'startedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR jsonb_typeof(ad_payload->'endedAt') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'endedAt')='string' AND ad_payload->>'endedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$')
    OR jsonb_typeof(ad_payload->'isActive') <> 'boolean'
    OR jsonb_typeof(ad_payload->'mediaUrls') <> 'array' OR jsonb_array_length(ad_payload->'mediaUrls') > 50
    OR (ad_payload->>'body'='' AND jsonb_array_length(ad_payload->'mediaUrls')=0)
    OR jsonb_typeof(ad_payload->'publisherPlatforms') NOT IN ('array','null')
    OR (jsonb_typeof(ad_payload->'publisherPlatforms')='array' AND jsonb_array_length(ad_payload->'publisherPlatforms') > 20)
    OR jsonb_typeof(ad_payload->'media') NOT IN ('array','null')
    OR (jsonb_typeof(ad_payload->'media')='array' AND jsonb_array_length(ad_payload->'media') > 50)
    OR jsonb_typeof(ad_payload->'currency') NOT IN ('string','null')
    OR (jsonb_typeof(ad_payload->'currency')='string' AND ad_payload->>'currency' !~ '^[A-Z]{3}$')
    OR jsonb_typeof(ad_payload->'sourceUrl') <> 'string'
    OR NOT public.app_is_canonical_scheduled_https_url(ad_payload->>'sourceUrl',2048)
  THEN RETURN false; END IF;

  FOREACH item_text IN ARRAY ARRAY['impressionsLowerBound','impressionsUpperBound','spendLowerBound','spendUpperBound'] LOOP
    IF jsonb_typeof(ad_payload->item_text) NOT IN ('number','null') THEN RETURN false; END IF;
    IF jsonb_typeof(ad_payload->item_text)='number' THEN
      lower_value := (ad_payload->>item_text)::numeric;
      IF lower_value < 0 OR lower_value > 1e308::numeric THEN RETURN false; END IF;
      IF item_text LIKE 'impressions%' AND (lower_value <> trunc(lower_value) OR lower_value > 9007199254740991) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF jsonb_typeof(ad_payload->'impressionsLowerBound')='number' AND jsonb_typeof(ad_payload->'impressionsUpperBound')='number'
    AND (ad_payload->>'impressionsLowerBound')::numeric > (ad_payload->>'impressionsUpperBound')::numeric THEN RETURN false; END IF;
  IF jsonb_typeof(ad_payload->'spendLowerBound')='number' AND jsonb_typeof(ad_payload->'spendUpperBound')='number'
    AND (ad_payload->>'spendLowerBound')::numeric > (ad_payload->>'spendUpperBound')::numeric THEN RETURN false; END IF;

  IF (SELECT count(*) <> count(DISTINCT value#>>'{}') FROM jsonb_array_elements(ad_payload->'mediaUrls') values_(value)) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(ad_payload->'mediaUrls') values_(value) LOOP
    IF jsonb_typeof(item) <> 'string' OR NOT public.app_is_canonical_scheduled_https_url(item#>>'{}',2048) THEN RETURN false; END IF;
  END LOOP;

  IF jsonb_typeof(ad_payload->'publisherPlatforms')='array' THEN
    IF (SELECT count(*) <> count(DISTINCT value#>>'{}') FROM jsonb_array_elements(ad_payload->'publisherPlatforms') values_(value)) THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(ad_payload->'publisherPlatforms') values_(value) LOOP
      IF jsonb_typeof(item) <> 'string' OR NOT public.app_is_canonical_stored_text(item#>>'{}',100,false) THEN RETURN false; END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(ad_payload->'media')='array' THEN
    FOR item, item_index IN SELECT value, ordinality::integer-1 FROM jsonb_array_elements(ad_payload->'media') WITH ORDINALITY values_(value,ordinality) LOOP
      IF jsonb_typeof(item) <> 'object'
        OR (SELECT count(*) <> 5 OR bool_or(key <> ALL (ARRAY['kind','sourceUrl','posterUrl','cardIndex','order'])) FROM jsonb_object_keys(item) keys(key))
        OR jsonb_typeof(item->'kind') <> 'string' OR item->>'kind' NOT IN ('image','video')
        OR jsonb_typeof(item->'sourceUrl') <> 'string' OR NOT public.app_is_canonical_scheduled_https_url(item->>'sourceUrl',2048)
        OR jsonb_typeof(item->'posterUrl') NOT IN ('string','null')
        OR (jsonb_typeof(item->'posterUrl')='string' AND NOT public.app_is_canonical_scheduled_https_url(item->>'posterUrl',2048))
        OR jsonb_typeof(item->'order') <> 'number' OR (item->>'order')::numeric <> item_index
        OR jsonb_typeof(item->'cardIndex') NOT IN ('number','null')
        OR (jsonb_typeof(item->'cardIndex')='number' AND ((item->>'cardIndex')::numeric <> trunc((item->>'cardIndex')::numeric) OR (item->>'cardIndex')::numeric NOT BETWEEN 0 AND 49))
      THEN RETURN false; END IF;
    END LOOP;
  END IF;

  started_at_value := (ad_payload->>'startedAt')::timestamptz;
  IF jsonb_typeof(ad_payload->'endedAt')='string' THEN
    ended_at_value := (ad_payload->>'endedAt')::timestamptz;
    IF ended_at_value < started_at_value THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END $$;
ALTER FUNCTION app_validate_scheduled_competitor_ad(jsonb) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_validate_scheduled_competitor_ad(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_validate_scheduled_competitor_ad(jsonb) FROM creative_intelligence_runtime;
REVOKE ALL ON FUNCTION app_validate_scheduled_competitor_ad(jsonb) FROM creative_intelligence_scheduled_worker;

CREATE FUNCTION app_upsert_scheduled_competitor_ad(
  sync_run_id text, sync_owner text, sync_fence text, proposed_id text, proposed_ingestion_token text,
  ad_payload jsonb, scope_key text
) RETURNS TABLE(id text, ingestion_token text, product_id text, competitor_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE locked_run public.competitor_ad_sync_runs%ROWTYPE; db_now timestamptz := clock_timestamp();
BEGIN
  IF sync_run_id IS NULL OR length(sync_run_id) NOT BETWEEN 1 AND 256
    OR sync_owner IS NULL OR length(sync_owner) NOT BETWEEN 1 AND 256
    OR sync_fence IS NULL OR length(sync_fence) NOT BETWEEN 1 AND 256
    OR NOT public.app_is_canonical_stored_text(proposed_id,256,false)
    OR NOT public.app_is_canonical_stored_text(proposed_ingestion_token,128,false)
    OR ad_payload IS NULL
    OR (scope_key IS NOT NULL AND NOT public.app_is_canonical_stored_text(scope_key,256,false)) THEN
    RAISE EXCEPTION 'invalid scheduled ad parameters' USING ERRCODE='22023';
  END IF;
  SELECT r.* INTO locked_run FROM public.competitor_ad_sync_runs r
    JOIN public.competitor_ad_sync_schedules s ON s.id=r.schedule_id AND s.enabled
    JOIN public.organization_members m ON m.organization_id=r.organization_id AND m.user_id=r.actor_user_id AND m.role='admin'
    JOIN public.products p ON p.organization_id=r.organization_id AND p.id=r.product_id AND p.archived_at IS NULL
    JOIN public.competitors c ON c.organization_id=r.organization_id AND c.product_id=r.product_id AND c.id=r.competitor_id AND c.archived_at IS NULL
    WHERE r.id=sync_run_id AND r.status='running' AND r.lease_owner=sync_owner
      AND r.fence_token=sync_fence AND r.lease_expires_at>db_now FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'scheduled sync lease was lost' USING ERRCODE='40001'; END IF;
  IF NOT public.app_validate_scheduled_competitor_ad(ad_payload) THEN
    RAISE EXCEPTION 'invalid scheduled ad payload' USING ERRCODE='22023';
  END IF;

  RETURN QUERY INSERT INTO public.competitor_ads (
    id,ingestion_token,organization_id,product_id,competitor_id,provider_name,platform,external_id,page_id,
    advertiser_name,body,headline,description,call_to_action,display_format,ad_type,started_at,ended_at,is_active,
    publisher_platforms,impressions_lower_bound,impressions_upper_bound,spend_lower_bound,spend_upper_bound,currency,
    media,media_urls,source_url,first_seen_at,last_seen_at,snapshot_scope_key
  ) VALUES (
    proposed_id,proposed_ingestion_token,locked_run.organization_id,locked_run.product_id,locked_run.competitor_id,locked_run.provider_name,
    ad_payload->>'platform',ad_payload->>'externalId',ad_payload->>'pageId',ad_payload->>'advertiserName',ad_payload->>'body',
    ad_payload->>'headline',ad_payload->>'description',ad_payload->>'callToAction',ad_payload->>'displayFormat',ad_payload->>'adType',
    (ad_payload->>'startedAt')::timestamptz,(ad_payload->>'endedAt')::timestamptz,(ad_payload->>'isActive')::boolean,
    ad_payload->'publisherPlatforms',(ad_payload->>'impressionsLowerBound')::bigint,(ad_payload->>'impressionsUpperBound')::bigint,
    (ad_payload->>'spendLowerBound')::numeric,(ad_payload->>'spendUpperBound')::numeric,ad_payload->>'currency',
    ad_payload->'media',ad_payload->'mediaUrls',ad_payload->>'sourceUrl',db_now,db_now,scope_key
  ) ON CONFLICT (organization_id,provider_name,platform,external_id) DO UPDATE SET
    page_id=EXCLUDED.page_id,advertiser_name=EXCLUDED.advertiser_name,body=EXCLUDED.body,headline=EXCLUDED.headline,
    description=EXCLUDED.description,call_to_action=EXCLUDED.call_to_action,display_format=EXCLUDED.display_format,
    ad_type=EXCLUDED.ad_type,started_at=EXCLUDED.started_at,ended_at=EXCLUDED.ended_at,is_active=EXCLUDED.is_active,
    publisher_platforms=EXCLUDED.publisher_platforms,impressions_lower_bound=EXCLUDED.impressions_lower_bound,
    impressions_upper_bound=EXCLUDED.impressions_upper_bound,spend_lower_bound=EXCLUDED.spend_lower_bound,
    spend_upper_bound=EXCLUDED.spend_upper_bound,currency=EXCLUDED.currency,media=EXCLUDED.media,media_urls=EXCLUDED.media_urls,
    source_url=EXCLUDED.source_url,last_seen_at=EXCLUDED.last_seen_at,
    snapshot_scope_key=CASE WHEN EXCLUDED.snapshot_scope_key IS NULL THEN competitor_ads.snapshot_scope_key ELSE EXCLUDED.snapshot_scope_key END
    WHERE competitor_ads.product_id=EXCLUDED.product_id AND competitor_ads.competitor_id=EXCLUDED.competitor_id
    RETURNING competitor_ads.id,competitor_ads.ingestion_token,competitor_ads.product_id,competitor_ads.competitor_id;
END $$;
ALTER FUNCTION app_upsert_scheduled_competitor_ad(text,text,text,text,text,jsonb,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_upsert_scheduled_competitor_ad(text,text,text,text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_upsert_scheduled_competitor_ad(text,text,text,text,text,jsonb,text) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_upsert_scheduled_competitor_ad(text,text,text,text,text,jsonb,text) TO creative_intelligence_scheduled_worker;

CREATE FUNCTION app_retire_scheduled_competitor_ads(
  sync_run_id text, sync_owner text, sync_fence text, scope_key text, seen_identities text[]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE locked_run public.competitor_ad_sync_runs%ROWTYPE; db_now timestamptz := clock_timestamp(); changed integer;
BEGIN
  IF sync_run_id IS NULL OR length(sync_run_id) NOT BETWEEN 1 AND 256
    OR sync_owner IS NULL OR length(sync_owner) NOT BETWEEN 1 AND 256
    OR sync_fence IS NULL OR length(sync_fence) NOT BETWEEN 1 AND 256
    OR NOT public.app_is_canonical_stored_text(scope_key,256,false)
    OR seen_identities IS NULL OR cardinality(seen_identities)>1000
    OR EXISTS (SELECT 1 FROM unnest(seen_identities) value WHERE value IS NULL OR length(value) NOT BETWEEN 1 AND 513) THEN
    RAISE EXCEPTION 'invalid scheduled retirement parameters' USING ERRCODE='22023';
  END IF;
  SELECT r.* INTO locked_run FROM public.competitor_ad_sync_runs r
    JOIN public.competitor_ad_sync_schedules s ON s.id=r.schedule_id AND s.enabled
    JOIN public.organization_members m ON m.organization_id=r.organization_id AND m.user_id=r.actor_user_id AND m.role='admin'
    JOIN public.products p ON p.organization_id=r.organization_id AND p.id=r.product_id AND p.archived_at IS NULL
    JOIN public.competitors c ON c.organization_id=r.organization_id AND c.product_id=r.product_id AND c.id=r.competitor_id AND c.archived_at IS NULL
    WHERE r.id=sync_run_id AND r.status='running' AND r.lease_owner=sync_owner
      AND r.fence_token=sync_fence AND r.lease_expires_at>db_now FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'scheduled sync lease was lost' USING ERRCODE='40001'; END IF;
  UPDATE public.competitor_ads SET is_active=false,ended_at=CASE WHEN started_at>db_now THEN started_at ELSE db_now END
    WHERE organization_id=locked_run.organization_id AND product_id=locked_run.product_id
      AND competitor_id=locked_run.competitor_id AND provider_name=locked_run.provider_name AND is_active
      AND snapshot_scope_key=scope_key AND NOT ((platform||':'||external_id)=ANY(seen_identities));
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed;
END $$;
ALTER FUNCTION app_retire_scheduled_competitor_ads(text,text,text,text,text[]) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_retire_scheduled_competitor_ads(text,text,text,text,text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_retire_scheduled_competitor_ads(text,text,text,text,text[]) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_retire_scheduled_competitor_ads(text,text,text,text,text[]) TO creative_intelligence_scheduled_worker;

CREATE FUNCTION app_finish_ad_sync_run_success(finish_run_id text, finish_owner text, finish_fence text, finish_inserted integer, finish_duplicates integer, finish_retired integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE changed integer; DECLARE db_now timestamptz := clock_timestamp();
BEGIN
 IF finish_run_id IS NULL OR length(finish_run_id) NOT BETWEEN 1 AND 256
   OR finish_owner IS NULL OR length(finish_owner) NOT BETWEEN 1 AND 256
   OR finish_fence IS NULL OR length(finish_fence) NOT BETWEEN 1 AND 256
   OR finish_inserted IS NULL OR finish_inserted<0
   OR finish_duplicates IS NULL OR finish_duplicates<0
   OR finish_retired IS NULL OR finish_retired<0
 THEN RAISE EXCEPTION 'invalid sync result' USING ERRCODE='22023'; END IF;
 UPDATE public.competitor_ad_sync_runs SET status='succeeded',completed_at=db_now,lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,
  last_error_category=NULL,inserted_count=finish_inserted,duplicate_count=finish_duplicates,retired_count=finish_retired
 WHERE id=finish_run_id AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>db_now;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 THEN UPDATE public.competitor_ad_sync_schedules s SET last_run_at=db_now,next_run_at=db_now+make_interval(secs=>s.interval_seconds),updated_at=db_now
  FROM public.competitor_ad_sync_runs r WHERE r.id=finish_run_id AND s.id=r.schedule_id; END IF;
 RETURN changed=1;
END $$;
ALTER FUNCTION app_finish_ad_sync_run_success(text,text,text,integer,integer,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_finish_ad_sync_run_success(text,text,text,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_finish_ad_sync_run_success(text,text,text,integer,integer,integer) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_finish_ad_sync_run_success(text,text,text,integer,integer,integer) TO creative_intelligence_scheduled_worker;

CREATE FUNCTION app_finish_ad_sync_run_failure(finish_run_id text, finish_owner text, finish_fence text, finish_category text, retry_delay_seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE changed integer; DECLARE db_now timestamptz := clock_timestamp();
BEGIN
 IF finish_run_id IS NULL OR length(finish_run_id) NOT BETWEEN 1 AND 256
   OR finish_owner IS NULL OR length(finish_owner) NOT BETWEEN 1 AND 256
   OR finish_fence IS NULL OR length(finish_fence) NOT BETWEEN 1 AND 256
   OR finish_category IS NULL OR finish_category NOT IN ('provider','network','validation','authorization','internal')
   OR retry_delay_seconds IS NULL OR retry_delay_seconds NOT BETWEEN 0 AND 86400
 THEN RAISE EXCEPTION 'invalid sync failure' USING ERRCODE='22023'; END IF;
 UPDATE public.competitor_ad_sync_runs SET status=CASE WHEN attempt>=max_attempts THEN 'failed' ELSE 'retry_wait' END,
  completed_at=CASE WHEN attempt>=max_attempts THEN db_now ELSE NULL END,next_attempt_at=db_now+make_interval(secs=>retry_delay_seconds),
  lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,last_error_category=finish_category
 WHERE id=finish_run_id AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>db_now;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed=1 THEN
   UPDATE public.competitor_ad_sync_schedules s SET last_run_at=db_now,
     next_run_at=db_now+make_interval(secs=>s.interval_seconds),updated_at=db_now
   FROM public.competitor_ad_sync_runs r
   WHERE r.id=finish_run_id AND r.status='failed' AND s.id=r.schedule_id;
 END IF;
 RETURN changed=1;
END $$;
ALTER FUNCTION app_finish_ad_sync_run_failure(text,text,text,text,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_finish_ad_sync_run_failure(text,text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_finish_ad_sync_run_failure(text,text,text,text,integer) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_finish_ad_sync_run_failure(text,text,text,text,integer) TO creative_intelligence_scheduled_worker;

CREATE FUNCTION app_admin_disable_ad_sync_schedule(
  target_organization_id text, target_product_id text, target_competitor_id text
) RETURNS SETOF public.competitor_ad_sync_schedules
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE db_now timestamptz := clock_timestamp();
BEGIN
  IF target_organization_id IS NULL OR length(target_organization_id) NOT BETWEEN 1 AND 256
    OR target_product_id IS NULL OR length(target_product_id) NOT BETWEEN 1 AND 256
    OR target_competitor_id IS NULL OR length(target_competitor_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid schedule target' USING ERRCODE='22023';
  END IF;
  IF public.app_verified_user_id() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id=target_organization_id AND m.user_id=public.app_verified_user_id() AND m.role='admin'
  ) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='42501'; END IF;
  UPDATE public.competitor_ad_sync_runs r SET status='cancelled',completed_at=db_now,
    lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,last_error_category=NULL
    WHERE r.organization_id=target_organization_id AND r.product_id=target_product_id
      AND r.competitor_id=target_competitor_id AND r.status IN ('queued','retry_wait','running');
  RETURN QUERY UPDATE public.competitor_ad_sync_schedules s SET enabled=false,updated_at=db_now
    WHERE s.organization_id=target_organization_id AND s.product_id=target_product_id AND s.competitor_id=target_competitor_id
    RETURNING s.*;
END $$;
ALTER FUNCTION app_admin_disable_ad_sync_schedule(text,text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_admin_disable_ad_sync_schedule(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_admin_disable_ad_sync_schedule(text,text,text) FROM creative_intelligence_scheduled_worker;
GRANT EXECUTE ON FUNCTION app_admin_disable_ad_sync_schedule(text,text,text) TO creative_intelligence_runtime;

COMMIT;

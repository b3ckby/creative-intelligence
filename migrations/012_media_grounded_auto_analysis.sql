BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='creative_intelligence_analysis_worker') THEN
    CREATE ROLE creative_intelligence_analysis_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE creative_intelligence_analysis_worker
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO creative_intelligence_analysis_worker;

ALTER TABLE creative_ad_analyses
  ADD COLUMN provenance text NOT NULL DEFAULT 'manual' CHECK (provenance IN ('manual','automatic')),
  ADD COLUMN analysis_mode text NOT NULL DEFAULT 'copy_only' CHECK (analysis_mode IN ('media','copy_only')),
  ADD COLUMN media_count integer NOT NULL DEFAULT 0 CHECK (media_count BETWEEN 0 AND 16),
  ADD COLUMN failure_category text CHECK (failure_category IS NULL OR failure_category IN ('provider','rate_limit','quota','invalid_media','storage','internal'));

CREATE TABLE creative_analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  product_id text NOT NULL,
  competitor_ad_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','succeeded','failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  lease_expires_at timestamptz,
  fence_token text CHECK (fence_token IS NULL OR fence_token ~ '^[a-f0-9]{64}$'),
  failure_category text CHECK (failure_category IS NULL OR failure_category IN ('provider','rate_limit','quota','invalid_media','storage','internal')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,competitor_ad_id),
  FOREIGN KEY (organization_id,product_id,competitor_ad_id)
    REFERENCES competitor_ads(organization_id,product_id,id) ON DELETE CASCADE,
  CHECK ((status='running')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND fence_token IS NOT NULL))
);
CREATE INDEX creative_analysis_jobs_claim ON creative_analysis_jobs(next_attempt_at,id)
  WHERE status IN ('queued','running','retry_wait');

ALTER TABLE creative_analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_analysis_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY creative_analysis_jobs_tenant ON creative_analysis_jobs
  FOR SELECT TO creative_intelligence_runtime USING (app_is_member(organization_id));
GRANT SELECT ON creative_analysis_jobs TO creative_intelligence_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON creative_analysis_jobs TO creative_intelligence_rls_owner;
GRANT SELECT,INSERT,UPDATE ON creative_ad_analyses,creative_analysis_daily_usage TO creative_intelligence_rls_owner;

CREATE FUNCTION app_enqueue_creative_analysis(target_organization_id text,target_product_id text,target_ad_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF target_organization_id IS NULL OR length(target_organization_id) NOT BETWEEN 1 AND 256
    OR target_product_id IS NULL OR length(target_product_id) NOT BETWEEN 1 AND 256
    OR target_ad_id IS NULL OR length(target_ad_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid analysis enqueue target' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.creative_analysis_jobs(organization_id,product_id,competitor_ad_id)
  SELECT target_organization_id,target_product_id,target_ad_id
  WHERE EXISTS (SELECT 1 FROM public.competitor_ads WHERE organization_id=target_organization_id AND product_id=target_product_id AND id=target_ad_id)
  ON CONFLICT (organization_id,competitor_ad_id) DO UPDATE SET
    product_id=EXCLUDED.product_id,status='queued',attempt=0,next_attempt_at=clock_timestamp(),
    lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,failure_category=NULL,updated_at=clock_timestamp();
END $$;
ALTER FUNCTION app_enqueue_creative_analysis(text,text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_enqueue_creative_analysis(text,text,text) FROM PUBLIC,creative_intelligence_runtime,creative_intelligence_analysis_worker;

CREATE FUNCTION app_enqueue_creative_analysis_ad_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN PERFORM public.app_enqueue_creative_analysis(NEW.organization_id,NEW.product_id,NEW.id); RETURN NEW; END $$;
ALTER FUNCTION app_enqueue_creative_analysis_ad_trigger() OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_enqueue_creative_analysis_ad_trigger() FROM PUBLIC;
CREATE TRIGGER enqueue_creative_analysis_ad AFTER INSERT OR UPDATE OF advertiser_name,body,call_to_action ON competitor_ads
  FOR EACH ROW EXECUTE FUNCTION app_enqueue_creative_analysis_ad_trigger();

CREATE FUNCTION app_enqueue_creative_analysis_media_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE target_product_id text;
BEGIN
  IF NEW.status='succeeded' AND NEW.active_checksum IS NOT NULL
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.active_checksum IS DISTINCT FROM NEW.active_checksum) THEN
    SELECT product_id INTO target_product_id FROM public.competitor_ads WHERE organization_id=NEW.organization_id AND id=NEW.ad_id;
    IF FOUND THEN PERFORM public.app_enqueue_creative_analysis(NEW.organization_id,target_product_id,NEW.ad_id); END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app_enqueue_creative_analysis_media_trigger() OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_enqueue_creative_analysis_media_trigger() FROM PUBLIC;
CREATE TRIGGER enqueue_creative_analysis AFTER UPDATE OF status,active_checksum ON competitor_ad_media_positions
  FOR EACH ROW EXECUTE FUNCTION app_enqueue_creative_analysis_media_trigger();

INSERT INTO creative_analysis_jobs(organization_id,product_id,competitor_ad_id)
SELECT organization_id,product_id,id FROM competitor_ads ON CONFLICT DO NOTHING;

CREATE FUNCTION app_get_creative_analysis_media(target_organization_id text,target_ad_id text,target_limit integer)
RETURNS TABLE(slot_kind text,media_position integer,checksum text,media_type text,byte_size bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF target_organization_id IS NULL OR length(target_organization_id) NOT BETWEEN 1 AND 256
    OR target_ad_id IS NULL OR length(target_ad_id) NOT BETWEEN 1 AND 256
    OR target_limit IS NULL OR target_limit NOT BETWEEN 1 AND 16
    OR NOT public.app_is_member(target_organization_id) THEN
    RAISE EXCEPTION 'analysis media is unavailable' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT p.slot_kind,p.position,p.active_checksum,b.media_type,b.byte_size
    FROM public.competitor_ad_media_positions p JOIN public.creative_media_blobs b ON b.checksum=p.active_checksum
    WHERE p.organization_id=target_organization_id AND p.ad_id=target_ad_id AND p.status='succeeded'
      AND b.media_type IN ('image/jpeg','image/png','image/gif','image/webp')
    ORDER BY CASE p.slot_kind WHEN 'structured_source' THEN 0 WHEN 'structured_poster' THEN 1 ELSE 2 END,p.position,p.active_checksum
    LIMIT target_limit;
END $$;
ALTER FUNCTION app_get_creative_analysis_media(text,text,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_get_creative_analysis_media(text,text,integer) FROM PUBLIC,creative_intelligence_analysis_worker,creative_intelligence_media_worker;
GRANT EXECUTE ON FUNCTION app_get_creative_analysis_media(text,text,integer) TO creative_intelligence_runtime;

CREATE FUNCTION app_claim_creative_analysis_jobs(claim_owner text,claim_lease_seconds integer,claim_batch_size integer)
RETURNS TABLE(job_id uuid,organization_id text,product_id text,competitor_ad_id text,advertiser_name text,body text,call_to_action text,attempt integer,max_attempts integer,fence_token text,media jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE db_now timestamptz:=clock_timestamp();
BEGIN
  IF claim_owner IS NULL OR length(claim_owner) NOT BETWEEN 1 AND 256
    OR claim_lease_seconds IS NULL OR claim_lease_seconds NOT BETWEEN 10 AND 3600
    OR claim_batch_size IS NULL OR claim_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid analysis claim parameters' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH candidates AS (
    SELECT j.id FROM public.creative_analysis_jobs j
    WHERE ((j.status IN ('queued','retry_wait') AND j.next_attempt_at<=db_now AND j.attempt<j.max_attempts)
       OR (j.status='running' AND j.lease_expires_at<=db_now))
    ORDER BY CASE WHEN j.status='running' THEN 0 ELSE 1 END,j.next_attempt_at,j.id
    FOR UPDATE OF j SKIP LOCKED LIMIT claim_batch_size
  ), claimed AS (
    UPDATE public.creative_analysis_jobs j SET status='running',attempt=j.attempt+1,lease_owner=claim_owner,
      lease_expires_at=db_now+make_interval(secs=>claim_lease_seconds),fence_token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),
      failure_category=CASE WHEN j.status='running' THEN 'internal' ELSE j.failure_category END,updated_at=db_now
    FROM candidates WHERE j.id=candidates.id RETURNING j.*
  )
  SELECT c.id,c.organization_id,c.product_id,c.competitor_ad_id,a.advertiser_name,a.body,a.call_to_action,
    c.attempt,c.max_attempts,c.fence_token,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('slotKind',m.slot_kind,'position',m.position,'checksum',m.active_checksum,
      'mediaType',m.media_type,'byteSize',m.byte_size) ORDER BY m.slot_order,m.position,m.active_checksum)
      FROM (SELECT p.slot_kind,p.position,p.active_checksum,b.media_type,b.byte_size,
          CASE p.slot_kind WHEN 'structured_source' THEN 0 WHEN 'structured_poster' THEN 1 ELSE 2 END AS slot_order
        FROM public.competitor_ad_media_positions p JOIN public.creative_media_blobs b ON b.checksum=p.active_checksum
        WHERE p.organization_id=c.organization_id AND p.ad_id=c.competitor_ad_id AND p.status='succeeded'
          AND b.media_type IN ('image/jpeg','image/png','image/gif','image/webp')
        ORDER BY slot_order,p.position,p.active_checksum LIMIT 4) m), '[]'::jsonb)
  FROM claimed c JOIN public.competitor_ads a ON a.organization_id=c.organization_id AND a.product_id=c.product_id AND a.id=c.competitor_ad_id;
END $$;
ALTER FUNCTION app_claim_creative_analysis_jobs(text,integer,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_claim_creative_analysis_jobs(text,integer,integer) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_claim_creative_analysis_jobs(text,integer,integer) TO creative_intelligence_analysis_worker;

CREATE FUNCTION app_begin_auto_analysis(begin_job uuid,begin_owner text,begin_fence text,begin_version text,begin_fingerprint text,
  begin_provider text,begin_model text,begin_prompt text,begin_mode text,begin_media_count integer,begin_daily_limit integer)
RETURNS TABLE(outcome text,analysis_claim text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE job public.creative_analysis_jobs%ROWTYPE; token text:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''); usage_row integer;
BEGIN
  IF begin_job IS NULL OR begin_owner IS NULL OR length(begin_owner) NOT BETWEEN 1 AND 256 OR begin_fence !~ '^[a-f0-9]{64}$'
    OR begin_version IS NULL OR length(begin_version) NOT BETWEEN 1 AND 128 OR begin_fingerprint !~ '^[a-f0-9]{64}$'
    OR begin_provider IS NULL OR length(begin_provider) NOT BETWEEN 1 AND 64 OR begin_model IS NULL OR length(begin_model) NOT BETWEEN 1 AND 200
    OR begin_prompt IS NULL OR length(begin_prompt) NOT BETWEEN 1 AND 128 OR begin_mode NOT IN ('media','copy_only')
    OR begin_media_count NOT BETWEEN 0 AND 16 OR begin_daily_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid auto analysis parameters' USING ERRCODE='22023';
  END IF;
  SELECT * INTO job FROM public.creative_analysis_jobs WHERE id=begin_job AND status='running' AND lease_owner=begin_owner
    AND fence_token=begin_fence AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'lost'::text,NULL::text; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.creative_ad_analyses WHERE organization_id=job.organization_id AND competitor_ad_id=job.competitor_ad_id
    AND analysis_version=begin_version AND input_fingerprint=begin_fingerprint AND status='completed') THEN
    UPDATE public.creative_analysis_jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,failure_category=NULL,updated_at=clock_timestamp() WHERE id=begin_job;
    RETURN QUERY SELECT 'cached'::text,NULL::text; RETURN;
  END IF;
  INSERT INTO public.creative_ad_analyses(organization_id,product_id,competitor_ad_id,analysis_version,model_provider,model_name,prompt_version,
    input_fingerprint,status,claim_token,claim_expires_at,tags,analyzed_at,provenance,analysis_mode,media_count,failure_category)
  VALUES(job.organization_id,job.product_id,job.competitor_ad_id,begin_version,begin_provider,begin_model,begin_prompt,
    begin_fingerprint,'pending',token,job.lease_expires_at,NULL,NULL,'automatic',begin_mode,begin_media_count,NULL)
  ON CONFLICT (organization_id,competitor_ad_id,analysis_version,input_fingerprint) DO UPDATE SET
    product_id=EXCLUDED.product_id,model_provider=EXCLUDED.model_provider,model_name=EXCLUDED.model_name,prompt_version=EXCLUDED.prompt_version,
    status='pending',claim_token=EXCLUDED.claim_token,claim_expires_at=EXCLUDED.claim_expires_at,tags=NULL,analyzed_at=NULL,
    provenance='automatic',analysis_mode=EXCLUDED.analysis_mode,media_count=EXCLUDED.media_count,failure_category=NULL,updated_at=clock_timestamp()
  WHERE creative_ad_analyses.status='failed' OR (creative_ad_analyses.status='pending' AND creative_ad_analyses.claim_expires_at<=clock_timestamp());
  IF NOT FOUND THEN RETURN QUERY SELECT 'busy'::text,NULL::text; RETURN; END IF;
  INSERT INTO public.creative_analysis_daily_usage(organization_id,usage_date,usage_count,updated_at)
  VALUES(job.organization_id,(clock_timestamp() AT TIME ZONE 'UTC')::date,1,clock_timestamp())
  ON CONFLICT (organization_id,usage_date) DO UPDATE SET usage_count=creative_analysis_daily_usage.usage_count+1,updated_at=EXCLUDED.updated_at
    WHERE creative_analysis_daily_usage.usage_count<begin_daily_limit RETURNING usage_count INTO usage_row;
  IF usage_row IS NULL THEN
    UPDATE public.creative_ad_analyses SET status='failed',claim_token=NULL,claim_expires_at=NULL,failure_category='quota'
      WHERE organization_id=job.organization_id AND competitor_ad_id=job.competitor_ad_id AND analysis_version=begin_version AND input_fingerprint=begin_fingerprint AND claim_token=token;
    RETURN QUERY SELECT 'quota'::text,NULL::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'run'::text,token;
END $$;
ALTER FUNCTION app_begin_auto_analysis(uuid,text,text,text,text,text,text,text,text,integer,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_begin_auto_analysis(uuid,text,text,text,text,text,text,text,text,integer,integer) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_begin_auto_analysis(uuid,text,text,text,text,text,text,text,text,integer,integer) TO creative_intelligence_analysis_worker;

CREATE FUNCTION app_finish_auto_analysis_success(finish_job uuid,finish_owner text,finish_fence text,finish_version text,finish_fingerprint text,finish_claim text,finish_tags jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE job public.creative_analysis_jobs%ROWTYPE; changed integer;
BEGIN
  IF finish_job IS NULL OR finish_owner IS NULL OR length(finish_owner) NOT BETWEEN 1 AND 256 OR finish_fence !~ '^[a-f0-9]{64}$'
    OR finish_version IS NULL OR length(finish_version) NOT BETWEEN 1 AND 128 OR finish_fingerprint !~ '^[a-f0-9]{64}$'
    OR finish_claim !~ '^[a-f0-9]{64}$' OR jsonb_typeof(finish_tags)<>'object' THEN RAISE EXCEPTION 'invalid analysis success parameters' USING ERRCODE='22023'; END IF;
  SELECT * INTO job FROM public.creative_analysis_jobs WHERE id=finish_job AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.creative_ad_analyses SET status='completed',tags=finish_tags,analyzed_at=clock_timestamp(),claim_token=NULL,claim_expires_at=NULL,failure_category=NULL,updated_at=clock_timestamp()
    WHERE organization_id=job.organization_id AND competitor_ad_id=job.competitor_ad_id AND analysis_version=finish_version AND input_fingerprint=finish_fingerprint
      AND status='pending' AND claim_token=finish_claim AND claim_expires_at>clock_timestamp();
  GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 THEN RETURN false; END IF;
  UPDATE public.creative_analysis_jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,failure_category=NULL,updated_at=clock_timestamp() WHERE id=finish_job;
  RETURN true;
END $$;
ALTER FUNCTION app_finish_auto_analysis_success(uuid,text,text,text,text,text,jsonb) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_finish_auto_analysis_success(uuid,text,text,text,text,text,jsonb) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_finish_auto_analysis_success(uuid,text,text,text,text,text,jsonb) TO creative_intelligence_analysis_worker;

CREATE FUNCTION app_finish_auto_analysis_failure(finish_job uuid,finish_owner text,finish_fence text,finish_version text,finish_fingerprint text,finish_claim text,finish_category text,finish_delay integer,finish_terminal boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE job public.creative_analysis_jobs%ROWTYPE; changed integer;
BEGIN
  IF finish_job IS NULL OR finish_owner IS NULL OR length(finish_owner) NOT BETWEEN 1 AND 256 OR finish_fence !~ '^[a-f0-9]{64}$'
    OR finish_version IS NULL OR length(finish_version) NOT BETWEEN 1 AND 128 OR finish_fingerprint !~ '^[a-f0-9]{64}$'
    OR finish_claim !~ '^[a-f0-9]{64}$' OR finish_category NOT IN ('provider','rate_limit','quota','invalid_media','storage','internal')
    OR finish_delay NOT BETWEEN 0 AND 86400 OR finish_terminal IS NULL THEN RAISE EXCEPTION 'invalid analysis failure parameters' USING ERRCODE='22023'; END IF;
  SELECT * INTO job FROM public.creative_analysis_jobs WHERE id=finish_job AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.creative_ad_analyses SET status='failed',tags=NULL,analyzed_at=NULL,claim_token=NULL,claim_expires_at=NULL,failure_category=finish_category,updated_at=clock_timestamp()
    WHERE organization_id=job.organization_id AND competitor_ad_id=job.competitor_ad_id AND analysis_version=finish_version AND input_fingerprint=finish_fingerprint AND status='pending' AND claim_token=finish_claim;
  UPDATE public.creative_analysis_jobs SET status=CASE WHEN finish_terminal OR attempt>=max_attempts THEN 'failed' ELSE 'retry_wait' END,
    next_attempt_at=clock_timestamp()+make_interval(secs=>finish_delay),lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,failure_category=finish_category,updated_at=clock_timestamp() WHERE id=finish_job;
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;
ALTER FUNCTION app_finish_auto_analysis_failure(uuid,text,text,text,text,text,text,integer,boolean) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_finish_auto_analysis_failure(uuid,text,text,text,text,text,text,integer,boolean) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_finish_auto_analysis_failure(uuid,text,text,text,text,text,text,integer,boolean) TO creative_intelligence_analysis_worker;

COMMIT;

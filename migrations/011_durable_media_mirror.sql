BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='creative_intelligence_media_worker') THEN
    CREATE ROLE creative_intelligence_media_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE creative_intelligence_media_worker
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO creative_intelligence_media_worker;

ALTER TABLE competitor_ads ADD CONSTRAINT competitor_ads_organization_id_id_unique UNIQUE (organization_id,id);

CREATE TABLE creative_media_blobs (
  checksum text PRIMARY KEY CHECK (checksum ~ '^[a-f0-9]{64}$'),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 104857600),
  media_type text NOT NULL CHECK (media_type IN ('image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE competitor_ad_media_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ad_id text NOT NULL,
  slot_kind text NOT NULL CHECK (slot_kind IN ('structured_source','structured_poster','legacy')),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 49),
  media_kind text NOT NULL CHECK (media_kind IN ('image','video','unknown')),
  card_index integer CHECK (card_index BETWEEN 0 AND 49),
  desired_source_url text NOT NULL CHECK (length(desired_source_url) BETWEEN 1 AND 2048),
  active_source_url text CHECK (active_source_url IS NULL OR length(active_source_url) BETWEEN 1 AND 2048),
  active_checksum text REFERENCES creative_media_blobs(checksum),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','retry_wait','succeeded','failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 20),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 256),
  lease_expires_at timestamptz,
  fence_token text CHECK (fence_token IS NULL OR length(fence_token) BETWEEN 1 AND 256),
  last_error_category text CHECK (last_error_category IS NULL OR last_error_category IN ('network','redirect','address','http','size','mime','storage','internal')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, ad_id, slot_kind, position),
  FOREIGN KEY (organization_id, ad_id) REFERENCES competitor_ads (organization_id, id) ON DELETE CASCADE,
  CHECK ((status='running')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND fence_token IS NOT NULL)),
  CHECK ((active_checksum IS NULL)=(active_source_url IS NULL))
);
CREATE INDEX competitor_ad_media_positions_claim
  ON competitor_ad_media_positions(next_attempt_at,id) WHERE status IN ('queued','running','retry_wait');
CREATE INDEX competitor_ad_media_positions_ad
  ON competitor_ad_media_positions(organization_id,ad_id,slot_kind,position);

CREATE TABLE media_mirror_backfill_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cursor text CHECK (cursor IS NULL OR length(cursor) BETWEEN 1 AND 256),
  completed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO media_mirror_backfill_state(singleton) VALUES(true);

GRANT SELECT ON competitor_ad_media_positions TO creative_intelligence_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON competitor_ad_media_positions,creative_media_blobs TO creative_intelligence_rls_owner;
GRANT SELECT,UPDATE ON media_mirror_backfill_state TO creative_intelligence_rls_owner;
ALTER TABLE competitor_ad_media_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_ad_media_positions FORCE ROW LEVEL SECURITY;
CREATE POLICY competitor_ad_media_positions_select ON competitor_ad_media_positions
  FOR SELECT TO creative_intelligence_runtime USING (app_is_member(organization_id));

CREATE FUNCTION app_reconcile_ad_media_positions(target_organization_id text,target_ad_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE ad_record public.competitor_ads%ROWTYPE; item jsonb; item_index integer; changed integer := 0; touched text[] := ARRAY[]::text[];
BEGIN
  IF target_organization_id IS NULL OR length(target_organization_id) NOT BETWEEN 1 AND 256
     OR target_ad_id IS NULL OR length(target_ad_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid media reconciliation target' USING ERRCODE='22023';
  END IF;
  SELECT * INTO ad_record FROM public.competitor_ads
    WHERE organization_id=target_organization_id AND id=target_ad_id FOR SHARE;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF jsonb_typeof(ad_record.media)='array' THEN
    FOR item,item_index IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(ad_record.media) WITH ORDINALITY values_(value,ordinality) LOOP
      INSERT INTO public.competitor_ad_media_positions(organization_id,ad_id,slot_kind,position,media_kind,card_index,desired_source_url)
      VALUES (ad_record.organization_id,ad_record.id,'structured_source',item_index,item->>'kind',(item->>'cardIndex')::integer,item->>'sourceUrl')
      ON CONFLICT (organization_id,ad_id,slot_kind,position) DO UPDATE SET
        media_kind=EXCLUDED.media_kind,card_index=EXCLUDED.card_index,desired_source_url=EXCLUDED.desired_source_url,
        status=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN 'queued' ELSE competitor_ad_media_positions.status END,
        attempt=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN 0 ELSE competitor_ad_media_positions.attempt END,
        next_attempt_at=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN clock_timestamp() ELSE competitor_ad_media_positions.next_attempt_at END,
        lease_owner=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.lease_owner END,
        lease_expires_at=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.lease_expires_at END,
        fence_token=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.fence_token END,
        last_error_category=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.last_error_category END,updated_at=clock_timestamp();
      touched := array_append(touched,'structured_source:'||item_index); changed := changed+1;
      IF jsonb_typeof(item->'posterUrl')='string' THEN
        INSERT INTO public.competitor_ad_media_positions(organization_id,ad_id,slot_kind,position,media_kind,card_index,desired_source_url)
        VALUES (ad_record.organization_id,ad_record.id,'structured_poster',item_index,'image',(item->>'cardIndex')::integer,item->>'posterUrl')
        ON CONFLICT (organization_id,ad_id,slot_kind,position) DO UPDATE SET
          media_kind='image',card_index=EXCLUDED.card_index,desired_source_url=EXCLUDED.desired_source_url,
          status=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN 'queued' ELSE competitor_ad_media_positions.status END,
          attempt=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN 0 ELSE competitor_ad_media_positions.attempt END,
          next_attempt_at=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN clock_timestamp() ELSE competitor_ad_media_positions.next_attempt_at END,
          lease_owner=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.lease_owner END,
        lease_expires_at=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.lease_expires_at END,
        fence_token=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.fence_token END,
        last_error_category=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.last_error_category END,updated_at=clock_timestamp();
        touched := array_append(touched,'structured_poster:'||item_index); changed := changed+1;
      END IF;
    END LOOP;
  END IF;
  FOR item,item_index IN SELECT value,ordinality::integer-1 FROM jsonb_array_elements(ad_record.media_urls) WITH ORDINALITY values_(value,ordinality) LOOP
    INSERT INTO public.competitor_ad_media_positions(organization_id,ad_id,slot_kind,position,media_kind,desired_source_url)
    VALUES (ad_record.organization_id,ad_record.id,'legacy',item_index,'unknown',item#>>'{}')
    ON CONFLICT (organization_id,ad_id,slot_kind,position) DO UPDATE SET
      desired_source_url=EXCLUDED.desired_source_url,
      status=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN 'queued' ELSE competitor_ad_media_positions.status END,
      attempt=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN 0 ELSE competitor_ad_media_positions.attempt END,
      next_attempt_at=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN clock_timestamp() ELSE competitor_ad_media_positions.next_attempt_at END,
      lease_owner=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.lease_owner END,
      lease_expires_at=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.lease_expires_at END,
      fence_token=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.fence_token END,
      last_error_category=CASE WHEN competitor_ad_media_positions.desired_source_url IS DISTINCT FROM EXCLUDED.desired_source_url THEN NULL ELSE competitor_ad_media_positions.last_error_category END,updated_at=clock_timestamp();
    touched := array_append(touched,'legacy:'||item_index); changed := changed+1;
  END LOOP;
  DELETE FROM public.competitor_ad_media_positions p WHERE p.organization_id=ad_record.organization_id AND p.ad_id=ad_record.id
    AND NOT ((p.slot_kind||':'||p.position)=ANY(touched));
  RETURN changed;
END $$;
ALTER FUNCTION app_reconcile_ad_media_positions(text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_reconcile_ad_media_positions(text,text) FROM PUBLIC,creative_intelligence_runtime,creative_intelligence_media_worker;

CREATE FUNCTION app_reconcile_ad_media_positions_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN PERFORM public.app_reconcile_ad_media_positions(NEW.organization_id,NEW.id); RETURN NEW; END $$;
ALTER FUNCTION app_reconcile_ad_media_positions_trigger() OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_reconcile_ad_media_positions_trigger() FROM PUBLIC,creative_intelligence_runtime,creative_intelligence_media_worker;
CREATE TRIGGER reconcile_ad_media_positions AFTER INSERT OR UPDATE OF media,media_urls ON competitor_ads
  FOR EACH ROW EXECUTE FUNCTION app_reconcile_ad_media_positions_trigger();

CREATE FUNCTION app_claim_media_mirror_jobs(claim_owner text,claim_lease_seconds integer,claim_batch_size integer)
RETURNS SETOF competitor_ad_media_positions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE db_now timestamptz := clock_timestamp();
BEGIN
  IF claim_owner IS NULL OR length(claim_owner) NOT BETWEEN 1 AND 256
     OR claim_lease_seconds IS NULL OR claim_lease_seconds NOT BETWEEN 10 AND 3600
     OR claim_batch_size IS NULL OR claim_batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid media claim parameters' USING ERRCODE='22023';
  END IF;
  RETURN QUERY WITH candidates AS (
    SELECT p.id FROM public.competitor_ad_media_positions p
    WHERE ((p.status IN ('queued','retry_wait') AND p.next_attempt_at<=db_now AND p.attempt<p.max_attempts)
       OR (p.status='running' AND p.lease_expires_at<=db_now))
    ORDER BY CASE WHEN p.status='running' THEN 0 ELSE 1 END,p.next_attempt_at,p.id
    FOR UPDATE OF p SKIP LOCKED LIMIT claim_batch_size
  ), claimed AS (
    UPDATE public.competitor_ad_media_positions p SET
      status=CASE WHEN p.status='running' AND p.attempt>=p.max_attempts THEN 'failed' ELSE 'running' END,
      attempt=CASE WHEN p.status='running' AND p.attempt>=p.max_attempts THEN p.attempt ELSE p.attempt+1 END,
      next_attempt_at=CASE WHEN p.status='running' AND p.attempt>=p.max_attempts THEN db_now ELSE p.next_attempt_at END,
      lease_owner=CASE WHEN p.status='running' AND p.attempt>=p.max_attempts THEN NULL ELSE claim_owner END,
      lease_expires_at=CASE WHEN p.status='running' AND p.attempt>=p.max_attempts THEN NULL ELSE db_now+make_interval(secs=>claim_lease_seconds) END,
      fence_token=CASE WHEN p.status='running' AND p.attempt>=p.max_attempts THEN NULL ELSE gen_random_uuid()::text END,
      last_error_category=CASE WHEN p.status='running' THEN 'internal' ELSE p.last_error_category END,
      updated_at=db_now
    FROM candidates WHERE p.id=candidates.id RETURNING p.*
  ) SELECT * FROM claimed WHERE claimed.status='running';
END $$;
ALTER FUNCTION app_claim_media_mirror_jobs(text,integer,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_claim_media_mirror_jobs(text,integer,integer) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_claim_media_mirror_jobs(text,integer,integer) TO creative_intelligence_media_worker;

CREATE FUNCTION app_finish_media_mirror_success(finish_id uuid,finish_owner text,finish_fence text,finish_checksum text,finish_size bigint,finish_media_type text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE changed integer; db_now timestamptz:=clock_timestamp();
BEGIN
  IF finish_id IS NULL OR finish_owner IS NULL OR length(finish_owner) NOT BETWEEN 1 AND 256
    OR finish_fence IS NULL OR length(finish_fence) NOT BETWEEN 1 AND 256 OR finish_checksum !~ '^[a-f0-9]{64}$'
    OR finish_size IS NULL OR finish_size NOT BETWEEN 1 AND 104857600
    OR finish_media_type IS NULL OR finish_media_type NOT IN ('image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm') THEN
    RAISE EXCEPTION 'invalid media success parameters' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.competitor_ad_media_positions
    WHERE id=finish_id AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>db_now
    FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.creative_media_blobs(checksum,byte_size,media_type) VALUES(finish_checksum,finish_size,finish_media_type)
    ON CONFLICT(checksum) DO UPDATE SET checksum=EXCLUDED.checksum
    WHERE creative_media_blobs.byte_size=EXCLUDED.byte_size AND creative_media_blobs.media_type=EXCLUDED.media_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'media checksum metadata conflict' USING ERRCODE='23514'; END IF;
  UPDATE public.competitor_ad_media_positions SET active_source_url=desired_source_url,active_checksum=finish_checksum,
    status='succeeded',lease_owner=NULL,lease_expires_at=NULL,fence_token=NULL,last_error_category=NULL,updated_at=db_now
    WHERE id=finish_id AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>db_now;
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;
ALTER FUNCTION app_finish_media_mirror_success(uuid,text,text,text,bigint,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_finish_media_mirror_success(uuid,text,text,text,bigint,text) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_finish_media_mirror_success(uuid,text,text,text,bigint,text) TO creative_intelligence_media_worker;

CREATE FUNCTION app_finish_media_mirror_failure(finish_id uuid,finish_owner text,finish_fence text,finish_category text,retry_delay_seconds integer,terminal boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE changed integer; db_now timestamptz:=clock_timestamp();
BEGIN
  IF finish_id IS NULL OR finish_owner IS NULL OR length(finish_owner) NOT BETWEEN 1 AND 256
    OR finish_fence IS NULL OR length(finish_fence) NOT BETWEEN 1 AND 256
    OR finish_category IS NULL OR finish_category NOT IN ('network','redirect','address','http','size','mime','storage','internal')
    OR retry_delay_seconds IS NULL OR retry_delay_seconds NOT BETWEEN 0 AND 86400 OR terminal IS NULL THEN
    RAISE EXCEPTION 'invalid media failure parameters' USING ERRCODE='22023';
  END IF;
  UPDATE public.competitor_ad_media_positions SET
    status=CASE WHEN terminal OR attempt>=max_attempts THEN 'failed' ELSE 'retry_wait' END,
    next_attempt_at=db_now+make_interval(secs=>retry_delay_seconds),lease_owner=NULL,lease_expires_at=NULL,
    fence_token=NULL,last_error_category=finish_category,updated_at=db_now
    WHERE id=finish_id AND status='running' AND lease_owner=finish_owner AND fence_token=finish_fence AND lease_expires_at>db_now;
  GET DIAGNOSTICS changed=ROW_COUNT; RETURN changed=1;
END $$;
ALTER FUNCTION app_finish_media_mirror_failure(uuid,text,text,text,integer,boolean) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_finish_media_mirror_failure(uuid,text,text,text,integer,boolean) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_finish_media_mirror_failure(uuid,text,text,text,integer,boolean) TO creative_intelligence_media_worker;

CREATE FUNCTION app_enqueue_media_backfill(backfill_cursor text,backfill_limit integer)
RETURNS TABLE(next_cursor text,enqueued integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE ad_row record; processed integer:=0; last_id text:=NULL; persisted_cursor text; backfill_completed boolean;
BEGIN
  IF backfill_cursor IS NOT NULL AND length(backfill_cursor) NOT BETWEEN 1 AND 256
     OR backfill_limit IS NULL OR backfill_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'invalid media backfill parameters' USING ERRCODE='22023';
  END IF;
  SELECT cursor,completed INTO persisted_cursor,backfill_completed
    FROM public.media_mirror_backfill_state WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'media backfill state is missing' USING ERRCODE='55000'; END IF;
  IF backfill_cursor IS NOT NULL AND backfill_cursor IS DISTINCT FROM persisted_cursor THEN
    RAISE EXCEPTION 'invalid media backfill cursor' USING ERRCODE='22023';
  END IF;
  IF backfill_completed THEN RETURN QUERY SELECT NULL::text,0; RETURN; END IF;
  FOR ad_row IN SELECT organization_id,id FROM public.competitor_ads
    WHERE persisted_cursor IS NULL OR id>persisted_cursor ORDER BY id LIMIT backfill_limit LOOP
    PERFORM public.app_reconcile_ad_media_positions(ad_row.organization_id,ad_row.id);
    processed:=processed+1; last_id:=ad_row.id;
  END LOOP;
  UPDATE public.media_mirror_backfill_state SET
    cursor=CASE WHEN processed=backfill_limit THEN last_id ELSE COALESCE(last_id,persisted_cursor) END,
    completed=processed<backfill_limit,updated_at=clock_timestamp()
    WHERE singleton=true;
  RETURN QUERY SELECT CASE WHEN processed=backfill_limit THEN last_id ELSE NULL END,processed;
END $$;
ALTER FUNCTION app_enqueue_media_backfill(text,integer) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_enqueue_media_backfill(text,integer) FROM PUBLIC,creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_enqueue_media_backfill(text,integer) TO creative_intelligence_media_worker;

COMMIT;

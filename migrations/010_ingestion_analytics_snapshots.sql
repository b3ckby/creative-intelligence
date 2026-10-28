BEGIN;

GRANT SELECT, INSERT, UPDATE ON competitor_analytics_snapshots TO creative_intelligence_rls_owner;

-- Capture one product-relative analytics row per active competitor and UTC database
-- day. The existing primary key makes retries/replays idempotent within that grain.
CREATE FUNCTION app_capture_ingestion_analytics_snapshot_rows(
  capture_organization_id text,
  capture_product_id text,
  capture_now timestamptz
) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE
  captured integer;
BEGIN
  WITH aggregate_rows AS (
    SELECT
      c.id AS competitor_id,
      COUNT(a.id) FILTER (WHERE a.is_active)::integer AS active_ad_count,
      COUNT(a.id) FILTER (WHERE a.started_at >= capture_now-interval '7 days' AND a.started_at <= capture_now)::integer AS new_ads_last_7d,
      COUNT(a.id) FILTER (WHERE a.started_at >= capture_now-interval '14 days' AND a.started_at < capture_now-interval '7 days')::integer AS new_ads_prev_7d,
      ROUND(COALESCE(AVG(GREATEST(0, EXTRACT(EPOCH FROM (
        (CASE WHEN a.is_active THEN capture_now ELSE LEAST(a.last_seen_at,capture_now) END)-a.started_at
      ))/86400.0)) FILTER (WHERE a.id IS NOT NULL),0)::numeric,1) AS avg_days_active,
      COUNT(a.id) FILTER (WHERE a.is_active AND a.started_at < capture_now-interval '21 days')::integer AS long_runner_count,
      COUNT(a.id) FILTER (WHERE format.value='image')::integer AS image_count,
      COUNT(a.id) FILTER (WHERE format.value='video')::integer AS video_count,
      COUNT(a.id) FILTER (WHERE format.value='carousel')::integer AS carousel_count,
      COUNT(a.id) FILTER (WHERE format.value='text')::integer AS text_count,
      SUM((COALESCE(a.impressions_lower_bound,a.impressions_upper_bound)+COALESCE(a.impressions_upper_bound,a.impressions_lower_bound))/2.0)::numeric AS impression_weight,
      COUNT(a.id)::integer AS total_ad_count,
      COALESCE((MIN(a.first_seen_at)>=capture_now-interval '7 days' AND MIN(a.first_seen_at)<=capture_now AND COUNT(a.id)<=5),false) AS newly_tracked
    FROM public.competitors c
    LEFT JOIN public.competitor_ads a ON a.organization_id=c.organization_id AND a.product_id=c.product_id AND a.competitor_id=c.id
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN a.ad_type IS NOT NULL THEN a.ad_type
        WHEN EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(a.media_urls) media(media_url)
          WHERE lower(media_url) ~ '^https://video-'
             OR lower(split_part(split_part(media_url,'?',1),'#',1)) ~ '\.(mp4|m4v|webm|mov)$'
        ) THEN 'video'
        WHEN jsonb_array_length(a.media_urls)>0 THEN 'image'
        ELSE 'text'
      END AS value
    ) format ON true
    WHERE c.organization_id=capture_organization_id AND c.product_id=capture_product_id AND c.archived_at IS NULL
    GROUP BY c.id
  ), prepared AS (
    SELECT aggregate_rows.*,
      CASE WHEN newly_tracked THEN 0 ELSE new_ads_last_7d-new_ads_prev_7d END AS launch_velocity_delta,
      GREATEST(0,CASE WHEN newly_tracked THEN 0 ELSE new_ads_last_7d-new_ads_prev_7d END) AS positive_velocity
    FROM aggregate_rows
  ), bounds AS (
    SELECT MIN(long_runner_count) AS min_long,MAX(long_runner_count) AS max_long,
      MIN(active_ad_count) AS min_active,MAX(active_ad_count) AS max_active,
      MIN(positive_velocity) AS min_velocity,MAX(positive_velocity) AS max_velocity,
      MIN(COALESCE(impression_weight,0)) AS min_impressions,MAX(COALESCE(impression_weight,0)) AS max_impressions,
      bool_or(impression_weight IS NOT NULL) AS has_impressions
    FROM prepared
  ), scored AS (
    SELECT prepared.*,
      ROUND(100*(
        0.35*(CASE WHEN max_long<=min_long THEN CASE WHEN max_long>0 THEN 0.5 ELSE 0 END ELSE (long_runner_count-min_long)::numeric/(max_long-min_long) END)
        +0.20*(CASE WHEN max_active<=min_active THEN CASE WHEN max_active>0 THEN 0.5 ELSE 0 END ELSE (active_ad_count-min_active)::numeric/(max_active-min_active) END)
        +0.30*(CASE WHEN max_velocity<=min_velocity THEN CASE WHEN max_velocity>0 THEN 0.5 ELSE 0 END ELSE (positive_velocity-min_velocity)::numeric/(max_velocity-min_velocity) END)
        +CASE WHEN has_impressions THEN 0.15*(CASE WHEN max_impressions<=min_impressions THEN CASE WHEN max_impressions>0 THEN 0.5 ELSE 0 END ELSE (COALESCE(impression_weight,0)-min_impressions)/(max_impressions-min_impressions) END) ELSE 0 END
      )/(CASE WHEN has_impressions THEN 1.0 ELSE 0.85 END))::integer AS scale_score
    FROM prepared CROSS JOIN bounds
  )
  INSERT INTO public.competitor_analytics_snapshots(
    organization_id,product_id,competitor_id,snapshot_date,active_ad_count,new_ads_last_7d,new_ads_prev_7d,
    launch_velocity_delta,avg_days_active,long_runner_count,image_count,video_count,carousel_count,text_count,
    impression_weight,scale_score,newly_tracked,captured_at
  ) SELECT capture_organization_id,capture_product_id,competitor_id,(capture_now AT TIME ZONE 'UTC')::date,
      active_ad_count,new_ads_last_7d,new_ads_prev_7d,launch_velocity_delta,avg_days_active,long_runner_count,
      image_count,video_count,carousel_count,text_count,impression_weight,scale_score,newly_tracked,capture_now
    FROM scored
    ORDER BY competitor_id
  ON CONFLICT (organization_id, competitor_id, snapshot_date) DO UPDATE SET
    product_id=EXCLUDED.product_id,active_ad_count=EXCLUDED.active_ad_count,new_ads_last_7d=EXCLUDED.new_ads_last_7d,
    new_ads_prev_7d=EXCLUDED.new_ads_prev_7d,launch_velocity_delta=EXCLUDED.launch_velocity_delta,
    avg_days_active=EXCLUDED.avg_days_active,long_runner_count=EXCLUDED.long_runner_count,image_count=EXCLUDED.image_count,
    video_count=EXCLUDED.video_count,carousel_count=EXCLUDED.carousel_count,text_count=EXCLUDED.text_count,
    impression_weight=EXCLUDED.impression_weight,scale_score=EXCLUDED.scale_score,newly_tracked=EXCLUDED.newly_tracked,
    captured_at=EXCLUDED.captured_at;
  GET DIAGNOSTICS captured=ROW_COUNT;
  RETURN captured;
END $$;
ALTER FUNCTION app_capture_ingestion_analytics_snapshot_rows(text,text,timestamptz) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_capture_ingestion_analytics_snapshot_rows(text,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_capture_ingestion_analytics_snapshot_rows(text,text,timestamptz) FROM creative_intelligence_runtime;
REVOKE ALL ON FUNCTION app_capture_ingestion_analytics_snapshot_rows(text,text,timestamptz) FROM creative_intelligence_scheduled_worker;

CREATE FUNCTION app_capture_ingestion_analytics_snapshot(
  capture_organization_id text,
  capture_product_id text,
  capture_competitor_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE capture_now timestamptz := clock_timestamp();
BEGIN
  IF capture_organization_id IS NULL OR length(capture_organization_id) NOT BETWEEN 1 AND 256
    OR capture_product_id IS NULL OR length(capture_product_id) NOT BETWEEN 1 AND 256
    OR capture_competitor_id IS NULL OR length(capture_competitor_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid analytics snapshot capture parameters' USING ERRCODE='22023';
  END IF;
  IF NOT public.app_is_member(capture_organization_id) THEN
    RAISE EXCEPTION 'analytics snapshot capture is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.jsonb_build_array(capture_organization_id,capture_product_id)::text,729104::bigint)
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    WHERE p.organization_id=capture_organization_id AND p.id=capture_product_id AND p.archived_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.competitors c
    WHERE c.organization_id=capture_organization_id AND c.product_id=capture_product_id
      AND c.id=capture_competitor_id AND c.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'analytics snapshot capture is not authorized' USING ERRCODE='42501';
  END IF;
  RETURN public.app_capture_ingestion_analytics_snapshot_rows(capture_organization_id,capture_product_id,capture_now);
END $$;
ALTER FUNCTION app_capture_ingestion_analytics_snapshot(text,text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_capture_ingestion_analytics_snapshot(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_capture_ingestion_analytics_snapshot(text,text,text) FROM creative_intelligence_scheduled_worker;
GRANT EXECUTE ON FUNCTION app_capture_ingestion_analytics_snapshot(text,text,text) TO creative_intelligence_runtime;

CREATE FUNCTION app_lock_ingestion_product(
  lock_organization_id text,
  lock_product_id text,
  lock_competitor_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
  IF lock_organization_id IS NULL OR length(lock_organization_id) NOT BETWEEN 1 AND 256
    OR lock_product_id IS NULL OR length(lock_product_id) NOT BETWEEN 1 AND 256
    OR lock_competitor_id IS NULL OR length(lock_competitor_id) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid ingestion lock parameters' USING ERRCODE='22023';
  END IF;
  IF NOT public.app_is_member(lock_organization_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.organization_id=lock_organization_id AND p.id=lock_product_id AND p.archived_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM public.competitors c
      WHERE c.organization_id=lock_organization_id AND c.product_id=lock_product_id
        AND c.id=lock_competitor_id AND c.archived_at IS NULL
    ) THEN
    RAISE EXCEPTION 'ingestion product lock is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.jsonb_build_array(lock_organization_id,lock_product_id)::text,729104::bigint)
  );
  RETURN true;
END $$;
ALTER FUNCTION app_lock_ingestion_product(text,text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_lock_ingestion_product(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_lock_ingestion_product(text,text,text) FROM creative_intelligence_scheduled_worker;
GRANT EXECUTE ON FUNCTION app_lock_ingestion_product(text,text,text) TO creative_intelligence_runtime;

CREATE FUNCTION app_lock_scheduled_ingestion_product(
  sync_run_id text,
  sync_owner text,
  sync_fence text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE db_now timestamptz := clock_timestamp(); locked_run public.competitor_ad_sync_runs%ROWTYPE;
BEGIN
  IF sync_run_id IS NULL OR length(sync_run_id) NOT BETWEEN 1 AND 256
    OR sync_owner IS NULL OR length(sync_owner) NOT BETWEEN 1 AND 256
    OR sync_fence IS NULL OR length(sync_fence) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid scheduled ingestion lock parameters' USING ERRCODE='22023';
  END IF;
  SELECT r.* INTO locked_run FROM public.competitor_ad_sync_runs r
    JOIN public.competitor_ad_sync_schedules s ON s.id=r.schedule_id AND s.enabled
    JOIN public.organization_members m ON m.organization_id=r.organization_id AND m.user_id=r.actor_user_id AND m.role='admin'
    JOIN public.products p ON p.organization_id=r.organization_id AND p.id=r.product_id AND p.archived_at IS NULL
    JOIN public.competitors c ON c.organization_id=r.organization_id AND c.product_id=r.product_id AND c.id=r.competitor_id AND c.archived_at IS NULL
    WHERE r.id=sync_run_id AND r.status='running' AND r.lease_owner=sync_owner
      AND r.fence_token=sync_fence AND r.lease_expires_at>db_now
    FOR UPDATE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled sync lease was lost' USING ERRCODE='40001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.jsonb_build_array(locked_run.organization_id,locked_run.product_id)::text,729104::bigint)
  );
  RETURN true;
END $$;
ALTER FUNCTION app_lock_scheduled_ingestion_product(text,text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_lock_scheduled_ingestion_product(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_lock_scheduled_ingestion_product(text,text,text) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_lock_scheduled_ingestion_product(text,text,text) TO creative_intelligence_scheduled_worker;

CREATE FUNCTION app_capture_scheduled_ingestion_analytics_snapshot(
  capture_run_id text,
  capture_owner text,
  capture_fence text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE capture_now timestamptz := clock_timestamp(); locked_run public.competitor_ad_sync_runs%ROWTYPE;
BEGIN
  IF capture_run_id IS NULL OR length(capture_run_id) NOT BETWEEN 1 AND 256
    OR capture_owner IS NULL OR length(capture_owner) NOT BETWEEN 1 AND 256
    OR capture_fence IS NULL OR length(capture_fence) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'invalid analytics snapshot capture parameters' USING ERRCODE='22023';
  END IF;
  SELECT r.* INTO locked_run FROM public.competitor_ad_sync_runs r
    JOIN public.competitor_ad_sync_schedules s ON s.id=r.schedule_id AND s.enabled
    JOIN public.organization_members m ON m.organization_id=r.organization_id AND m.user_id=r.actor_user_id AND m.role='admin'
    JOIN public.products p ON p.organization_id=r.organization_id AND p.id=r.product_id AND p.archived_at IS NULL
    JOIN public.competitors c ON c.organization_id=r.organization_id AND c.product_id=r.product_id AND c.id=r.competitor_id AND c.archived_at IS NULL
    WHERE r.id=capture_run_id AND r.status='running' AND r.lease_owner=capture_owner
      AND r.fence_token=capture_fence AND r.lease_expires_at>capture_now
    FOR UPDATE OF r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled sync lease was lost' USING ERRCODE='40001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.jsonb_build_array(locked_run.organization_id,locked_run.product_id)::text,729104::bigint)
  );
  RETURN public.app_capture_ingestion_analytics_snapshot_rows(locked_run.organization_id,locked_run.product_id,capture_now);
END $$;
ALTER FUNCTION app_capture_scheduled_ingestion_analytics_snapshot(text,text,text) OWNER TO creative_intelligence_rls_owner;
REVOKE ALL ON FUNCTION app_capture_scheduled_ingestion_analytics_snapshot(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_capture_scheduled_ingestion_analytics_snapshot(text,text,text) FROM creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION app_capture_scheduled_ingestion_analytics_snapshot(text,text,text) TO creative_intelligence_scheduled_worker;

COMMIT;

BEGIN;

CREATE ROLE creative_intelligence_login_limiter_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE TABLE staging_login_attempts (
  address_hash TEXT PRIMARY KEY CHECK (char_length(address_hash) = 43),
  window_started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  CHECK (expires_at > window_started_at)
);
CREATE INDEX staging_login_attempts_expires_at_idx ON staging_login_attempts (expires_at);

REVOKE ALL ON staging_login_attempts FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO creative_intelligence_login_limiter_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON staging_login_attempts TO creative_intelligence_login_limiter_owner;

CREATE FUNCTION claim_staging_login_attempt(
  requested_address_hash TEXT,
  maximum_attempts INTEGER,
  attempt_window_ms BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_attempts INTEGER;
  claim_time TIMESTAMPTZ;
BEGIN
  IF char_length(requested_address_hash) <> 43
     OR maximum_attempts < 1 OR maximum_attempts > 100
     OR attempt_window_ms < 1000 OR attempt_window_ms > 3600000 THEN
    RAISE EXCEPTION 'invalid staging login limiter input';
  END IF;

  -- Serializing this small, unauthenticated boundary makes the cardinality cap
  -- exact across every worker and replica.
  PERFORM pg_advisory_xact_lock(734812902);
  claim_time := clock_timestamp();
  DELETE FROM public.staging_login_attempts WHERE expires_at <= claim_time;

  SELECT attempts
  INTO current_attempts
  FROM public.staging_login_attempts
  WHERE address_hash = requested_address_hash;

  IF NOT FOUND THEN
    IF (SELECT count(*) FROM public.staging_login_attempts) >= 10000 THEN
      RETURN FALSE;
    END IF;
    INSERT INTO public.staging_login_attempts (address_hash, window_started_at, expires_at, attempts)
    VALUES (
      requested_address_hash,
      claim_time,
      claim_time + (attempt_window_ms * INTERVAL '1 millisecond'),
      1
    );
    RETURN TRUE;
  END IF;

  IF current_attempts >= maximum_attempts THEN
    RETURN FALSE;
  END IF;

  UPDATE public.staging_login_attempts
  SET attempts = current_attempts + 1
  WHERE address_hash = requested_address_hash;
  RETURN TRUE;
END;
$$;

CREATE FUNCTION reset_staging_login_attempt(requested_address_hash TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF char_length(requested_address_hash) <> 43 THEN
    RAISE EXCEPTION 'invalid staging login limiter input';
  END IF;
  DELETE FROM public.staging_login_attempts WHERE address_hash = requested_address_hash;
END;
$$;

ALTER TABLE staging_login_attempts OWNER TO creative_intelligence_login_limiter_owner;
ALTER FUNCTION claim_staging_login_attempt(TEXT, INTEGER, BIGINT) OWNER TO creative_intelligence_login_limiter_owner;
ALTER FUNCTION reset_staging_login_attempt(TEXT) OWNER TO creative_intelligence_login_limiter_owner;

REVOKE ALL ON FUNCTION claim_staging_login_attempt(TEXT, INTEGER, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION reset_staging_login_attempt(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_staging_login_attempt(TEXT, INTEGER, BIGINT) TO creative_intelligence_runtime;
GRANT EXECUTE ON FUNCTION reset_staging_login_attempt(TEXT) TO creative_intelligence_runtime;

COMMIT;

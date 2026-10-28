# Creative Intelligence

Clean-room foundation for product intelligence, competitor advertising, creative briefs, and iteration planning.

The project does not copy Muppets source code or private datasets. The first source is Meta Ads through a provider-neutral contract, with manual/mock import implemented before any external collector.

## Implemented vertical slice

```text
Product
  → Competitor
    → AdSourceProvider
      → Manual Meta import
        → normalized competitor ad
          → creative brief
            → Iteration Map coverage
```

Implemented modules:

- `products` — tenant-owned product creation;
- `competitors` — competitors bound to products;
- `ad-ingestion` — provider-neutral collection contract and manual Meta provider;
- `ads` — normalized ad library with provider-ID deduplication;
- `briefs` — manual briefs and briefs created from competitor ads;
- `iteration-map` — covered and missing combinations across audience, market, angle, and format;
- `organizations` — membership and `admin/member` authorization;
- `persistence` — PostgreSQL repositories, transactional manual imports, and tenant-safe constraints;
- `http` — schema-backed Fastify REST API for organizations, products, competitors, ads, briefs, and Iteration Map;
- `web` — expressive light React workspace for products, competitors, ads, briefs, and Iteration Map coverage;
- `auth` — fail-closed provider-neutral OIDC/JWKS Bearer authentication;
- `config` and `server` — validated production composition, restricted-role startup checks, health probes, and graceful shutdown;
- in-memory repositories for deterministic domain tests plus PostgreSQL integration tests through `pg-mem`.

## Design decisions

- Every aggregate carries `organizationId`; services validate tenant boundaries.
- Ad ingestion depends on `AdSourceProvider`, not Apify, SocialPeta, or another vendor.
- Raw collection and normalized domain data are separate concepts.
- Ads are deduplicated by organization, trusted provider-registry namespace, platform, and external provider ID.
- Provider output is runtime-validated as a complete batch and cannot override trusted IDs or tenant ownership.
- Tenant context is snapshotted and frozen before provider execution; repository batch writes, complete-scope retirement, daily product-relative analytics capture, and scheduled success are atomic.
- PostgreSQL composite foreign keys enforce organization ownership for products, competitors, ads, and brief references.
- HTTP authentication is injected into `buildApi`; the library deliberately has no insecure header-based production default.
- API errors are sanitized before returning storage or unexpected failures.
- AI analysis is intentionally not part of the source record; it will be a versioned downstream module.

## Commands

```bash
npm install
npm run typecheck
npm run test:unit
npm run test:postgres
npm run test:web
npm run check:openapi
npm run typecheck:web
npm run build:web
npm run check
npm start
```

## API contract

[`docs/openapi.json`](docs/openapi.json) is generated deterministically from the same schemas Fastify applies to requests and responses. [`docs/API.md`](docs/API.md) explains authentication, pagination, sanitized errors, filters, and operational endpoints.

After changing a route contract:

```bash
npm run generate:openapi
npm run check:openapi
```

`npm run check` includes the drift check and fails when the checked-in OpenAPI document no longer matches `src/http/schemas.ts`.

## Frontend workspace

The browser MVP lives in `web/` and builds to `dist/web/`. It connects directly to the existing tenant-safe API and keeps bearer tokens in memory only. Run it locally with `npm run dev:web`; use `npm run build:web` for the production artifact. See [`docs/FRONTEND.md`](docs/FRONTEND.md) for the surfaces, security posture, and same-origin deployment guidance.

## PostgreSQL and HTTP

Apply `migrations/001_initial.sql` through `migrations/009_scheduled_provider_sync.sql` in numeric order to an empty PostgreSQL database. Migrations `002`, `005`, and `009` must run under a provisioning account allowed to create or normalize roles. The migrations create four fixed cluster roles:

- restricted `creative_intelligence_runtime` for application access;
- non-login `creative_intelligence_rls_owner`, which has only schema usage, membership-table read access, and organization-row lock privileges plus `BYPASSRLS`, solely to own the security-definer policy helpers;
- non-login `creative_intelligence_login_limiter_owner`, which alone owns the bounded staging-login table and security-definer claim/reset functions;
- non-login `creative_intelligence_scheduled_worker`, which can execute only fenced scheduled-sync functions and has no direct tenant-table access;
- forced row-level security policies and a database trigger that preserves at least one administrator.

Never grant either owner role to the runtime role or application login. Production API connections must assume `creative_intelligence_runtime` and must not use the migration owner or a superuser. Provision a separate login for scheduled work, grant it only `creative_intelligence_scheduled_worker`, and configure `AD_SYNC_WORKER_DATABASE_URL` so that connection assumes that group role. `AD_SYNC_WORKER_DATABASE_ROLE` is fixed to `creative_intelligence_scheduled_worker`; startup rejects worker logins that can assume runtime or application-owner roles. Keep the lease at least 30 seconds longer than `APIFY_TIMEOUT_MS` so validation and persistence can finish after collection. Keep both login passwords outside the repository and environment examples.

### Real PostgreSQL integration suite

`npm run test:postgres` provisions an isolated database and unique login roles, applies all migrations, runs all application queries after assuming the restricted `creative_intelligence_runtime` role, and removes every temporary database and role in `finally`. The suite serializes provisioners with a PostgreSQL advisory lock because the migrations intentionally create four fixed cluster roles.

The harness has fail-closed safety gates:

- it only accepts a loopback TCP address or a local Unix socket;
- the provisioner URL must target the `postgres` maintenance database;
- the connected server address is checked again after connection;
- the provisioner must be a local superuser because PostgreSQL only permits a superuser to create the migration's `BYPASSRLS` helper role;
- it refuses to run if any fixed application role (`creative_intelligence_runtime`, `creative_intelligence_rls_owner`, `creative_intelligence_login_limiter_owner`, or `creative_intelligence_scheduled_worker`) already exists, so it cannot modify an installed application cluster;
- generated databases and login roles always use the `creative_intelligence_test_<random>` prefix.

On a Linux development machine running as root, the harness safely detects the local service through `runuser -u postgres` and creates a short-lived provisioner login. Otherwise, set an explicit local-only provisioner URL:

```bash
export CREATIVE_INTELLIGENCE_TEST_PROVISIONER_URL='postgresql://postgres:LOCAL_TEST_PASSWORD@127.0.0.1:5432/postgres'
npm run test:postgres
```

Use a disposable local PostgreSQL cluster. **Never point this variable at production, staging, a shared server, or a database containing the application roles.** The harness deliberately rejects non-local targets and arbitrary database names.

To run every project gate, including PostgreSQL integration tests:

```bash
npm run check
npm audit --audit-level=low
git diff --check
```

`buildApi` accepts a PostgreSQL-compatible pool, an ID generator, a clock, and an authentication callback. The callback must return a verified user ID; every repository transaction stores it in transaction-local PostgreSQL context, and authorization is enforced both by services and RLS policies.

### Production server

Copy `.env.example` to an ignored `.env`, replace every example credential/key and the OIDC values, then export it before starting the process. Node does not load the file implicitly:

```bash
cp .env.example .env
set -a
. ./.env
set +a
npm start
```

Startup is fail-closed. It validates every bounded runtime setting, constructs the OIDC authenticator, connects to PostgreSQL, and refuses to serve when `current_user` differs from `DATABASE_RUNTIME_ROLE` or has `SUPERUSER`/`BYPASSRLS`. `DATABASE_URL` must use the restricted application login and assume `creative_intelligence_runtime`; never use a provisioning or migration credential.

Creative analysis is opt-in. Set `CREATIVE_ANALYSIS_ENABLED=true`, `GEMINI_API_KEY_FILE` to an absolute protected server-side file, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_CONCURRENCY`, and `CREATIVE_ANALYSIS_DAILY_LIMIT`. The credential is read only by the server and is sent in a request header, never a URL, browser bundle, log, or repository file. Without these settings the API starts normally and the analysis endpoint returns `503`.

For a private single-user staging deployment, the optional `STAGING_*` settings expose `POST /auth/staging-login`. The endpoint verifies a scrypt password hash from a protected file, reserves attempts atomically in PostgreSQL across service instances, bounds active address buckets and concurrent derivations, and returns a short-lived RS256 token plus the server-configured organization ID. Startup exercises the database limiter, signs and verifies a probe token through the configured JWKS, derives the normal issuer-namespaced user ID, and verifies that user is already a member of `STAGING_LOGIN_ORGANIZATION_ID`; missing migration 005, weak/mismatched keys, or missing membership fail before the server listens. It is disabled unless explicitly enabled, never stores or echoes the submitted password, and does not replace production OIDC. `TRUSTED_PROXY_ADDRESSES` must list only the exact reverse-proxy IP addresses that are allowed to supply forwarding headers.

Staging provisioning order:

1. Apply migration `005_staging_login_attempts.sql` with the same local provisioning account used for the earlier migrations.
2. Generate an RSA key with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /etc/creative-intelligence/oidc-private.pem`, export its matching public key as a JWK under `STAGING_LOGIN_KEY_ID`, and publish that JWK at `OIDC_JWKS_URL`. Keep the source root-owned at mode `0600` and deliver it to the non-root service through systemd `LoadCredential=` (the application path should be the service-readable file under `$CREDENTIALS_DIRECTORY`); alternatively, make a dedicated copy owned by the service account at mode `0400`.
3. Create the password hash without putting the password in an argument, URL, environment file, or shell history: read it silently, pipe it to a local Node script that generates a random 16-byte salt and a 32-byte `scryptSync` digest, and write `scrypt-v1$<base64url-salt>$<base64url-digest>` to a protected credential delivered with the same non-root-readable pattern.
4. Derive the member ID exactly as `<OIDC_IDENTITY_NAMESPACE>:base64url(sha256(Buffer.concat([Buffer.from(OIDC_ISSUER), Buffer.from([0]), Buffer.from(STAGING_LOGIN_SUBJECT)])))`; `Buffer.from([0])` is one NUL byte, not the two printable characters backslash and zero. Provision that value in `organization_members` for `STAGING_LOGIN_ORGANIZATION_ID` using a migration/admin connection.
5. Set all `STAGING_LOGIN_*` values from `.env.example`, start the service, and require startup plus a password exchange and protected organization read to succeed.

The simple frontend build requires both `VITE_SIMPLE_LOGIN=true` and an absolute HTTPS `VITE_API_BASE_URL`; its configuration validation fails the build when either is missing or malformed. The organization ID comes from the authenticated server response, preventing a frontend/backend organization mismatch.

Apify ingestion is also fail-closed: all `APIFY_*` settings in `.env.example` are required. `APIFY_API_TOKEN` stays server-side and is sent to the fixed Muppets Actor endpoint only as a Bearer header. `APIFY_AD_COUNT`, response bytes, timeout, country/status filters, and process-wide concurrency are bounded at startup.

Operational endpoints are intentionally unauthenticated and disclose no provider or database details:

- `GET /health/live` — process liveness only; never accesses PostgreSQL;
- `GET /health/ready` — bounded PostgreSQL probe; returns `200 {"status":"ready"}` or sanitized `503 {"status":"not_ready"}`.

When scheduled sync is enabled, startup verifies the separate worker pool before readiness can succeed. Shutdown first stops new polls and waits for in-flight items, then closes Fastify and both pools. Poll/control-plane failures make worker readiness unhealthy; individual provider run failures are recorded and surfaced separately without taking readiness down.

`SIGINT` and `SIGTERM` stop Fastify and close the PostgreSQL pool once. All business routes require an exact OIDC Bearer token; `x-user-id`, cookies, and query parameters are never production authentication sources.

The complete endpoint list and field-level contract are maintained in `docs/API.md` and `docs/openapi.json`.

## Next slices

1. Production OIDC authorization-code + PKCE login after provider selection.
2. External Meta collector adapter after provider selection.
3. Versioned deterministic and AI ad analysis.
4. Brief version history and workflow statuses.
5. Frontend cursor continuation and richer ad-media inspection.

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
- `iteration-map` — covered and missing combinations across audience, market, angle, and format, with bounded deterministic brief evidence and gap-to-brief handoff;
- `organizations` — membership and `admin/member` authorization;
- `persistence` — PostgreSQL repositories, transactional manual imports, and tenant-safe constraints;
- `http` — schema-backed Fastify REST API for organizations, products, competitors, ads, briefs, and Iteration Map;
- `web` — expressive light React workspace for products, competitors, ads, briefs, and Iteration Map coverage;
- `auth` — fail-closed provider-neutral OIDC/JWKS Bearer authentication;
- `media` — SSRF-safe provider fetches, content-addressed durable storage, fenced mirror jobs, and resumable backfill;
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
- AI analysis is a versioned downstream module rather than part of the immutable source record. Competitor Creative Strategy aggregates only the latest completed analysis per ad and reports analysis coverage explicitly.

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

- Apply `migrations/001_initial.sql` through `migrations/017_ai_tag_governance.sql` in numeric order, including `migrations/009_scheduled_provider_sync.sql` and `migrations/011_durable_media_mirror.sql`, to an empty PostgreSQL database. Migrations `002`, `005`, `009`, and `011` must run under a provisioning account allowed to create or normalize roles. The migrations create five fixed cluster roles:

- restricted `creative_intelligence_runtime` for application access;
- non-login `creative_intelligence_rls_owner`, which has only schema usage, membership-table read access, and organization-row lock privileges plus `BYPASSRLS`, solely to own the security-definer policy helpers;
- non-login `creative_intelligence_login_limiter_owner`, which alone owns the bounded staging-login table and security-definer claim/reset functions;
- non-login `creative_intelligence_scheduled_worker`, which can execute only fenced scheduled-sync functions and has no direct tenant-table access;
- non-login `creative_intelligence_media_worker`, which can execute only bounded media claim/finalize/backfill functions and has no direct tenant-table access;
- forced row-level security policies and a database trigger that preserves at least one administrator.

Never grant either owner role to the runtime role or application login. Production API connections must assume `creative_intelligence_runtime` and must not use the migration owner or a superuser. Provision separate logins for scheduled collection and media mirroring; grant each only its matching non-login worker role. Configure them through `AD_SYNC_WORKER_DATABASE_URL` and `MEDIA_MIRROR_WORKER_DATABASE_URL`. Startup rejects worker logins with privileged, unexpected, owner, or direct relation access. Keep collection leases at least 30 seconds longer than `APIFY_TIMEOUT_MS`; media leases must exceed the media fetch timeout by at least 10 seconds. Keep every login password outside the repository and environment examples.

### Real PostgreSQL integration suite

`npm run test:postgres` provisions an isolated database and unique login roles, applies all migrations, runs all application queries after assuming restricted runtime/worker roles, and removes every temporary database and role in `finally`. The suite serializes provisioners with a PostgreSQL advisory lock because the migrations intentionally create five fixed cluster roles.

The harness has fail-closed safety gates:

- it only accepts a loopback TCP address or a local Unix socket;
- the provisioner URL must target the `postgres` maintenance database;
- the connected server address is checked again after connection;
- the provisioner must be a local superuser because PostgreSQL only permits a superuser to create the migration's `BYPASSRLS` helper role;
- it refuses to run if any fixed application role (`creative_intelligence_runtime`, `creative_intelligence_rls_owner`, `creative_intelligence_login_limiter_owner`, `creative_intelligence_scheduled_worker`, or `creative_intelligence_media_worker`) already exists, so it cannot modify an installed application cluster;
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

Creative analysis is opt-in. Set `CREATIVE_ANALYSIS_ENABLED=true`, `GEMINI_API_KEY_FILE` to an absolute protected server-side file, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_CONCURRENCY`, `CREATIVE_ANALYSIS_DAILY_LIMIT`, and the bounded media settings shown in `.env.example`. Analysis uses only checksum-addressed images already verified in the local mirror; it never fetches provider CDN URLs. Video uses an already mirrored poster when available, otherwise the result is explicitly copy-only. The credential is read only by the server and is sent in a request header, never a URL, browser bundle, log, or repository file.

Apply `012_media_grounded_auto_analysis.sql` after migration 011. Durable auto-tagging additionally requires `AUTO_ANALYSIS_ENABLED=true`, the media mirror, and a separate login that can assume only the non-login `creative_intelligence_analysis_worker` role. Startup verifies that role has no table privileges, ownership, `SUPERUSER`, or `BYPASSRLS`; its only application privileges are the bounded claim/begin/finalize functions. Queue work is leased and fenced, retries sanitized categories, counts each model attempt against the tenant UTC-day limit, participates in readiness, and drains during shutdown.

For a private single-user staging deployment, the optional `STAGING_*` settings expose `POST /auth/staging-login`. The endpoint verifies a scrypt password hash from a protected file, reserves attempts atomically in PostgreSQL across service instances, bounds active address buckets and concurrent derivations, and returns a short-lived RS256 token plus the server-configured organization ID. Startup exercises the database limiter, signs and verifies a probe token through the configured JWKS, derives the normal issuer-namespaced user ID, and verifies that user is already a member of `STAGING_LOGIN_ORGANIZATION_ID`; missing migration 005, weak/mismatched keys, or missing membership fail before the server listens. It is disabled unless explicitly enabled, never stores or echoes the submitted password, and does not replace production OIDC. `TRUSTED_PROXY_ADDRESSES` must list only the exact reverse-proxy IP addresses that are allowed to supply forwarding headers.

Staging provisioning order:

1. Apply migration `005_staging_login_attempts.sql` with the same local provisioning account used for the earlier migrations.
2. Generate an RSA key with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /etc/creative-intelligence/oidc-private.pem`, export its matching public key as a JWK under `STAGING_LOGIN_KEY_ID`, and publish that JWK at `OIDC_JWKS_URL`. Keep the source root-owned at mode `0600` and deliver it to the non-root service through systemd `LoadCredential=` (the application path should be the service-readable file under `$CREDENTIALS_DIRECTORY`); alternatively, make a dedicated copy owned by the service account at mode `0400`.
3. Create the password hash without putting the password in an argument, URL, environment file, or shell history: read it silently, pipe it to a local Node script that generates a random 16-byte salt and a 32-byte `scryptSync` digest, and write `scrypt-v1$<base64url-salt>$<base64url-digest>` to a protected credential delivered with the same non-root-readable pattern.
4. Derive the member ID exactly as `<OIDC_IDENTITY_NAMESPACE>:base64url(sha256(Buffer.concat([Buffer.from(OIDC_ISSUER), Buffer.from([0]), Buffer.from(STAGING_LOGIN_SUBJECT)])))`; `Buffer.from([0])` is one NUL byte, not the two printable characters backslash and zero. Provision that value in `organization_members` for `STAGING_LOGIN_ORGANIZATION_ID` using a migration/admin connection.
5. Set all `STAGING_LOGIN_*` values from `.env.example`, start the service, and require startup plus a password exchange and protected organization read to succeed.

The simple frontend build requires both `VITE_SIMPLE_LOGIN=true` and an absolute HTTPS `VITE_API_BASE_URL`; its configuration validation fails the build when either is missing or malformed. The organization ID comes from the authenticated server response, preventing a frontend/backend organization mismatch.

Apify ingestion is also fail-closed: all `APIFY_*` settings in `.env.example` are required. `APIFY_API_TOKEN` stays server-side and is sent to the fixed Muppets Actor endpoint only as a Bearer header. `APIFY_AD_COUNT`, response bytes, timeout, country/status filters, and process-wide concurrency are bounded at startup.

### Durable creative media

Provider image/video URLs remain canonical provenance but are not treated as durable. Migration `011` creates one tenant-scoped ledger row per ad slot and position, so carousel order and duplicate source URLs in different positions remain distinct. Ingestion reconciles jobs transactionally; source changes queue a replacement while retaining the last valid checksum until the replacement succeeds. Claims use database-clock leases, `SKIP LOCKED`, attempts, deterministic retry delays, and fence tokens. Startup backfill scans at most `MEDIA_MIRROR_BACKFILL_BATCH_SIZE` ads per poll and is safe to restart; reconciliation is idempotent.

Enable mirroring only with every `MEDIA_MIRROR_*` value in `.env.example`. `MEDIA_MIRROR_STORAGE_ROOT` must be an absolute dedicated directory on a durable mounted volume; startup creates/probes it and rejects symlinks or unwritable storage. Back up that volume together with PostgreSQL. The store writes immutable SHA-256 objects atomically and deduplicates identical bytes. `GET /media/sha256/{checksum}` serves only validated stored media with immutable caching and `nosniff`; ad responses expose this relative reference only while media serving is enabled, otherwise clients retain canonical provider fallback.

Fetching accepts HTTPS on port 443 only, pins a public DNS result, rejects credentials/fragments/IP literals/private/link-local/loopback/reserved answers (including mixed answer sets), and repeats validation for every redirect. Redirect count, response time, and body bytes are bounded; supported MIME and file magic must agree. Worker logs contain only fixed event/category values, never source URLs or upstream errors.

Provision a dedicated login granted only `creative_intelligence_media_worker`, configure its URL to assume that role, and never share it with the runtime or scheduled collector. To inspect progress as a tenant member, use normal ad reads; operational SQL inspection and retry/reset procedures require an authorized migration/operator connection. Terminal failures retain canonical fallback and any older valid mirror. Increase a job's bounded `max_attempts` or reset it to `queued` only after correcting the categorized cause; do not delete successful blob files while ledger rows reference their checksums.

### Winning Ads Library

Migration `015_winning_ads_library.sql` adds an organization-owned reference library with forced RLS, bounded cursor reads, search/category/source-status filters, optimistic metadata versions, and archive/remove workflows. Saving is idempotent per organization and source ad. It succeeds only when at least one trusted mirror has completed, copies source attribution and ad copy, links checksum-addressed blobs independently of the source ad, and snapshots only the latest already-completed creative-analysis tags and provenance. It does not invoke a model. Blob foreign keys prevent cleanup while a Winning Ad still references the media, including after the source ad is removed.

The slice intentionally contains no unlicensed or unverified system corpus, no arbitrary URL or base64 upload path, and no generation-reference integration because this application has no generation workflow yet. These exclusions do not limit the tenant-owned source-ad library.

### Inspiration Library

Migration `016_inspiration_library.sql` adds organization-owned boards and reusable reference items with forced RLS, bounded search/tag/source/board filters, deterministic sorting, optimistic metadata versions, and archive/remove workflows. Items can be created only from an existing trusted mirrored competitor ad or an unarchived Winning Ad. The service snapshots attribution, copy, and checksum-addressed media so deleting or aging out the source does not break the reference; blob deletion remains restricted while any item points at it.

**Behavior boundary:** Winning Ads is the curated, ad-centric collection and retains performance/source-status context. Inspiration is a working organization layer for visual or strategic patterns: boards, notes, tags, and provenance-backed source snapshots. It does not import the reference product's proprietary technique corpus, uploads, prompts, or media. Arbitrary URL/base64 ingestion and generation references are absent by design; this application has no trusted generation workflow to integrate.

Operational endpoints are intentionally unauthenticated and disclose no provider or database details:

- `GET /health/live` — process liveness only; never accesses PostgreSQL;
- `GET /health/ready` — bounded PostgreSQL probe; returns `200 {"status":"ready"}` or sanitized `503 {"status":"not_ready"}`.

When scheduled sync is enabled, startup verifies the separate worker pool before readiness can succeed. Shutdown first stops new polls and waits for in-flight items, then closes Fastify and both pools. Poll/control-plane failures make worker readiness unhealthy; individual provider run failures are recorded and surfaced separately without taking readiness down.

`SIGINT` and `SIGTERM` stop Fastify and close the PostgreSQL pool once. All business routes require an exact OIDC Bearer token; `x-user-id`, cookies, and query parameters are never production authentication sources.

The complete endpoint list and field-level contract are maintained in `docs/API.md` and `docs/openapi.json`.

## Next slices

1. Production OIDC authorization-code + PKCE login after provider selection.
2. External Meta collector adapter after provider selection.
3. Competitor history and comparison views.

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
- Tenant context is snapshotted and frozen before provider execution; repository batch writes are atomic.
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

Apply `migrations/001_initial.sql`, `migrations/002_tenant_rls.sql`, `migrations/003_provider_sync_limits.sql`, and `migrations/004_provider_sync_limits_rls.sql` in order to an empty PostgreSQL database. Migration `002` must run under a provisioning account allowed to create `BYPASSRLS` roles. The migrations create:

- restricted `creative_intelligence_runtime` for application access;
- non-login `creative_intelligence_rls_owner`, which has only schema usage, membership-table read access, and organization-row lock privileges plus `BYPASSRLS`, solely to own the security-definer policy helpers;
- forced row-level security policies and a database trigger that preserves at least one administrator.

Never grant `creative_intelligence_rls_owner` to the runtime role or application login. Production connections must assume `creative_intelligence_runtime` and must not use the migration owner or a superuser.

### Real PostgreSQL integration suite

`npm run test:postgres` provisions an isolated database and unique login roles, applies all migrations, runs all application queries after assuming the restricted `creative_intelligence_runtime` role, and removes every temporary database and role in `finally`. The suite serializes provisioners with a PostgreSQL advisory lock because migration `002_tenant_rls.sql` intentionally creates two fixed cluster roles.

The harness has fail-closed safety gates:

- it only accepts a loopback TCP address or a local Unix socket;
- the provisioner URL must target the `postgres` maintenance database;
- the connected server address is checked again after connection;
- the provisioner must be a local superuser because PostgreSQL only permits a superuser to create the migration's `BYPASSRLS` helper role;
- it refuses to run if `creative_intelligence_runtime` or `creative_intelligence_rls_owner` already exists, so it cannot modify an installed application cluster;
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

Startup is fail-closed. It validates every bounded runtime setting, constructs only the OIDC authenticator, connects to PostgreSQL, and refuses to serve when `current_user` differs from `DATABASE_RUNTIME_ROLE` or has `SUPERUSER`/`BYPASSRLS`. `DATABASE_URL` must use the restricted application login and assume `creative_intelligence_runtime`; never use a provisioning or migration credential.

Apify ingestion is also fail-closed: all `APIFY_*` settings in `.env.example` are required. `APIFY_API_TOKEN` stays server-side and is sent to the fixed Muppets Actor endpoint only as a Bearer header. `APIFY_AD_COUNT`, response bytes, timeout, country/status filters, and process-wide concurrency are bounded at startup.

Operational endpoints are intentionally unauthenticated and disclose no provider or database details:

- `GET /health/live` — process liveness only; never accesses PostgreSQL;
- `GET /health/ready` — bounded PostgreSQL probe; returns `200 {"status":"ready"}` or sanitized `503 {"status":"not_ready"}`.

`SIGINT` and `SIGTERM` stop Fastify and close the PostgreSQL pool once. All business routes require an exact OIDC Bearer token; `x-user-id`, cookies, and query parameters are never production authentication sources.

The complete endpoint list and field-level contract are maintained in `docs/API.md` and `docs/openapi.json`.

## Next slices

1. Production OIDC authorization-code + PKCE login after provider selection.
2. External Meta collector adapter after provider selection.
3. Versioned deterministic and AI ad analysis.
4. Brief version history and workflow statuses.
5. Frontend cursor continuation and richer ad-media inspection.

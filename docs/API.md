# Creative Intelligence API

The canonical machine-readable contract is [`openapi.json`](./openapi.json). It is generated from the same route schemas Fastify uses at runtime. Edit `src/http/schemas.ts`, then run `npm run generate:openapi`; `npm run check:openapi` fails when the checked-in document is stale.

## Authentication

Every business endpoint requires exactly one HTTP `Authorization` header using the `Bearer <JWT>` scheme. Tokens are validated against the configured OIDC issuer and JWKS, including signature, audience, subject, and temporal claims. Authentication is never accepted from cookies or query parameters.

When explicitly enabled for a private single-user staging deployment, `POST /auth/staging-login` accepts only `{ "password": "..." }` and returns `{ "accessToken": "...", "organizationId": "..." }`. It is unauthenticated by design, uses an atomic PostgreSQL-backed per-address attempt window, caps active address buckets, and separately bounds process derivations. The application never echoes the password or writes it to URLs, cookies, web storage, or logs. The simple-login field uses `autocomplete="new-password"` to discourage browser credential capture and is cleared after every attempt, though browser/password-manager policy remains outside the application's absolute control. The returned bearer token remains only in React memory.

The two operational health endpoints are intentionally unauthenticated and disclose only fixed status values.

## Pagination

Collection endpoints use bounded cursor pagination:

- `limit`: integer from 1 through 100; default 50.
- `cursor`: opaque authenticated continuation value returned as `nextCursor`.
- `includeArchived`: optional boolean only on collections that expose archived resources.

A cursor is bound to its endpoint, tenant, filters, and archive mode. Clients must not parse, modify, or reuse it with different filters. Responses have the form:

```json
{
  "items": [],
  "nextCursor": null
}
```

## Errors

Errors use a fixed JSON envelope:

```json
{ "error": "Invalid request" }
```

Documented statuses include:

- `400` invalid or ambiguous input;
- `401` missing or invalid authentication;
- `403` insufficient organization access;
- `404` resource or route not found;
- `409` conflicting resource state;
- `413` payload too large;
- `415` unsupported media type;
- `429` configured AI-analysis daily limit reached;
- `502` external provider failure;
- `500` sanitized internal failure;
- `503` readiness probe unavailable.

Responses never include token, identity-provider, JWKS, database, SQL, private URL, stack, or credential details.

## Endpoints

### Organizations

- `POST /organizations`
- `POST /organizations/{organizationId}/members`

### Products and competitors

- `POST /organizations/{organizationId}/products`
- `GET /organizations/{organizationId}/products`
- `GET /organizations/{organizationId}/products/{productId}`
- `PATCH /organizations/{organizationId}/products/{productId}` updates one or more product profile fields with the same canonical validation as creation.
- `POST /organizations/{organizationId}/products/{productId}/archive`
- `POST /organizations/{organizationId}/products/{productId}/restore`
- `POST /organizations/{organizationId}/products/{productId}/competitors`
- `GET /organizations/{organizationId}/products/{productId}/competitors`
- `GET /organizations/{organizationId}/products/{productId}/competitors/{competitorId}`

Archiving is non-destructive: products and all descendant competitors, ads, and briefs remain stored. An archived product rejects new competitor creation and provider synchronization. Restoring the product clears only its own `archivedAt`; it does not restore or otherwise change a child's archive state.

### Ads

#### Winning Ads

- `POST /organizations/{organizationId}/winning-ads` saves an existing eligible source ad idempotently; at least one completed trusted mirror is required.
- `GET /organizations/{organizationId}/winning-ads` supports bounded cursors plus `search`, `category`, `active`, and `includeArchived`.
- `GET /organizations/{organizationId}/winning-ads/{winningAdId}` returns copied attribution, copy, immutable mirrored-media references, and completed-analysis provenance when available.
- `PATCH /organizations/{organizationId}/winning-ads/{winningAdId}` requires the exact `expectedVersion` and replaces title, category, and notes.
- `POST /organizations/{organizationId}/winning-ads/{winningAdId}/archive` archives the reference.
- `DELETE /organizations/{organizationId}/winning-ads/{winningAdId}` removes the reference without deleting shared blobs that remain referenced elsewhere.

Only organization members can read or write these records. The save route never fetches an external URL and never runs analysis; it copies only durable trusted mirror checksums and an already-completed latest analysis. There is no system seed corpus, arbitrary URL/base64 upload, or generation-reference endpoint.

- `GET /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule`
- `POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule`
- `PATCH /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule`
- `POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ad-sync-schedule/disable`
- `POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/manual-meta`
- `POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/apify-meta/sync`
- `GET /organizations/{organizationId}/competitors/{competitorId}/ads`
- `GET /organizations/{organizationId}/ads`
- `POST /organizations/{organizationId}/ads/{adId}/bookmark`

The organization ad collection supports `productId`, `competitorId`, `isActive`, `provider`, bounded `search`, latest-analysis `hookCategory`/`angle`/`creativeFormat`, and current-user `bookmarked` filters. `sort` accepts first-seen, last-seen, longest-running, and highest-impression orderings; signed cursors are bound to the complete filter and sort context. Search covers advertiser, headline, description, body, and CTA through PostgreSQL full-text search. AI facets use only the latest completed analysis for each ad.

Bookmarks are durable, tenant-scoped, and private to the authenticated organization member. Setting the same state repeatedly is idempotent. Ad-list responses expose `bookmarked` when discovery state is enabled.

Ad responses include nullable public-library metadata, structured media/card ordering, and nullable impression/spend bounds. Missing provider values remain `null`; they are never converted to zero. When the durable mirror is enabled and a slot has a verified blob, structured entries may add `mirroredUrl`/`mirroredPosterUrl` and legacy media may add the position-aligned `mirroredMediaUrls`; canonical HTTPS provider URLs remain present as provenance and fallback. Mirror references have the immutable form `/media/sha256/<64 lowercase hex>` and never contain source URLs.

All four schedule operations require a tenant administrator; ordinary members and outsiders receive `403`. `GET` and disable return `404` when the exact schedule does not exist. `POST` is a full create-or-replace body with both `intervalSeconds` and `enabled`. `PATCH` is a true partial update: it accepts one or both fields, preserves omitted values atomically, and rejects empty or unknown objects. Enabling a disabled schedule assigns the current administrator and makes it due using the database clock. Disabling through either PATCH or the bodyless disable endpoint atomically cancels and fences active runs. Any body on the disable endpoint, including `{}`, is rejected. A generated ID collision for a schedule is not retried and returns sanitized `409`.

### Analytics and creative analysis

- `GET /organizations/{organizationId}/products/{productId}/analytics/scaling`
- `GET /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/analytics/history?window=7|30|90`
- `POST /organizations/{organizationId}/products/{productId}/analytics/comparison`
- `POST /organizations/{organizationId}/products/{productId}/ads/{adId}/creative-analysis`
- `GET /organizations/{organizationId}/creative-tag-reviews`
- `GET /organizations/{organizationId}/ads/{adId}/creative-tag-review`
- `GET /organizations/{organizationId}/ads/{adId}/creative-tag-review/history`
- `POST /organizations/{organizationId}/ads/{adId}/creative-tag-review`
- `GET /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/creative-strategy`

AI-tag reviews are append-only, tenant-owned decisions against one exact completed analysis ID, analysis version, model fingerprint, ad, and organization. `approved` preserves the raw model tags, `rejected` excludes the analysis from governed downstream tag facets and Creative Strategy, and `corrected` overlays only bounded values from the existing categorical taxonomy. Every response keeps `originalTags` separate from `effectiveTags` and exposes reviewer, timestamp, reason, and review version. Submissions use `expectedReviewVersion` for optimistic concurrency; a stale review or a review of a superseded analysis is reported explicitly and never migrates to a newer analysis. Reviews do not rerun the model or mutate completed model output.

The competitor creative-strategy response uses governed effective tags from only the latest completed, non-rejected analysis per ad. It returns total/ad-analysis coverage and the five most frequent hooks, angles, formats, emotions, personas, offers, and funnel stages; percentages use governed analyzed ads as the denominator. Raw model tags remain available through analysis/review detail. Archived products and competitors are hidden, and PostgreSQL RLS enforces tenant membership.

The scaling, history, and comparison responses are explicitly labeled a **Public Ad Library momentum proxy**. They are not spend, ROAS, revenue, or conversion performance. Reading scaling refreshes one tenant-isolated daily snapshot per competitor. Successful manual and scheduled ingestion also refreshes that same durable daily snapshot grain transactionally from the persisted product state; see `AD_SOURCE_PROVIDER.md` for ingestion snapshot completeness, replay, clock, and atomicity rules.

History reads only existing durable snapshots for one active competitor and never refreshes or infers missing days. `window` defaults to 30 and accepts only 7, 30, or 90 calendar days; rows are newest first. A 7-day trend is returned only when both the latest snapshot and an exact snapshot seven calendar days earlier exist. Active-ad percentage change is `null` when the baseline is zero.

Comparison accepts the strict JSON body `{ "competitorIds": [...] }` with 2–10 unique, explicitly selected active competitors. It preserves request order and returns each competitor's latest durable snapshot plus the same exact-date 7-day trend when available. If any selected competitor is absent, archived, belongs to another product or tenant, or the product is archived, the whole request fails with `404`; invalid cardinality, duplicates, unknown fields, and malformed IDs fail with `400`. PostgreSQL RLS remains the tenant boundary, and every query also includes organization/product predicates.

Creative analysis is versioned and fingerprinted by copy plus deterministic ordered mirrored slots/checksums (not mutable timestamps). The response exposes `provenance` (`manual` or `automatic`), `analysisMode` (`media` or `copy_only`), and `mediaCount`. Manual requests and durable automatic jobs share the same cache identity. `copy_only` explicitly means no trusted visual media was analyzed; it never reports on-screen text or pretends to have viewed video. Only bounded immutable local mirror bytes with an allowlisted image MIME are sent inline to Gemini. Output is validated against the fixed taxonomy, the current version is deduplicated, and the endpoint is disabled with `503` unless the server-side model credential is configured. Provider media URLs are never fetched by analysis.

### Briefs and Iteration Map

- `POST /organizations/{organizationId}/products/{productId}/briefs`
- `POST /organizations/{organizationId}/products/{productId}/briefs/from-ad`
- `POST /organizations/{organizationId}/products/{productId}/briefs/from-ad/ai`
- `GET /organizations/{organizationId}/products/{productId}/briefs`
- `GET /organizations/{organizationId}/briefs/{briefId}`
- `GET /organizations/{organizationId}/briefs/{briefId}/handoff`
- `POST /organizations/{organizationId}/products/{productId}/iteration-map/analyze`

AI brief creation first obtains the existing versioned, media-grounded creative analysis, then persists a structured strategy, art direction, narrative, shot list, deliverables, and analysis provenance in the same optimistic-concurrency brief workflow. The handoff endpoint renders the current immutable revision as a downloadable Markdown production document; it is unavailable for briefs without structured production details.

Request and response field limits, enums, required properties, and exact response schemas are defined in `openapi.json`. Text limits count Unicode code points. Provider URLs use the custom `canonical-https-url` format, which applies the service's bounded WHATWG HTTPS validation. Manual-ad input dates use `parseable-javascript-date` and are normalized to the canonical `canonical-javascript-timestamp` format returned by the API. Iteration Map axes use the `x-maxCartesianProduct` extension to enforce the documented 10,000-combination cap after normalization and de-duplication.

Iteration Map cells contain only persisted brief evidence: ID, canonical title, and workflow status. `briefCount` is the observed active-brief count for the exact normalized combination; `briefs` is a deterministic creation-time/ID ordered preview capped at 25, and `hasMoreBriefs` states when that preview is truncated. No field is a performance, generation, or inferred outcome metric. Archived briefs remain excluded, reads retain the 10,000-active-brief overflow probe, and the response preserves the normalized Cartesian order.

## Operational endpoints

- `GET /health/live` returns `200 {"status":"ok"}` and never accesses PostgreSQL.
- `GET /health/ready` returns `200 {"status":"ready"}` or `503 {"status":"not_ready"}` after a bounded, isolated PostgreSQL probe.
- `GET /media/sha256/{checksum}` is available only when durable mirroring is enabled. It serves validated content-addressed bytes with immutable caching, `nosniff`, and a restrictive content policy, or a fixed `404` response. The checksum reference is a capability URL and must not be logged or expanded with provider query data.

With scheduled synchronization enabled, worker readiness also requires a successful control-plane poll. Per-item provider/business failures are durably finalized and surfaced as a separate sanitized run-failure signal; they do not make worker readiness unhealthy. Shutdown stops polling, waits for in-flight runs, and then closes the dedicated worker pool.
## Inspiration

Authenticated organization members can create/list boards and create references from trusted local sources with `POST /organizations/{organizationId}/inspiration/boards/{boardId}/items`. `sourceKind` is strictly `competitor_ad` or `winning_ad`; source media must already exist in the local checksum-addressed mirror. List/detail routes are bounded and support board, full-text, tag, source-kind, archive, and sort controls. Metadata updates require `expectedVersion`; archive and hard remove are separate operations. There is no external URL, base64 upload, seed, or generation endpoint.

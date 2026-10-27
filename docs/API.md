# Creative Intelligence API

The canonical machine-readable contract is [`openapi.json`](./openapi.json). It is generated from the same route schemas Fastify uses at runtime. Edit `src/http/schemas.ts`, then run `npm run generate:openapi`; `npm run check:openapi` fails when the checked-in document is stale.

## Authentication

Every business endpoint requires exactly one HTTP `Authorization` header using the `Bearer <JWT>` scheme. Tokens are validated against the configured OIDC issuer and JWKS, including signature, audience, subject, and temporal claims. Authentication is never accepted from cookies or query parameters.

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
- `POST /organizations/{organizationId}/products/{productId}/competitors`
- `GET /organizations/{organizationId}/products/{productId}/competitors`
- `GET /organizations/{organizationId}/products/{productId}/competitors/{competitorId}`

### Ads

- `POST /organizations/{organizationId}/products/{productId}/competitors/{competitorId}/ads/manual-meta`
- `GET /organizations/{organizationId}/competitors/{competitorId}/ads`
- `GET /organizations/{organizationId}/ads`

The organization ad collection supports `productId`, `competitorId`, `isActive`, and `provider` filters.

### Briefs and Iteration Map

- `POST /organizations/{organizationId}/products/{productId}/briefs`
- `POST /organizations/{organizationId}/products/{productId}/briefs/from-ad`
- `GET /organizations/{organizationId}/products/{productId}/briefs`
- `GET /organizations/{organizationId}/briefs/{briefId}`
- `POST /organizations/{organizationId}/products/{productId}/iteration-map/analyze`

Request and response field limits, enums, required properties, and exact response schemas are defined in `openapi.json`. Text limits count Unicode code points. Provider URLs use the custom `canonical-https-url` format, which applies the service's bounded WHATWG HTTPS validation. Manual-ad input dates use `parseable-javascript-date` and are normalized to the canonical `canonical-javascript-timestamp` format returned by the API. Iteration Map axes use the `x-maxCartesianProduct` extension to enforce the documented 10,000-combination cap after normalization and de-duplication.

## Operational endpoints

- `GET /health/live` returns `200 {"status":"ok"}` and never accesses PostgreSQL.
- `GET /health/ready` returns `200 {"status":"ready"}` or `503 {"status":"not_ready"}` after a bounded, isolated PostgreSQL probe.

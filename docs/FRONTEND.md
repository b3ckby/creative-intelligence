# Frontend MVP

The browser workspace is a Vite/React client for the existing OpenAPI contract. Its primary interaction model is **Operate**: select a product, inspect competitors and ads, create grounded briefs, then analyze Iteration Map coverage.

## Surfaces

- **Products** — product context, competitive metrics, and current signals.
- **Competitors** — tracked competitive set and canonical source links.
- **Ad Library** — product, competitor, status, date, and media-format filtering; structured creative media; expanded nullable public-library metadata; source inspection; brief creation and on-demand versioned creative analysis. Media from an explicit Meta-host allowlist loads automatically; other HTTPS media remains inert, preventing browser requests to provider-controlled private or arbitrary hosts. Approved third-party media hosts still receive ordinary browser network metadata. The initial AI analysis never server-fetches external media URLs.
- **Analytics** — an explicitly labeled public-library momentum proxy with launch velocity, long-running creatives, format mix, and daily tenant-isolated snapshots.
- **Brief Builder** — manual briefs and briefs grounded in source ads.
- **Iteration Map** — audience × market × angle × format coverage and gaps.

The default connection screen accepts an API base URL, organization ID, and OIDC bearer token. The optional staging build mode requires `VITE_SIMPLE_LOGIN=true` and an absolute HTTPS `VITE_API_BASE_URL`; the build fails closed when either value is missing or malformed. It shows only a password field, and `/auth/staging-login` returns the server-configured organization ID together with the token. The application clears the password after every attempt, marks it `autocomplete="new-password"` to discourage credential capture, and never writes it to web storage, URLs, cookies, or logs. Browser/password-manager policy is ultimately outside the application's control. In both modes, the bearer token stays only in React memory. The manual-mode non-secret API URL and organization ID are remembered locally.

## Commands

```bash
npm run dev:web
npm run test:web
npm run typecheck:web
npm run build:web
npm run preview:web
```

The production artifact is written to `dist/web/`. `npm run check` runs frontend type checking, browser-unit tests, and a production build in addition to all API and PostgreSQL gates.

## Local and production topology

For local development, start the API on `http://127.0.0.1:3000` and leave the API URL blank. `npm run dev:web` proxies `/organizations`, `/auth`, and `/health` to that loopback origin, so bearer requests remain same-origin in the browser and require no permissive CORS policy. To use another local API origin, set `CREATIVE_INTELLIGENCE_DEV_API_URL` before starting Vite; the target must remain trusted because it receives bearer credentials.

For production, serve `dist/web/` and the API behind the same HTTPS origin whenever possible. Manual mode may leave the API base URL blank in that topology; simple-login builds still provide the absolute same-origin API path through `VITE_API_BASE_URL`. If the frontend and API use different origins, configure a narrow CORS policy at the trusted edge; never use a wildcard origin with bearer authentication.

The frontend does not implement an identity-provider login redirect yet because no production OIDC provider/client has been selected. It consumes a valid bearer token without persisting it. Provider-specific authorization-code + PKCE belongs in the deployment/authentication slice once issuer, client ID, redirect URI, and logout behavior are fixed.

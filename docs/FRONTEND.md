# Frontend MVP

The browser workspace is a Vite/React client for the existing OpenAPI contract. Its primary interaction model is **Operate**: select a product, inspect competitors and ads, create grounded briefs, then analyze Iteration Map coverage.

## Surfaces

- **Products** — product context, competitive metrics, and current signals.
- **Competitors** — tracked competitive set, canonical source links, and an on-demand Creative Strategy rollup showing top analyzed hooks, angles, formats, emotions, personas, offers, funnel stages, and coverage.
- **Ad Library** — server-side full-text search; product, competitor, status, governed effective AI hook/angle/format, private bookmark, date, and media-format filtering; first/last seen, lifespan, and impression sorting; durable save/remove actions; structured creative media; expanded nullable public-library metadata; source inspection; brief creation and versioned creative analysis. Analysis metadata states whether it was manual or auto-tagged and whether it used a bounded count of mirrored assets or an explicit copy-only fallback. When the durable mirror is enabled, the UI prefers same-origin immutable `/media/sha256/...` references in exact structured/card order and falls back to the canonical provider URL until a replacement succeeds. Without a mirror, media from an explicit Meta-host allowlist loads automatically; other HTTPS media remains inert, preventing browser requests to provider-controlled private or arbitrary hosts. Approved third-party media hosts still receive ordinary browser network metadata. The initial AI analysis never server-fetches external media URLs.
- **AI review** — a bounded product queue for pending, approved, rejected, and corrected analyses. Review detail identifies the exact analysis version and fingerprint, compares immutable raw model tags with governed effective tags, shows append-only reviewer/time/reason history, and provides accessible approve/reject/correct controls. Corrections are limited to the existing taxonomy. Loading, error, empty, submission-conflict, and stale-analysis states remain explicit; stale decisions never apply to a newer model analysis.
- **Winning Ads** — a light, organization-private reference surface for eligible Ad Library creatives. Save actions appear only after a trusted mirror succeeds; unavailable mirror and analysis states remain explicit. Cards use same-origin checksum media, copied source attribution, categories, completed-analysis tags/provenance, search and source-status filters, optimistic metadata editing, and remove actions. No unlicensed system corpus, arbitrary URL/base64 upload, or generation-reference workflow is exposed.
- **Analytics** — an explicitly labeled public-library momentum proxy with the existing scaling leaderboard, 7/30/90-day durable history for one active competitor, and an explicit 2–10 competitor side-by-side comparison. History and comparison show latest observed counts, scores, format signals, and exact-date seven-day changes only; missing snapshots stay visibly missing. These are public-library activity proxies, never inferred spend or revenue.
- **Brief Builder** — manual and source-ad briefs plus AI production briefs derived from the latest grounded creative analysis. Structured strategy, art direction, narrative, deliverables, and shot lists remain in version history; a current revision can be previewed and downloaded as a Markdown production handoff.
- **Iteration Map** — audience × market × angle × format coverage and gaps, with explicit progress, covered/gap slicing, 24-cell incremental rendering, and a bounded 25-brief evidence preview per covered cell. Each evidence row shows only the persisted title and workflow status. A gap opens the existing manual brief form with all four dimensions prefilled; it does not generate creative or claim performance. Loading, failure, empty-filter, and truncated-evidence states are explicit.

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

For local development, start the API on `http://127.0.0.1:3000` and leave the API URL blank. `npm run dev:web` proxies `/organizations`, `/auth`, `/health`, and `/media` to that loopback origin, so bearer requests and mirrored creative bytes remain same-origin in the browser and require no permissive CORS policy. To use another local API origin, set `CREATIVE_INTELLIGENCE_DEV_API_URL` before starting Vite; the target must remain trusted because it receives bearer credentials.

For production, serve `dist/web/` and the API behind the same HTTPS origin whenever possible. Manual mode may leave the API base URL blank in that topology; simple-login builds still provide the absolute same-origin API path through `VITE_API_BASE_URL`. If the frontend and API use different origins, configure a narrow CORS policy at the trusted edge; never use a wildcard origin with bearer authentication.

The frontend does not implement an identity-provider login redirect yet because no production OIDC provider/client has been selected. It consumes a valid bearer token without persisting it. Provider-specific authorization-code + PKCE belongs in the deployment/authentication slice once issuer, client ID, redirect URI, and logout behavior are fixed.
## Inspiration Library

The Workspace `Inspiration` surface is an expressive light reference desk rather than another performance gallery. It exposes board/search/sort controls, trusted mirrored source candidates, provenance on every card, notes/tags, safe local image/video references, and explicit loading/error/empty/unavailable states. Winning Ads remains the curated ad library; Inspiration organizes reusable patterns for later creative work.

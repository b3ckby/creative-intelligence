# Inspiration Library RED → GREEN evidence

Date: 2026-10-28

## Behavioral boundary

Winning Ads remains the curated, ad-centric library with source status, category, and captured analysis context. Inspiration is the organization layer for reusable visual and strategic references: tenant-owned boards, working titles, notes, tags, provenance, and durable source snapshots. Inspiration accepts only existing trusted mirrored `competitor_ad` or `winning_ad` records. It has no arbitrary URL/base64 ingestion, scraping, proprietary seed corpus, model-generated analysis, prompt import, or generation-reference workflow.

The reference tree was inspected only for observable behavior. No source implementation, prompts, branding, media, datasets, credentials, or proprietary copy were reused.

## Observed RED → GREEN cycles

| Vertical behavior | RED evidence | GREEN evidence |
| --- | --- | --- |
| Migration, ownership, durable media, RLS | `npx tsx --test tests/inspiration-library-migration.test.ts` exited 1 before migration 016 existed. | Same focused command exited 0 after `016_inspiration_library.sql`. |
| Repository behavior | `npx tsx --test tests/inspiration-library-repository.test.ts` exited 1 before Inspiration domain/repository symbols existed. | Same focused command exited 0 after tenant-scoped repository implementation. |
| Fastify/OpenAPI surface | `npx tsx --test tests/inspiration-library-api.test.ts` exited 1 while Inspiration route contracts were absent. | Same focused command exited 0 after strict routes/contracts and handlers. |
| Strict browser decoder/client | `npm run test:web -- --run web/src/api.test.ts` exited 1 before Inspiration browser types, decoders, and methods existed. | Same focused command exited 0 after exact-object response decoding and bounded request methods. |
| Real PostgreSQL, FORCE RLS, durable snapshots | `npx tsx --test --test-concurrency=1 tests/postgres/inspiration-library.integration.test.ts` exited 1 before migration 016 was loaded and while initial SQL expressions were incompatible with PostgreSQL. | Same focused command exited 0 after loading migration 016 and using PostgreSQL-safe constraints/index expressions. |
| Workspace library | Focused `Workspace.test.tsx` Inspiration test exited 1 before the surface existed. | Focused test exited 0 after navigation, filters, provenance cards, mirrored media, and explicit states were added. |
| Trusted add workflow | Expanded Workspace test exited 1 before add candidates were wired. | Focused test exited 0 after trusted mirrored competitor-ad candidates called `createInspirationItem`. |
| First-board bootstrap | `npm run test:web -- --run web/src/Workspace.test.tsx -t "creates the first Inspiration board"` failed: `Unable to find a label with the text of: Board name`. | Same command passed after adding the in-Workspace board form and state update. |
| Winning Ad source workflow | `npm run test:web -- --run web/src/Workspace.test.tsx -t "organizes trusted ad references"` failed: no `Add Winning Ad Orbit launch reference to Launch worlds` button. | Combined focused run passed 2 tests after loading trusted Winning Ads and exposing them as Inspiration candidates. |
| Multi-board destination | Focused Workspace test failed because selecting `Proof systems` still left only `Add Orbit to Launch worlds`. | The focused three-test Inspiration UI run passed after candidate actions resolved and persisted to the selected board. |
| Generated contract coverage | `npm run check` initially failed because the exact OpenAPI route inventory and real-PostgreSQL table/RLS inventory did not include Inspiration. | OpenAPI contract test and PostgreSQL RLS inventory passed after the route/table updates. |
| UTC boundary regression exposed by full check | Full `npm run check` later failed in `competitor-analytics.integration.test.ts` with `2 !== 1` when PostgreSQL `current_date` and the service's UTC date crossed different calendar days. | The focused real-PostgreSQL test passed after its fixture used the same explicit UTC date semantics as production; the complete check then passed. |

## Final verification

- `npm run generate:openapi`: passed; `docs/openapi.json` regenerated.
- `npm run check`: passed, including 313 unit tests, 79 web tests, 66 real-PostgreSQL tests, strict backend/web type checks, OpenAPI drift check, and production web build (458 tests total).
- `npm audit --audit-level=low`: passed, 0 vulnerabilities.
- `git diff --check`: passed.
- Secret-pattern review found only explicit test fixtures in pre-existing authentication/provider tests; no Inspiration secrets or credentials were added.
- No commit was created.

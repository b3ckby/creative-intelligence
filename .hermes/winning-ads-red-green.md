# Winning Ads RED → GREEN evidence

Observed in this working session:

| Slice | RED command and expected failure | GREEN command and result |
|---|---|---|
| Migration 015 contract | `npm run test:unit -- --test-name-pattern='migration 015'` → 1 failed: `ENOENT ... migrations/015_winning_ads_library.sql` | `npx tsx --test tests/winning-ads-migration.test.ts` → 1/1 passed |
| Repository optimistic update | `npx tsx --test tests/winning-ads-migration.test.ts tests/winning-ads-repository.test.ts` → 3 passed, 1 failed: update SQL did not satisfy strict version predicate contract | same focused command after fix → 4/4 passed (later combined focused suite 6/6) |
| Strict API/OpenAPI routes | `npx tsx --test tests/winning-ads-api.test.ts` → 2/2 failed: no Winning Ads operations and route returned 404 instead of schema 400 | focused API/migration/repository suite → 6/6 passed; OpenAPI focused suite → 11/11 passed |
| Strict browser decoder/client | `npm run test:web` → 1 failed: `client.listWinningAds is not a function` | `npm run test:web` → 4 files, 75/75 passed |
| Workspace UI | `npm run test:web` → missing `Save Orbit to Winning Ads`, then missing `WinningAdsSurface`; the final UI assertion also exposed duplicate lowercase category text | `npx vitest run --config vite.config.ts web/src/Workspace.test.tsx` → 48/48 passed |
| Real PostgreSQL/RLS and durable media | `npx tsx --test --test-concurrency=1 tests/postgres/winning-ads.integration.test.ts` → 2/2 failed: runtime lacked the narrowly required blob metadata SELECT | same command after migration grant → 2/2 passed; combined RLS shard → 14/14 passed |

Final verification:

- `npm run generate:openapi` → exit 0; regenerated `docs/openapi.json` from the shared contracts.
- `npm run check` → exit 0; unit 306/306, web 75/75, PostgreSQL integration 65/65; OpenAPI drift, both typechecks, and production web build passed.
- `git diff --check` → passed with no output.
- No commit was created.

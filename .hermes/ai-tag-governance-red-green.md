# Roadmap 9 — AI-tag human review/governance RED→GREEN evidence

## Behavior boundary

Roadmap point 9 adds tenant-owned human governance for existing completed creative analyses. Model output, identity, version, fingerprint, and provenance remain immutable. Human decisions are append-only review versions tied to the exact organization, ad, analysis version, and input fingerprint. The bounded decisions are `approved`, `rejected`, and `corrected`; `pending` is a derived queue state. Corrections may change only the existing categorical hook, angle, format, offer-frame, and funnel-stage taxonomy. Raw tags and governed effective tags are returned separately.

Ordinary organization members may review because existing product write policy permits member-owned creative workflow changes; reviewer identity is always derived from verified authentication context. PostgreSQL FORCE RLS and exact ownership predicates fail closed across tenants. A review of an older analysis remains attached to that analysis, is marked stale when a newer completed analysis exists, and never governs the newer analysis.

Governed downstream behavior is deliberately narrow: Ad Library tag facets and Creative Strategy use effective tags from the latest completed analysis; rejected analyses are excluded. Raw model output remains available in analysis and AI-review detail. Review never reruns the model and makes no performance claim.

## Observed RED→GREEN cycles

1. **Migration contract**
   - RED: `npx tsx --test tests/ai-tag-governance-migration.test.ts` exited 1 before migration 017 existed.
   - GREEN: after `migrations/017_ai_tag_governance.sql`, the focused suite passed. A real-PostgreSQL run then exposed unsupported `jsonb_object_length`; the migration contract was kept RED while the constraint was replaced with PostgreSQL-supported JSONPath key counting.
   - GREEN verification: `npx tsx --test tests/ai-tag-governance-migration.test.ts` — 2/2 passed.

2. **Domain/repository workflow**
   - RED: `npx tsx --test tests/ai-tag-governance-repository.test.ts` exited 1 before review validation and persistence existed.
   - GREEN: bounded taxonomy validation, exact-identity append, verified reviewer provenance, and optimistic review-version conflicts passed — 3/3.

3. **Fastify/OpenAPI API**
   - RED: `npx tsx --test tests/ai-tag-governance-api.test.ts` exited 1 before routes/contracts existed.
   - GREEN: bounded list/detail/history and strict submit routes passed — 2/2.

4. **Strict browser client**
   - RED: `npm run test:web -- --run web/src/api.test.ts` exited 1 before governance types, methods, and cross-field decoders existed.
   - GREEN: strict analysis/review identity, original/effective-tag consistency, status, stale, and provenance decoding passed in the focused web API suite.

5. **Workspace queue/review flow**
   - RED: `npm run test:web -- --run web/src/Workspace.test.tsx` exited 1 when only the new navigation boundary existed.
   - GREEN: queue filters, exact-analysis selection, raw/effective comparison, decision/correction controls, provenance history, and loading/error/empty/stale/conflict presentation passed.

6. **Governed downstream tags**
   - RED: `npx tsx --test tests/postgres-ad-discovery.test.ts tests/postgres-creative-strategy.test.ts` exited 1 after tests required effective corrections and rejected-analysis exclusion.
   - GREEN: both focused suites passed after the catalog facets and strategy aggregation used latest append-only review state without changing raw analysis rows — 3/3 tests.

7. **Real PostgreSQL invariants**
   - RED: `npx tsx --test --test-concurrency=1 tests/postgres/ai-tag-governance.integration.test.ts` first exited 1 because migration 017 was absent from the real harness, then exposed the unsupported JSONB function in the migration.
   - GREEN: after adding migration 017 to the harness and correcting the constraint, 1/1 passed, exercising completed-analysis UPDATE/DELETE rejection, append-only review versions, exact history, stale detection, and cross-tenant denial under restricted runtime roles.

## Focused GREEN evidence

- `npm run generate:openapi` completed.
- Governance/backend/downstream focused run: 10/10 tests passed.
- `npm run test:web -- --run web/src/api.test.ts web/src/Workspace.test.tsx`: 2 files, 77/77 tests passed.
- `npm run typecheck`: passed.
- `npm run typecheck:web`: passed.
- Real PostgreSQL governance integration: 1/1 passed.

## Final verification

- `npm run check`: passed end to end.
  - OpenAPI drift check: passed.
  - Backend TypeScript: passed.
  - Browser TypeScript: passed.
  - Unit/HTTP/migration suites: 321/321 passed.
  - Browser suites: 4 files, 83/83 passed.
  - Production web build: passed (19 modules transformed).
  - Real PostgreSQL suites: 67/67 passed, including immutable analysis history, governance RLS/provenance, effective-tag discovery, strategy aggregation, and legacy lease behavior adapted to append-only completion.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Added-line security scan: no hardcoded-secret, shell-injection, eval/exec, unsafe-deserialization, or SQL-interpolation pattern matches.
- `git diff --check`: passed.
- Generated `docs/openapi.json` matches the shared Fastify contract registry.
- Fresh fail-closed self-review covered audit-history integrity, exact identity and reviewer derivation, FORCE RLS/cross-tenant behavior, stale-analysis scoping, and raw/effective transparency; no blocking finding remained. External CLI reviewer attempts were unavailable (`codex` and `opencode` not installed; Claude Code authentication expired), so no external-agent approval is claimed.
- No commit was created; `HEAD` remains `35fbd94` (`[verified] feat: capture analytics during ad ingestion`).

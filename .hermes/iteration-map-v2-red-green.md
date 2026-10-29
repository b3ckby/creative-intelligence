# Iteration Map v2 — audit and RED→GREEN evidence

## Clean-room behavior boundary

Target audited at `HEAD + the intentionally dirty working tree`. The read-only reference boundary was `/root/.hermes/profiles/teacher/cache/scratch/muppets-audit/muppets`, inspected through its actual Iteration Map page, store tests, and brief-creation route. Observable reference behaviors considered were reordered/sliced planning views, bounded gap display, brief evidence/status, explicit loading/error/empty states, and gap-to-brief handoff. No reference code, data, prompts, assets, branding, credentials, or generated content was copied.

The target-native boundary remains the existing four normalized axes (audience, market, angle, format), active tenant-owned briefs, the existing `POST .../iteration-map/analyze` endpoint, and the existing manual brief/versioned production-handoff workflow. This slice deliberately adds no durable entity, generation system, saved view, proxy performance metric, Inspiration behavior, or Winning Ads behavior.

Implemented boundary:

- covered cells expose persisted brief ID/title/status evidence only;
- evidence is deterministic (`created_at`, then ID) and capped at 25 rows per cell while preserving `briefCount` and an explicit `hasMoreBriefs` flag;
- active-brief overflow remains capped at 10,000 and Cartesian products remain capped at 10,000 after the existing fail-closed normalization/de-duplication;
- the browser can slice covered/gap/all cells and renders at most 24 cells before explicit incremental expansion;
- gap actions open the existing manual brief form with all four normalized dimensions prefilled;
- analysis loading, failure, no-filter-match, percentage progress, evidence truncation, and workflow status are explicit;
- no count or status is presented as observed creative performance.

## Vertical RED→GREEN record

### 1. Domain and bounded evidence

RED:

```text
npx tsx --test tests/iteration-map.test.ts
```

Expected failure observed: 3 failures because `briefs`, `briefCount`, and `hasMoreBriefs` did not exist (`TypeError`/`undefined !== 27`); 2 existing tests passed.

GREEN:

```text
npx tsx --test tests/iteration-map.test.ts
```

Observed: 5/5 passed, including deterministic evidence order and the 25-of-27 bounded preview.

### 2. Repository/API/OpenAPI serialization

RED:

```text
npx tsx --test --test-name-pattern='Iteration Map endpoint' tests/product-flow-rest.test.ts
```

Expected failure observed: response serializer omitted `briefs`; the enriched response assertion received `undefined`.

GREEN:

```text
npx tsx --test --test-name-pattern='Iteration Map endpoint' tests/product-flow-rest.test.ts
```

Observed: 1/1 passed after the repository selected only ID/title/status/dimensions and the strict shared response schema declared bounded evidence.

### 3. Strict web decoder

RED:

```text
npx vitest run --config vite.config.ts web/src/api.test.ts -t 'strictly decodes bounded Iteration Map'
```

Expected failure observed: the old exact decoder rejected the enriched payload with the fixed 502 invalid-response error.

GREEN:

```text
npx vitest run --config vite.config.ts web/src/api.test.ts -t 'strictly decodes bounded Iteration Map'
```

Observed: 1/1 passed. The decoder now rejects unknown shape, invalid status/cardinality, evidence/ID order mismatch, count mismatch, incorrect truncation flags, covered cells with zero evidence, missing cells with evidence, and map-total mismatch.

### 4. Workspace evidence and gap-to-brief action

RED:

```text
npx vitest run --config vite.config.ts web/src/Workspace.test.tsx -t 'shows bounded brief evidence'
```

Expected failure observed: no `50% covered` progress text or evidence/gap actions existed.

GREEN:

```text
npx vitest run --config vite.config.ts web/src/Workspace.test.tsx -t 'shows bounded brief evidence'
```

Observed: 1/1 passed. The test expands persisted title/status evidence and verifies that the existing dialog receives all four gap dimensions.

## Focused regression

```text
npm run generate:openapi
npm run check:openapi
npm run typecheck
npm run typecheck:web
npx tsx --test tests/iteration-map.test.ts tests/postgres-iteration-map.test.ts tests/product-flow-rest.test.ts
npx vitest run --config vite.config.ts web/src/api.test.ts web/src/Workspace.test.tsx
```

Observed: OpenAPI generation/drift check and both typechecks passed; 26/26 focused Node tests and 75/75 focused web tests passed.

## Full verification

```text
npm run check
```

Observed:

- OpenAPI drift check: passed;
- server typecheck: passed;
- web typecheck: passed;
- unit tests: 314/314 passed;
- web tests: 81/81 passed;
- production web build: passed (19 modules transformed);
- real PostgreSQL integration tests: 66/66 passed, including tenant-safe brief/Iteration Map analysis and migration/RLS suites;
- total automated tests in the full gate: 461 passed, 0 failed.

Additional gates:

```text
npm audit --audit-level=low
# found 0 vulnerabilities

git diff --check
# exit 0, no output
```

No migration was added because saved map state was not necessary for this bounded target-native slice; consequently there is no new durable ownership/RLS surface. No commit was created.

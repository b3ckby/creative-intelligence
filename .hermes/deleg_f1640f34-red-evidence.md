# deleg_f1640f34 RED evidence

All commands were run before the corresponding production change.

## Catalog/ad canonical validation and round-trip

Command: `npx tsx --test tests/write-roundtrip-validation.test.ts`

Result: **RED** — 2 tests, 1 pass, 1 fail. `catalog and ad writes reject values that persisted decoders cannot read` expected HTTP 400 but a product name containing a newline was accepted with HTTP 201. This isolates write validation as less strict than persisted decoding. The companion valid round-trip test passed.

## Brief validation alignment

Command: `npx tsx --test --test-name-pattern='brief writes reject' tests/write-roundtrip-validation.test.ts`

Result: **RED** — 1 test, 0 pass, 1 fail. A decoder-incompatible manual brief write returned HTTP 500 instead of the fixed typed HTTP 400, reproducing the insert-then-decode failure path (including the 101-character CTA case in the test table).

## Pre-parse bounded JSON inspection

Command: `npx tsx --test tests/strict-json.test.ts`

Result: **RED** — 4 tests, 2 pass, 2 fail. The native `JSON.parse` spy observed one call before depth rejection and three calls during decoded duplicate/dangerous-key rejection. The 800,004-byte adversarial depth body was rejected in 96.5ms, providing the practical linear-time guard baseline.

## Bounded organization-member mutation reads

Command: `npx tsx --test tests/postgres-organization-bounded.test.ts`

Result: **RED** — 1 test, 0 pass, 1 fail with the exact offending SQL: `select user_id, role from organization_members where organization_id = $1`. This proves each mutation materialized the complete membership set.

## Non-HTTP write normalization

Command: `npx tsx --test --test-name-pattern='non-HTTP write paths' tests/write-roundtrip-validation.test.ts`

Result: **RED** — 1 test, 0 pass, 1 fail because the in-memory product service accepted a newline-bearing name. This isolates duplicated service-level normalization that bypassed the canonical persisted constraints.

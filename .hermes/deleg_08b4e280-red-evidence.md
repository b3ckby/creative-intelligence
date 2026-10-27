# deleg_08b4e280 RED evidence

Focused failures were captured before the corresponding final production state:

- Strict JSON parser: `npx tsx --test --test-name-pattern='standards-conforming' tests/blocking-findings.test.ts` — RED: trailing garbage body returned 201 instead of 400.
- Authenticated canonical cursors: `npx tsx --test --test-name-pattern='authenticate canonical payload' tests/blocking-findings.test.ts` — RED: legacy cursor had no signature segment; later canonical-base64 regression RED showed an alternate signature encoding was accepted (`Missing expected exception`).
- Archive matrix / active competitor: `npx tsx --test --test-name-pattern='archive matrix' tests/blocking-findings.test.ts` — RED: brief list under archived product returned 400 instead of a hidden empty page; after that slice, from-ad under archived competitor returned 500 instead of fixed 400 until the active competitor query was corrected.
- Persisted brief rows: `npx tsx --test --test-name-pattern='persisted brief scalar' tests/postgres-briefs.test.ts` — RED: corrupt scalar rows did not throw.
- Persisted iteration rows: `npx tsx --test --test-name-pattern='iteration-map rejects corrupted' tests/postgres-iteration-map.test.ts` — RED: whitespace-corrupt stored brief ID was accepted.
- Persisted catalog rows: `npx tsx --test --test-name-pattern='catalog row decoders reject' tests/blocking-findings.test.ts` — RED: whitespace identifiers / invalid URL and array invariants were accepted.
- Archive/write concurrency: with all new `FOR SHARE` clauses temporarily absent, `npx tsx --test --test-concurrency=1 --test-name-pattern='serializes archive races against' tests/postgres/blocking-findings.integration.test.ts` — RED: `write did not wait for the archive transaction` (`true !== false`). Restoring the locks made the same focused test GREEN.

Final focused and full-suite evidence is reported in the task summary.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../migrations/014_ai_briefs_production_handoff.sql', import.meta.url)

test('migration 014 versions structured AI brief details for production handoff', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /ALTER TABLE creative_briefs[\s\S]*ADD COLUMN details jsonb/u)
  assert.match(sql, /ALTER TABLE creative_brief_versions[\s\S]*ADD COLUMN details jsonb/u)
  assert.match(sql, /jsonb_typeof\(details\) = 'object'/u)
  assert.match(sql, /creative_brief_versions_details_object/u)
})

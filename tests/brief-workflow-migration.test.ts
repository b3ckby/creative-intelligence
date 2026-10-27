import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('brief workflow migration backfills immutable tenant-scoped version history with RLS', async () => {
  const sql = await readFile(new URL('../migrations/008_brief_workflow.sql', import.meta.url), 'utf8')
  assert.match(sql, /ALTER TABLE creative_briefs[\s\S]*ADD COLUMN version integer NOT NULL DEFAULT 1/i)
  assert.match(sql, /ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now\(\)/i)
  assert.match(sql, /CREATE TABLE creative_brief_versions/i)
  assert.match(sql, /PRIMARY KEY \(organization_id, brief_id, version\)/i)
  assert.match(sql, /FOREIGN KEY \(organization_id, brief_id\)[\s\S]*REFERENCES creative_briefs\(organization_id, id\)/i)
  assert.match(sql, /INSERT INTO creative_brief_versions[\s\S]*SELECT[\s\S]*FROM creative_briefs/i)
  assert.match(sql, /ALTER TABLE creative_brief_versions ENABLE ROW LEVEL SECURITY/i)
  assert.match(sql, /ALTER TABLE creative_brief_versions FORCE ROW LEVEL SECURITY/i)
  assert.match(sql, /app_is_member\(organization_id\)/i)
})

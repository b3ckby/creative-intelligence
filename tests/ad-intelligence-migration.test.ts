import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('ad intelligence migration keeps validation outside the metadata transaction', async () => {
  const sql = await readFile(new URL('../migrations/006_ad_intelligence.sql', import.meta.url), 'utf8')
  const commit = sql.search(/COMMIT;/i)
  const firstValidation = sql.search(/VALIDATE CONSTRAINT/i)
  assert.ok(commit >= 0)
  assert.ok(firstValidation > commit)
  assert.match(sql.slice(0, commit), /ADD CONSTRAINT competitor_ads_ended_after_start[\s\S]*NOT VALID/i)
  assert.doesNotMatch(sql.slice(0, commit), /VALIDATE CONSTRAINT/i)
  assert.doesNotMatch(sql, /CREATE\s+(?:UNIQUE\s+)?INDEX/i)
  const added = [...sql.matchAll(/ADD CONSTRAINT\s+(\w+)[\s\S]*?NOT VALID/gi)].map((match) => match[1])
  const validated = [...sql.matchAll(/VALIDATE CONSTRAINT\s+(\w+)/gi)].map((match) => match[1])
  assert.deepEqual(validated.sort(), added.sort())
})

test('creative analysis migration preserves version history and enforces tenant RLS', async () => {
  const sql = await readFile(new URL('../migrations/007_creative_analysis.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE creative_ad_analyses/i)
  assert.match(sql, /PRIMARY KEY\s*\(organization_id, competitor_ad_id, analysis_version, input_fingerprint\)/i)
  assert.match(sql, /FOREIGN KEY\s*\(organization_id, product_id, competitor_ad_id\)/i)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/i)
  assert.match(sql, /app_is_member\(organization_id\)/i)
  assert.match(sql, /status\s+text\s+NOT NULL\s+CHECK\s*\(status IN \('pending', 'completed', 'failed'\)\)/i)
  assert.match(sql, /claim_token\s+text/i)
  assert.match(sql, /claim_expires_at\s+timestamptz/i)
  assert.match(sql, /CREATE TABLE creative_analysis_daily_usage/i)
  assert.match(sql, /PRIMARY KEY\s*\(organization_id, usage_date\)/i)
  assert.match(sql, /CREATE TABLE competitor_analytics_snapshots/i)
  assert.match(sql, /PRIMARY KEY\s*\(organization_id, competitor_id, snapshot_date\)/i)
})

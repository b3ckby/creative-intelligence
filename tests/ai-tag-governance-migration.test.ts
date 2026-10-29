import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('migration 017 creates append-only tenant-owned review history and protects completed model output', async () => {
  const sql = await readFile(new URL('../migrations/017_ai_tag_governance.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE creative_analysis_reviews/u)
  assert.match(sql, /PRIMARY KEY \(organization_id, competitor_ad_id, analysis_version, input_fingerprint, review_version\)/u)
  assert.match(sql, /FOREIGN KEY \(organization_id, competitor_ad_id, analysis_version, input_fingerprint\)[\s\S]*creative_ad_analyses/u)
  assert.match(sql, /decision IN \('approved','rejected','corrected'\)/u)
  assert.match(sql, /reviewer_user_id text NOT NULL/u)
  assert.match(sql, /ALTER TABLE creative_analysis_reviews ENABLE ROW LEVEL SECURITY/u)
  assert.match(sql, /ALTER TABLE creative_analysis_reviews FORCE ROW LEVEL SECURITY/u)
  assert.match(sql, /FOR SELECT TO creative_intelligence_runtime[\s\S]*app_is_member\(organization_id\)/u)
  assert.match(sql, /FOR INSERT TO creative_intelligence_runtime[\s\S]*app_is_member\(organization_id\)/u)
  assert.doesNotMatch(sql, /GRANT[^;]*(?:UPDATE|DELETE)[^;]*creative_analysis_reviews/u)
  assert.match(sql, /protect_completed_creative_analysis/u)
  assert.match(sql, /OLD\.status = 'completed'/u)
})

test('migration 017 constrains corrected review payloads and indexes queue and history reads', async () => {
  const sql = await readFile(new URL('../migrations/017_ai_tag_governance.sql', import.meta.url), 'utf8')
  assert.match(sql, /jsonb_typeof\(corrections\) = 'object'/u)
  assert.match(sql, /jsonb_array_length\(jsonb_path_query_array\(corrections, '\$\.keyvalue\(\)'\)\) BETWEEN 1 AND 5/u)
  assert.match(sql, /decision = 'corrected'/u)
  assert.match(sql, /creative_analysis_reviews_latest/u)
  assert.match(sql, /creative_analysis_reviews_reviewer/u)
})

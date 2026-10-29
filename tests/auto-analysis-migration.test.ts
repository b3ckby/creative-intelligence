import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('migration 012 adds a least-privilege durable automatic analysis queue and provenance', async () => {
  const sql = await readFile(new URL('../migrations/012_media_grounded_auto_analysis.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE ROLE creative_intelligence_analysis_worker[\s\S]*NOLOGIN[\s\S]*NOBYPASSRLS/u)
  assert.match(sql, /CREATE TABLE creative_analysis_jobs/u)
  assert.match(sql, /provenance[\s\S]*analysis_mode[\s\S]*media_count/u)
  assert.match(sql, /app_claim_creative_analysis_jobs/u)
  assert.match(sql, /app_begin_auto_analysis/u)
  assert.match(sql, /app_finish_auto_analysis_success/u)
  assert.match(sql, /app_finish_auto_analysis_failure/u)
  assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path=pg_catalog,public[\s\S]*SET row_security=off/u)
  assert.match(sql, /GRANT EXECUTE[\s\S]*creative_intelligence_analysis_worker/u)
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE|DELETE).*creative_intelligence_analysis_worker/u)
})

test('migration 012 enqueues auto analysis after mirrored media activation without calling a model', async () => {
  const sql = await readFile(new URL('../migrations/012_media_grounded_auto_analysis.sql', import.meta.url), 'utf8')
  assert.match(sql, /AFTER UPDATE OF status,active_checksum ON competitor_ad_media_positions/u)
  assert.match(sql, /enqueue_creative_analysis/u)
  assert.doesNotMatch(sql, /gemini|generateContent|http/iu)
})

test('migration 012 exposes tenant-authorized mirrored media with the service column contract', async () => {
  const sql = await readFile(new URL('../migrations/012_media_grounded_auto_analysis.sql', import.meta.url), 'utf8')
  assert.match(sql, /RETURNS TABLE\(slot_kind text,media_position integer,checksum text,media_type text,byte_size bigint\)/u)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_get_creative_analysis_media\(text,text,integer\) TO creative_intelligence_runtime/u)
})

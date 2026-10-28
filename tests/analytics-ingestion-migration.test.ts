import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('migration 010 exposes only fenced or tenant-authorized ingestion snapshot capture', async () => {
  const sql = await readFile(new URL('../migrations/010_ingestion_analytics_snapshots.sql', import.meta.url), 'utf8')

  assert.match(sql, /CREATE FUNCTION app_capture_ingestion_analytics_snapshot\s*\(/i)
  assert.match(sql, /clock_timestamp\(\)/i)
  assert.match(sql, /competitor_analytics_snapshots/i)
  assert.match(sql, /ON CONFLICT\s*\(organization_id, competitor_id, snapshot_date\)\s*DO UPDATE/i)
  assert.match(sql, /CREATE FUNCTION app_capture_ingestion_analytics_snapshot\s*\([\s\S]*?app_is_member\(capture_organization_id\)/i)
  assert.match(sql, /CREATE FUNCTION app_capture_scheduled_ingestion_analytics_snapshot\s*\([\s\S]*?status='running'[\s\S]*?fence_token=capture_fence/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_capture_ingestion_analytics_snapshot\(text,text,text\) TO creative_intelligence_runtime/i)
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_capture_ingestion_analytics_snapshot\(text,text,text\) TO creative_intelligence_scheduled_worker/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_capture_scheduled_ingestion_analytics_snapshot\(text,text,text\) TO creative_intelligence_scheduled_worker/i)
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_capture_scheduled_ingestion_analytics_snapshot\(text,text,text\) TO creative_intelligence_runtime/i)
  assert.match(sql, /CREATE FUNCTION app_lock_ingestion_product[\s\S]*?pg_advisory_xact_lock/i)
  assert.match(sql, /CREATE FUNCTION app_lock_scheduled_ingestion_product[\s\S]*?pg_advisory_xact_lock/i)
  assert.match(sql, /FROM scored\s+ORDER BY competitor_id\s+ON CONFLICT/i)
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*competitor_analytics_snapshots[^;]*creative_intelligence_scheduled_worker/i)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('migration 011 creates a tenant-safe fenced media ledger and bounded backfill', async () => {
  const sql = await readFile(new URL('../migrations/011_durable_media_mirror.sql', import.meta.url), 'utf8')

  assert.match(sql, /CREATE ROLE creative_intelligence_media_worker[\s\S]*?NOBYPASSRLS/i)
  assert.match(sql, /CREATE TABLE creative_media_blobs/i)
  assert.match(sql, /CREATE TABLE competitor_ad_media_positions/i)
  assert.match(sql, /UNIQUE\s*\(organization_id, ad_id, slot_kind, position\)/i)
  assert.match(sql, /FOREIGN KEY\s*\(organization_id, ad_id\)[\s\S]*?competitor_ads\s*\(organization_id, id\)/i)
  assert.match(sql, /status text NOT NULL[\s\S]*?'queued'[\s\S]*?'running'[\s\S]*?'retry_wait'[\s\S]*?'succeeded'[\s\S]*?'failed'/i)
  assert.match(sql, /CREATE FUNCTION app_reconcile_ad_media_positions/i)
  assert.match(sql, /CREATE TRIGGER reconcile_ad_media_positions/i)
  assert.match(sql, /CREATE FUNCTION app_claim_media_mirror_jobs/i)
  assert.match(sql, /FOR UPDATE[\s\S]*?SKIP LOCKED/i)
  assert.match(sql, /clock_timestamp\(\)/i)
  assert.match(sql, /fence_token/i)
  assert.match(sql, /CREATE FUNCTION app_finish_media_mirror_success/i)
  assert.match(sql, /CREATE FUNCTION app_finish_media_mirror_failure/i)
  assert.match(sql, /CREATE FUNCTION app_enqueue_media_backfill/i)
  assert.match(sql, /backfill_limit[^\n]*BETWEEN 1 AND 1000/i)
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE)[^;]*(?:competitor_ads|competitor_ad_media_positions|creative_media_blobs)[^;]*creative_intelligence_media_worker/i)
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('scheduled sync migration defines durable bounded tenant ledger and safe claims', async () => {
  const sql = await readFile(new URL('../migrations/009_scheduled_provider_sync.sql', import.meta.url), 'utf8')
  for (const fragment of [
    'CREATE TABLE competitor_ad_sync_schedules',
    'CREATE TABLE competitor_ad_sync_runs',
    "CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'))",
    'SKIP LOCKED',
    'ENABLE ROW LEVEL SECURITY',
    'FORCE ROW LEVEL SECURITY',
    'app_is_admin(organization_id)',
    'UNIQUE (competitor_id) WHERE status IN',
  ]) assert.match(sql, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('scheduled worker functions are fenced, use the database clock, and exclude runtime', async () => {
  const sql = await readFile(new URL('../migrations/009_scheduled_provider_sync.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE ROLE creative_intelligence_scheduled_worker\s+NOLOGIN/)
  assert.match(sql, /fence_token text/)
  assert.match(sql, /gen_random_uuid\(\)::text/)
  assert.match(sql, /clock_timestamp\(\)/)
  assert.doesNotMatch(sql, /claim_now|finish_now/)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_claim_due_ad_sync_runs[^;]+ TO creative_intelligence_scheduled_worker/)
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_(?:claim|finish)[^;]+ TO creative_intelligence_runtime/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS snapshot_scope_key text/)
  assert.doesNotMatch(sql, /GRANT (?:SELECT|INSERT|UPDATE)[^;]*competitor_ads[^;]*creative_intelligence_scheduled_worker/)
  assert.doesNotMatch(sql, /CREATE POLICY competitor_ads_scheduled_worker/)
  assert.match(sql, /CREATE FUNCTION app_upsert_scheduled_competitor_ad/)
  assert.match(sql, /CREATE FUNCTION app_retire_scheduled_competitor_ads/)
  assert.match(sql, /ALTER ROLE creative_intelligence_scheduled_worker\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/)
  assert.match(sql, /pg_catalog\.pg_auth_members WHERE member=worker_oid/)
  assert.match(sql, /unexpected scheduled worker role membership/)
  assert.match(sql, /REVOKE ALL ON FUNCTION app_validate_scheduled_competitor_ad\(jsonb\) FROM creative_intelligence_(?:runtime|scheduled_worker)/)
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION app_validate_scheduled_competitor_ad/)
})

test('point-3 symbols exist only in migration 009', async () => {
  for (const migration of ['002_tenant_rls.sql', '006_ad_intelligence.sql']) {
    const sql = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8')
    assert.doesNotMatch(sql, /creative_intelligence_scheduled_worker|snapshot_scope_key|competitor_ad_sync_/)
  }
})

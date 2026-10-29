import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('migration 015 creates a durable tenant-owned winning ads library', async () => {
  const sql = await readFile(new URL('../migrations/015_winning_ads_library.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE winning_ads/i)
  assert.match(sql, /category text NOT NULL[\s\S]*classic[\s\S]*modern[\s\S]*minimal[\s\S]*bold[\s\S]*lifestyle[\s\S]*product/i)
  assert.match(sql, /UNIQUE\s*\(organization_id,\s*source_ad_id\)/i)
  assert.match(sql, /CREATE TABLE winning_ad_media/i)
  assert.match(sql, /source_is_active boolean NOT NULL/i)
  assert.match(sql, /REFERENCES creative_media_blobs\s*\(checksum\) ON DELETE RESTRICT/i)
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+winning_ads/i)
  assert.doesNotMatch(sql, /winning_ad_media[\s\S]*REFERENCES competitor_ad_media_positions/i)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/i)
  assert.match(sql, /app_is_member\s*\(organization_id\)/i)
  assert.match(sql, /CREATE INDEX winning_ads_tenant_page/i)
  assert.match(sql, /CREATE INDEX winning_ads_tenant_search/i)
})

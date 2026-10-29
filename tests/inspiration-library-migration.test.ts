import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('migration 016 creates tenant-owned Inspiration boards with durable trusted media', async () => {
  const sql = await readFile(new URL('../migrations/016_inspiration_library.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE inspiration_boards/i)
  assert.match(sql, /CREATE TABLE inspiration_items/i)
  assert.match(sql, /CREATE TABLE inspiration_item_media/i)
  assert.match(sql, /source_kind text NOT NULL CHECK \(source_kind IN \('competitor_ad','winning_ad'\)\)/i)
  assert.match(sql, /UNIQUE\s*\(organization_id,\s*board_id,\s*source_kind,\s*source_ref_id\)/i)
  assert.match(sql, /REFERENCES creative_media_blobs\s*\(checksum\) ON DELETE RESTRICT/i)
  assert.doesNotMatch(sql, /REFERENCES (?:competitor_ads|winning_ads)/i)
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+inspiration_/i)
  assert.match(sql, /ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/i)
  assert.match(sql, /app_is_member\s*\(organization_id\)/i)
  assert.match(sql, /CREATE INDEX inspiration_items_tenant_search/i)
  assert.match(sql, /CREATE INDEX inspiration_items_tenant_page/i)
})

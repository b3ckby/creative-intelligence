import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migrationUrl = new URL('../migrations/013_ad_library_discovery.sql', import.meta.url)

test('migration 013 adds private tenant-scoped ad bookmarks and bounded discovery indexes', async () => {
  const sql = await readFile(migrationUrl, 'utf8')
  assert.match(sql, /CREATE TABLE competitor_ad_bookmarks/u)
  assert.match(sql, /PRIMARY KEY \(organization_id, user_id, competitor_ad_id\)/u)
  assert.match(sql, /FOREIGN KEY \(organization_id, user_id\)[\s\S]*organization_members/u)
  assert.match(sql, /FOREIGN KEY \(organization_id, competitor_ad_id\)[\s\S]*competitor_ads/u)
  assert.match(sql, /FORCE ROW LEVEL SECURITY/u)
  assert.match(sql, /user_id = app_verified_user_id\(\)/u)
  assert.match(sql, /GRANT SELECT, INSERT, DELETE ON competitor_ad_bookmarks TO creative_intelligence_runtime/u)
  assert.match(sql, /competitor_ads_discovery_search/u)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { DataType, newDb } from 'pg-mem'

import { readPgMemMigration } from './helpers/pg-mem-migrations.ts'
import { withVerifiedUserContext } from '../src/persistence/verified-user-context.ts'

function postgresTestDb() {
  const db = newDb()
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length })
  db.public.registerFunction({ name: 'trim', args: [DataType.text], returns: DataType.text, implementation: (value: string) => value.trim() })
  return db
}

test('initial PostgreSQL migration creates tenant-safe core schema', async () => {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')
  const db = postgresTestDb()
  db.public.none(sql)
  assert.match(sql, /CREATE INDEX creative_briefs_iteration_lookup[\s\S]*ON creative_briefs \(organization_id, product_id, created_at, id\)[\s\S]*WHERE status <> 'archived'/i)

  const tables = db.public.many(`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
    order by table_name
  `).map((row) => row.table_name)

  assert.deepEqual(tables, [
    'competitor_ads',
    'competitors',
    'creative_briefs',
    'organization_members',
    'organizations',
    'products',
  ])

  db.public.none(`
    insert into organizations (id, name) values ('org-1', 'One'), ('org-2', 'Two');
    insert into products (id, organization_id, name) values ('product-1', 'org-1', 'Product');
  `)

  assert.throws(() => db.public.none(`
    insert into competitors (id, organization_id, product_id, name)
    values ('competitor-1', 'org-2', 'product-1', 'Cross tenant');
  `), /foreign key/i)
})

test('database constraints reject duplicate provider identity and invalid roles', async () => {
  const sql = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')
  const db = postgresTestDb()
  db.public.none(sql)
  db.public.none(`
    insert into organizations (id, name) values ('org-1', 'One');
    insert into organization_members (organization_id, user_id, role) values ('org-1', 'user-1', 'admin');
    insert into products (id, organization_id, name) values ('product-1', 'org-1', 'Product');
    insert into competitors (id, organization_id, product_id, name)
      values ('competitor-1', 'org-1', 'product-1', 'Competitor');
    insert into competitor_ads (
      id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform,
      external_id, advertiser_name, body, started_at, is_active, source_url,
      first_seen_at, last_seen_at
    ) values (
      'ad-1', 'token-1', 'org-1', 'product-1', 'competitor-1', 'manual-meta', 'meta',
      'external-1', 'Advertiser', 'Body', now(), true, 'https://example.com/ad', now(), now()
    );
  `)

  assert.throws(() => db.public.none(`
    insert into competitor_ads (
      id, ingestion_token, organization_id, product_id, competitor_id, provider_name, platform,
      external_id, advertiser_name, body, started_at, is_active, source_url,
      first_seen_at, last_seen_at
    ) values (
      'ad-2', 'token-2', 'org-1', 'product-1', 'competitor-1', 'manual-meta', 'meta',
      'external-1', 'Advertiser', 'Body', now(), true, 'https://example.com/ad', now(), now()
    );
  `), /unique/i)

  assert.throws(() => db.public.none(`
    insert into organization_members (organization_id, user_id, role)
    values ('org-1', 'user-2', 'owner');
  `), /check constraint/i)

  db.public.none(`
    insert into organizations (id, name) values ('org-2', 'Two');
    insert into products (id, organization_id, name) values ('product-2', 'org-2', 'Other');
  `)
  assert.throws(() => db.public.none(`
    insert into creative_briefs (
      id, organization_id, product_id, title, status, source_ad_id, hook, dimensions
    ) values (
      'brief-1', 'org-2', 'product-2', 'Cross tenant', 'draft', 'ad-1', 'Hook', '{}'::jsonb
    );
  `), /foreign key/i)
})

test('ad intelligence migration adds nullable metadata with bounded enums and ranges', async () => {
  const initial = await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8')
  const metadata = await readFile(new URL('../migrations/006_ad_intelligence.sql', import.meta.url), 'utf8')
  const pgMemMetadata = await readPgMemMigration(new URL('../migrations/006_ad_intelligence.sql', import.meta.url))
  const db = postgresTestDb()
  db.public.none(initial)
  db.public.none(pgMemMetadata)

  const columns = db.public.many(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'competitor_ads'
  `).map((row) => row.column_name)
  for (const column of [
    'page_id', 'headline', 'description', 'display_format', 'ad_type', 'ended_at',
    'publisher_platforms', 'impressions_lower_bound', 'impressions_upper_bound',
    'spend_lower_bound', 'spend_upper_bound', 'currency', 'media',
  ]) assert.ok(columns.includes(column), `missing ${column}`)

  assert.match(metadata, /ad_type IN \('image', 'video', 'carousel', 'text'\)/i)
  assert.match(metadata, /impressions_lower_bound IS NULL OR impressions_lower_bound >= 0/i)
  assert.match(metadata, /impressions_upper_bound IS NULL OR impressions_upper_bound >= impressions_lower_bound/i)
  assert.match(metadata, /spend_upper_bound IS NULL OR spend_upper_bound >= spend_lower_bound/i)
  assert.doesNotMatch(metadata, /DEFAULT\s+0/i)
})

test('RLS migration restricts the runtime role and fails closed without verified user context', async () => {
  const sql = await readFile(new URL('../migrations/002_tenant_rls.sql', import.meta.url), 'utf8')

  assert.match(sql, /CREATE ROLE creative_intelligence_runtime[^;]*NOSUPERUSER[^;]*NOBYPASSRLS/i)
  assert.match(sql, /CREATE ROLE creative_intelligence_rls_owner[^;]*NOLOGIN[^;]*BYPASSRLS/i)
  assert.match(sql, /ALTER FUNCTION app_is_member\(text\) OWNER TO creative_intelligence_rls_owner/i)
  assert.match(sql, /ALTER FUNCTION app_is_admin\(text\) OWNER TO creative_intelligence_rls_owner/i)
  assert.match(sql, /GRANT SELECT ON organization_members TO creative_intelligence_rls_owner/i)
  assert.doesNotMatch(sql, /GRANT\s+creative_intelligence_rls_owner\s+TO\s+creative_intelligence_runtime/i)
  assert.match(sql, /CREATE TRIGGER organization_members_preserve_admin[\s\S]*BEFORE UPDATE OR DELETE/i)
  assert.match(sql, /FROM public\.organizations[\s\S]*FOR UPDATE/i)
  assert.match(sql, /IF NOT FOUND AND TG_OP = 'DELETE' THEN[\s\S]*RETURN OLD/i)
  for (const table of ['organizations', 'organization_members', 'products', 'competitors', 'competitor_ads', 'creative_briefs']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'))
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'))
  }
  assert.match(sql, /current_setting\('app\.user_id',\s*true\)/i)
  assert.match(sql, /NULLIF\([^)]*current_setting|current_setting[^;]*IS NOT NULL/i)
  assert.doesNotMatch(sql, /USING\s*\(\s*true\s*\)|WITH CHECK\s*\(\s*true\s*\)/i)
})

test('verified user context is transaction-local and rolls back failures', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const connection = {
    async query(text: string, values?: unknown[]) {
      calls.push(values === undefined ? { text } : { text, values })
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
  const pool = { async connect() { return connection }, query: connection.query }

  await assert.rejects(
    () => withVerifiedUserContext(pool, 'verified-user', async () => { throw new Error('boom') }),
    /boom/,
  )
  assert.deepEqual(calls.map((call) => call.text), [
    'BEGIN',
    `SELECT set_config('app.user_id', $1, true)`,
    'ROLLBACK',
  ])
  assert.deepEqual(calls[1]?.values, ['verified-user'])
})

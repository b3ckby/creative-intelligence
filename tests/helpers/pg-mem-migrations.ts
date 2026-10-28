import { readFile } from 'node:fs/promises'

export async function readPgMemMigration(url: URL): Promise<string> {
  const sql = await readFile(url, 'utf8')
  return sql
    .replace(/\s+NOT VALID/giu, '')
    .replace(/^ALTER TABLE competitor_ads VALIDATE CONSTRAINT \w+;\s*$/gimu, '')
    .replace(/GRANT SELECT, INSERT ON creative_brief_versions[\s\S]*?(?=COMMIT;)/iu, '')
}

/** pg-mem cannot parse migration 009's roles/functions; apply its ad-table evolution only. */
export async function readPgMemPoint3AdEvolution(): Promise<string> {
  const sql = await readFile(new URL('../../migrations/009_scheduled_provider_sync.sql', import.meta.url), 'utf8')
  if (!/ADD COLUMN IF NOT EXISTS snapshot_scope_key text/u.test(sql)) throw new Error('Migration 009 ad evolution is missing')
  return `ALTER TABLE competitor_ads ADD COLUMN snapshot_scope_key text;
    ALTER TABLE competitor_ads ADD CONSTRAINT competitor_ads_snapshot_scope_key_length
      CHECK (snapshot_scope_key IS NULL OR length(snapshot_scope_key) BETWEEN 1 AND 256);`
}

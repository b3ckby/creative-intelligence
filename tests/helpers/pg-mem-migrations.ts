import { readFile } from 'node:fs/promises'

export async function readPgMemMigration(url: URL): Promise<string> {
  const sql = await readFile(url, 'utf8')
  return sql
    .replace(/\s+NOT VALID/giu, '')
    .replace(/^ALTER TABLE competitor_ads VALIDATE CONSTRAINT \w+;\s*$/gimu, '')
    .replace(/GRANT SELECT, INSERT ON creative_brief_versions[\s\S]*?(?=COMMIT;)/iu, '')
}

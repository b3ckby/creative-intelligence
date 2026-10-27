import { readFile } from 'node:fs/promises'

import { generateOpenApiDocument } from '../src/http/schemas.ts'

const expected = `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`
const actual = await readFile(new URL('../docs/openapi.json', import.meta.url), 'utf8').catch(() => '')
if (actual !== expected) {
  process.stderr.write('OpenAPI document is stale; run npm run generate:openapi\n')
  process.exitCode = 1
}

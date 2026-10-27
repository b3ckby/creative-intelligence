import { writeFile } from 'node:fs/promises'

import { generateOpenApiDocument } from '../src/http/schemas.ts'

const destination = new URL('../docs/openapi.json', import.meta.url)
await writeFile(destination, `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`, 'utf8')

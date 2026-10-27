import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveConfig } from 'vite'

test('Vite validates and bundles simple-login values from the same env directory', async () => {
  const mode = `simple_login_${randomBytes(6).toString('hex')}`
  const environmentFile = new URL(`../.env.${mode}`, import.meta.url)
  await writeFile(environmentFile, 'VITE_SIMPLE_LOGIN=true\nVITE_API_BASE_URL=https://staging.example.test/api\n', { flag: 'wx' })
  try {
    const config = await resolveConfig({}, 'build', mode)
    assert.equal(config.env.VITE_SIMPLE_LOGIN, 'true')
    assert.equal(config.env.VITE_API_BASE_URL, 'https://staging.example.test/api')
  } finally {
    await unlink(environmentFile)
  }
})

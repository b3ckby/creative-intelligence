import assert from 'node:assert/strict'
import test from 'node:test'

import { validateSimpleLoginBuildEnvironment } from '../src/config/simple-login-build-config.ts'

test('simple-login build configuration fails closed unless its HTTPS API URL is complete', () => {
  assert.deepEqual(validateSimpleLoginBuildEnvironment({}), { enabled: false })
  assert.deepEqual(validateSimpleLoginBuildEnvironment({ VITE_SIMPLE_LOGIN: 'true', VITE_API_BASE_URL: 'https://staging.example.test/api' }), {
    enabled: true,
    apiBaseUrl: 'https://staging.example.test/api',
  })
  for (const environment of [
    { VITE_SIMPLE_LOGIN: 'true' },
    { VITE_SIMPLE_LOGIN: 'true', VITE_API_BASE_URL: 'http://staging.example.test/api' },
    { VITE_SIMPLE_LOGIN: 'true', VITE_API_BASE_URL: 'https://user:secret@staging.example.test/api' },
    { VITE_SIMPLE_LOGIN: 'yes', VITE_API_BASE_URL: 'https://staging.example.test/api' },
    { VITE_API_BASE_URL: 'https://staging.example.test/api' },
  ]) {
    assert.throws(() => validateSimpleLoginBuildEnvironment(environment), /Simple login build configuration is invalid/)
  }
})

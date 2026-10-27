import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, scryptSync } from 'node:crypto'
import test from 'node:test'

import { createProductionApp } from '../../src/app.ts'
import { parseRuntimeConfig } from '../../src/config/runtime-config.ts'
import { withRealPostgres } from './helpers/real-postgres.ts'

test('staging password exchange reaches a protected organization route through the production verifier', async () => {
  await withRealPostgres(async ({ runtimePool, inspectionPool }) => {
    const issuer = 'https://issuer.example.test/'
    const subject = 'staging-user'
    const namespace = 'testidentity'
    const userId = `${namespace}:${createHash('sha256').update(Buffer.concat([
      Buffer.from(issuer), Buffer.from([0]), Buffer.from(subject),
    ])).digest('base64url')}`
    await inspectionPool.query(`INSERT INTO organizations (id, name) VALUES ('staging-org', 'Staging')`)
    await inspectionPool.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES ('staging-org', $1, 'admin')`,
      [userId],
    )

    const salt = Buffer.from('0123456789abcdef', 'utf8')
    const password = 'integration staging password'
    const digest = scryptSync(password, salt, 32)
    const passwordHash = `scrypt-v1$${salt.toString('base64url')}$${digest.toString('base64url')}`
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'staging-key-1', alg: 'RS256', use: 'sig' }
    const config = parseRuntimeConfig({
      HOST: '127.0.0.1', PORT: '3000', TRUSTED_PROXY_ADDRESSES: '127.0.0.1',
      DATABASE_URL: 'postgresql://runtime@127.0.0.1/database', DATABASE_RUNTIME_ROLE: 'creative_intelligence_runtime',
      DATABASE_CONNECT_TIMEOUT_MS: '1000', DATABASE_HEALTH_TIMEOUT_MS: '500', DATABASE_POOL_MAX: '5',
      CURSOR_SIGNING_KEY: 'integration-cursor-signing-key-at-least-32-bytes',
      OIDC_ISSUER: issuer, OIDC_JWKS_URL: 'https://issuer.example.test/jwks', OIDC_AUDIENCES: 'creative-intelligence',
      OIDC_ALGORITHMS: 'RS256', OIDC_IDENTITY_NAMESPACE: namespace,
      APIFY_API_TOKEN: 'fixture-apify-credential', APIFY_TIMEOUT_MS: '1000', APIFY_MAX_RESPONSE_BYTES: '100000',
      APIFY_AD_COUNT: '10', APIFY_COUNTRY_CODE: 'ALL', APIFY_ACTIVE_STATUS: 'ALL', APIFY_MAX_CONCURRENCY: '1',
      STAGING_PASSWORD_LOGIN_ENABLED: 'true', STAGING_LOGIN_PASSWORD_HASH_FILE: '/run/credentials/password-hash',
      STAGING_LOGIN_PRIVATE_KEY_FILE: '/run/credentials/private-key', STAGING_LOGIN_KEY_ID: 'staging-key-1',
      STAGING_LOGIN_SUBJECT: subject, STAGING_LOGIN_ORGANIZATION_ID: 'staging-org', STAGING_LOGIN_TOKEN_TTL_SECONDS: '3600',
      STAGING_LOGIN_MAX_ATTEMPTS: '5', STAGING_LOGIN_ATTEMPT_WINDOW_MS: '300000', STAGING_LOGIN_MAX_CONCURRENCY: '2',
    })
    const app = await createProductionApp(config, {
      createPool: () => runtimePool,
      readSecretFile: async (path) => path.endsWith('password-hash') ? passwordHash : privateKeyPem,
      fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      readinessCheck: async () => true,
    })

    const login = await app.inject({ method: 'POST', url: '/auth/staging-login', payload: { password } })
    assert.equal(login.statusCode, 200)
    const session = login.json<{ accessToken: string, organizationId: string }>()
    assert.equal(session.organizationId, 'staging-org')
    const protectedResponse = await app.inject({
      method: 'GET',
      url: '/organizations/staging-org/products',
      headers: { authorization: `Bearer ${session.accessToken}` },
    })
    assert.equal(protectedResponse.statusCode, 200)
  })
})

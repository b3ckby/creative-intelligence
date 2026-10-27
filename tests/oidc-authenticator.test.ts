import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'

import type { FastifyRequest } from 'fastify'
import { createOidcAuthenticator } from '../src/auth/oidc-authenticator.ts'
import { buildApi } from '../src/http/build-api.ts'
import type { SqlPool } from '../src/persistence/postgres-organization-repository.ts'

const NOW_SECONDS = 1_798_243_200
const ISSUER = 'https://identity.example.com/'
const JWKS_URL = 'https://identity.example.com/.well-known/jwks.json'

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function fixture(modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength })
  const jwk = publicKey.export({ format: 'jwk' })
  const kid = 'production-key-1'
  return {
    jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] },
    token(claims: Record<string, unknown> = {}, headerClaims: Record<string, unknown> = {}, signingKey = privateKey) {
      const header = base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...headerClaims }))
      const payload = base64url(JSON.stringify({
        iss: ISSUER,
        aud: 'creative-api',
        sub: 'provider-user-123',
        iat: NOW_SECONDS - 10,
        nbf: NOW_SECONDS - 10,
        exp: NOW_SECONDS + 300,
        ...claims,
      }))
      const signingInput = `${header}.${payload}`
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), signingKey).toString('base64url')
      return `${signingInput}.${signature}`
    },
    privateKey,
    publicKey,
    kid,
  }
}

function request(authorization?: string): FastifyRequest {
  const rawHeaders = authorization === undefined ? [] : ['Authorization', authorization]
  return { headers: authorization === undefined ? {} : { authorization }, raw: { rawHeaders } } as unknown as FastifyRequest
}

async function rejectsAuthentication(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.deepEqual({ name: (error as Error).name, message: (error as Error).message }, {
      name: 'AuthenticationError', message: 'Authentication is required',
    })
    return true
  })
}

function authenticator(jwks: unknown, overrides: Partial<Parameters<typeof createOidcAuthenticator>[0]> = {}, fetchOverride?: typeof fetch) {
  return createOidcAuthenticator({
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    audiences: ['creative-api'],
    algorithms: ['RS256'],
    identityNamespace: 'creative_oidc',
    ...overrides,
  }, {
    now: () => new Date(NOW_SECONDS * 1000),
    fetch: fetchOverride ?? (async () => new Response(JSON.stringify(jwks), { status: 200 })),
  })
}

test('authenticates a valid asymmetric OIDC access token and derives a stable local identity', async () => {
  const keys = fixture()
  const authenticate = createOidcAuthenticator({
    issuer: ISSUER,
    jwksUrl: JWKS_URL,
    audiences: ['creative-api'],
    algorithms: ['RS256'],
    identityNamespace: 'creative_oidc',
  }, {
    now: () => new Date(NOW_SECONDS * 1000),
    fetch: async () => new Response(JSON.stringify(keys.jwks), { status: 200, headers: { 'content-type': 'application/json' } }),
  })

  const first = await authenticate(request(`Bearer ${keys.token()}`))
  const second = await authenticate(request(`Bearer ${keys.token()}`))

  assert.match(first, /^creative_oidc:[A-Za-z0-9_-]{43}$/)
  assert.equal(second, first)
})

test('refreshes JWKS once when a rotated key identifier is unknown', async () => {
  const oldKeys = fixture()
  const newKeys = fixture()
  const newJwk = newKeys.publicKey.export({ format: 'jwk' })
  const rotatedKid = 'rotated-key'
  let calls = 0
  const authenticate = authenticator(oldKeys.jwks, {}, async () => {
    calls += 1
    const body = calls === 1
      ? oldKeys.jwks
      : { keys: [{ ...newJwk, kid: rotatedKid, alg: 'RS256', use: 'sig' }] }
    return new Response(JSON.stringify(body), { status: 200 })
  })

  await authenticate(request(`Bearer ${oldKeys.token()}`))
  const identity = await authenticate(request(`Bearer ${newKeys.token({}, { kid: rotatedKid })}`))

  assert.match(identity, /^creative_oidc:/)
  assert.equal(calls, 2)
})

test('requires exactly one exact Bearer Authorization header and ignores cookie or query credentials', async () => {
  const keys = fixture()
  const authenticate = authenticator(keys.jwks)
  const token = keys.token()
  const invalid = [
    request(), request(token), request(`bearer ${token}`), request(`Bearer  ${token}`),
    request(`Bearer ${token} `), request('Bearer'),
    { headers: { authorization: `Bearer ${token}` }, raw: { rawHeaders: ['Authorization', `Bearer ${token}`, 'authorization', `Bearer ${token}`] } } as unknown as FastifyRequest,
    { headers: { cookie: `authorization=Bearer%20${token}` }, query: { access_token: token }, raw: { rawHeaders: ['Cookie', 'present'] } } as unknown as FastifyRequest,
  ]
  for (const candidate of invalid) await rejectsAuthentication(() => authenticate(candidate))
})

test('rejects bad signatures, algorithm confusion, unknown keys, issuer and audience mismatches', async () => {
  const keys = fixture()
  const attacker = fixture()
  const authenticate = authenticator(keys.jwks)
  const cases = [
    keys.token({}, {}, attacker.privateKey),
    keys.token({}, { alg: 'HS256' }),
    keys.token({}, { alg: 'none' }),
    keys.token({}, { kid: 'missing-key' }),
    keys.token({ iss: 'https://attacker.example/' }),
    keys.token({ aud: 'different-api' }),
  ]
  for (const token of cases) await rejectsAuthentication(() => authenticate(request(`Bearer ${token}`)))
})

test('validates exp, nbf, and iat with only the configured bounded clock tolerance', async () => {
  const keys = fixture()
  const authenticate = authenticator(keys.jwks, { clockToleranceSeconds: 5 })
  const invalidClaims = [
    { exp: NOW_SECONDS - 6 }, { exp: undefined }, { nbf: NOW_SECONDS + 6 },
    { nbf: 'soon' }, { iat: NOW_SECONDS + 6 }, { iat: undefined },
  ]
  for (const claims of invalidClaims) await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token(claims)}`)))
  await authenticate(request(`Bearer ${keys.token({ exp: NOW_SECONDS - 4, nbf: NOW_SECONDS + 4, iat: NOW_SECONDS + 4 })}`))
})

test('requires a nonempty bounded subject without control characters', async () => {
  const keys = fixture()
  const authenticate = authenticator(keys.jwks, { subjectMaxLength: 8 })
  for (const sub of [undefined, '', '123456789', 'user\nname', 'user\u007fname']) {
    await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token({ sub })}`)))
  }
})

test('accepts any configured audience and namespaces identities by issuer', async () => {
  const keys = fixture()
  const first = authenticator(keys.jwks, { audiences: ['other-api', 'creative-api'] })
  const secondIssuer = 'https://accounts.example.net/'
  const second = authenticator(keys.jwks, { issuer: secondIssuer })
  const firstIdentity = await first(request(`Bearer ${keys.token()}`))
  const secondIdentity = await second(request(`Bearer ${keys.token({ iss: secondIssuer })}`))
  assert.notEqual(firstIdentity, secondIdentity)
})

test('rejects unsafe or unbounded runtime configuration before any request is served', () => {
  const base = { issuer: ISSUER, jwksUrl: JWKS_URL, audiences: ['creative-api'], algorithms: ['RS256'], identityNamespace: 'creative_oidc' }
  const invalid: Array<Record<string, unknown>> = [
    { issuer: 'http://identity.example.com/' }, { issuer: 'https://user:pass@identity.example.com/' },
    { issuer: 'https://identity.example.com/#fragment' }, { jwksUrl: 'http://identity.example.com/jwks' },
    { jwksUrl: 'https://identity.example.com/jwks#fragment' }, { audiences: [] },
    { issuer: 'https://identity.example.com/#' }, { issuer: 'https://@identity.example.com/' },
    { jwksUrl: ' https://identity.example.com/jwks' }, { jwksUrl: 'https://identity.example.com/jwks\n' },
    { audiences: Array.from({ length: 17 }, (_, index) => `aud-${index}`) }, { algorithms: ['HS256'] },
    { algorithms: ['none'] }, { identityNamespace: 'short' }, { clockToleranceSeconds: 61 },
    { identityNamespace: undefined }, { identityNamespace: null }, { identityNamespace: 42 },
    { issuer: 'https://identity.example.com/\u00a0' }, { jwksUrl: 'https://identity.example.com/\u2003jwks' },
    { issuer: 'https://identity.example.com/?tenant=one' },
    { jwksTimeoutMs: 99 }, { jwksCacheTtlMs: 999 }, { maxJwksBytes: 1_048_577 },
    { maxJwksKeys: 101 }, { subjectMaxLength: 201 },
  ]
  for (const overrides of invalid) {
    assert.throws(
      () => createOidcAuthenticator({ ...base, ...overrides } as Parameters<typeof createOidcAuthenticator>[0]),
      { message: 'OIDC authentication configuration is invalid' },
    )
  }
})

test('rejects redirects, oversized, malformed, duplicate, and unsupported JWKS responses', async () => {
  const keys = fixture()
  const key = keys.jwks.keys[0]
  const { publicKey: ecPublicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const ec = ecPublicKey.export({ format: 'jwk' })
  const cases: Array<{ response: () => Response, overrides?: Partial<Parameters<typeof createOidcAuthenticator>[0]> }> = [
    { response: () => new Response(null, { status: 302, headers: { location: 'https://other.example/jwks' } }) },
    { response: () => new Response('x'.repeat(1_025), { status: 200 }), overrides: { maxJwksBytes: 1_024 } },
    { response: () => new Response('{broken', { status: 200 }) },
    { response: () => new Response(JSON.stringify({ keys: [key, key] }), { status: 200 }) },
    { response: () => new Response(JSON.stringify({ keys: [{ kty: 'oct', k: 'c2VjcmV0', kid: 'symmetric', alg: 'HS256', use: 'sig' }] }), { status: 200 }) },
    { response: () => new Response(JSON.stringify({ keys: [key, { ...key, kid: 'bad\nkey' }] }), { status: 200 }) },
    { response: () => new Response(JSON.stringify({ keys: [key, { ...key, kid: 'weak-exponent', e: 'AQ' }] }), { status: 200 }) },
    {
      response: () => new Response(Buffer.concat([
        Buffer.from(`{"keys":[${JSON.stringify(key)}],"note":"`), Buffer.from([0xff]), Buffer.from('"}'),
      ]), { status: 200 }),
    },
    {
      response: () => new Response(JSON.stringify({ keys: [key, { ...ec, kid: 'padded-ec', alg: 'ES256', use: 'sig', x: `${ec.x}=` }] }), { status: 200 }),
      overrides: { algorithms: ['RS256', 'ES256'] },
    },
  ]
  for (const candidate of cases) {
    const authenticate = authenticator(keys.jwks, candidate.overrides, async (_url, init) => {
      assert.equal(init?.redirect, 'manual')
      return candidate.response()
    })
    await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token()}`)))
  }
})

test('times out slow JWKS retrieval and exposes only the fixed authentication error', async () => {
  const keys = fixture()
  const authenticate = authenticator(keys.jwks, { jwksTimeoutMs: 100 }, async (_url, init) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(`provider timeout at ${JWKS_URL}`)), { once: true })
    })
  })
  await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token()}`)))
})

test('caches JWKS for its bounded TTL and coalesces concurrent refreshes', async () => {
  const keys = fixture()
  let nowMs = NOW_SECONDS * 1000
  let monotonicMs = 10_000
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const authenticate = createOidcAuthenticator({
    issuer: ISSUER, jwksUrl: JWKS_URL, audiences: ['creative-api'], algorithms: ['RS256'],
    identityNamespace: 'creative_oidc', jwksCacheTtlMs: 1_000,
  }, {
    now: () => new Date(nowMs),
    monotonicNow: () => monotonicMs,
    fetch: async () => {
      calls += 1
      if (calls === 1) await gate
      return new Response(JSON.stringify(keys.jwks), { status: 200 })
    },
  })
  const one = authenticate(request(`Bearer ${keys.token()}`))
  const two = authenticate(request(`Bearer ${keys.token()}`))
  release?.()
  await Promise.all([one, two])
  assert.equal(calls, 1)
  await authenticate(request(`Bearer ${keys.token()}`))
  assert.equal(calls, 1)
  nowMs += 1_001
  monotonicMs += 1_001
  await authenticate(request(`Bearer ${keys.token()}`))
  assert.equal(calls, 2)
})

test('uses monotonic elapsed time so wall-clock rollback cannot extend JWKS cache lifetime', async () => {
  const keys = fixture()
  let wallMs = NOW_SECONDS * 1000
  let monotonicMs = 20_000
  let calls = 0
  const authenticate = createOidcAuthenticator({
    issuer: ISSUER, jwksUrl: JWKS_URL, audiences: ['creative-api'], algorithms: ['RS256'],
    identityNamespace: 'creative_oidc', jwksCacheTtlMs: 1_000,
  }, {
    now: () => new Date(wallMs),
    monotonicNow: () => monotonicMs,
    fetch: async () => {
      calls += 1
      return new Response(JSON.stringify(keys.jwks), { status: 200 })
    },
  })
  await authenticate(request(`Bearer ${keys.token()}`))
  wallMs -= 60_000
  monotonicMs += 1_001
  await authenticate(request(`Bearer ${keys.token({ iat: NOW_SECONDS - 70, nbf: NOW_SECONDS - 70, exp: NOW_SECONDS + 120 })}`))
  assert.equal(calls, 2)
})

test('unknown kid refreshes only once and remains a fixed authentication failure', async () => {
  const keys = fixture()
  let calls = 0
  const authenticate = authenticator(keys.jwks, {}, async () => {
    calls += 1
    return new Response(JSON.stringify(keys.jwks), { status: 200 })
  })
  await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token({}, { kid: 'never-present' })}`)))
  assert.equal(calls, 2)
})

test('rate-limits repeated unknown-kid refreshes without evicting a healthy cache', async () => {
  const keys = fixture()
  let calls = 0
  const authenticate = authenticator(keys.jwks, {}, async () => {
    calls += 1
    return new Response(JSON.stringify(keys.jwks), { status: 200 })
  })
  await authenticate(request(`Bearer ${keys.token()}`))
  for (const kid of ['unknown-1', 'unknown-2', 'unknown-3']) {
    await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token({}, { kid })}`)))
  }
  await authenticate(request(`Bearer ${keys.token()}`))
  assert.equal(calls, 2)
})

test('enforces timeout even when injected fetch ignores AbortSignal', async () => {
  const keys = fixture()
  const authenticate = authenticator(keys.jwks, { jwksTimeoutMs: 100 }, async () => await new Promise<Response>(() => {}))
  await rejectsAuthentication(async () => await Promise.race([
    authenticate(request(`Bearer ${keys.token()}`)),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('outer deadline exceeded')), 250)),
  ]))
})

test('rejects weak RSA keys before token verification', async () => {
  const weak = fixture(1024)
  await rejectsAuthentication(() => authenticator(weak.jwks)(request(`Bearer ${weak.token()}`)))
})

test('preserves the configured OIDC issuer as an exact identifier without URL canonicalization', async () => {
  const keys = fixture()
  const exactIssuer = 'https://identity.example.com'
  const authenticate = authenticator(keys.jwks, { issuer: exactIssuer })
  await authenticate(request(`Bearer ${keys.token({ iss: exactIssuer })}`))
  await rejectsAuthentication(() => authenticate(request(`Bearer ${keys.token({ iss: `${exactIssuer}/` })}`)))
})

test('buildApi sanitizes production authentication failures as REST 401 and has no header-auth fallback', async () => {
  const keys = fixture()
  const authenticate = authenticator(keys.jwks, {}, async () => {
    throw new Error(`provider ${JWKS_URL} rejected secret-token`)
  })
  const pool = { query: async () => { throw new Error('database must not be reached') } } as unknown as SqlPool
  const app = buildApi({
    pool, authenticate, createId: () => 'unused-id', now: () => new Date(NOW_SECONDS * 1000),
    cursorSigningKey: 'test-cursor-signing-key-at-least-32-bytes',
  })
  const response = await app.inject({
    method: 'POST', url: '/organizations',
    headers: { authorization: `Bearer ${keys.token()}`, 'x-user-id': 'test-header-user' },
    payload: { name: 'Team' },
  })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Authentication is required' })
  assert.doesNotMatch(response.body, /provider|JWKS|identity\.example|secret-token|test-header-user/i)
  await app.close()
})

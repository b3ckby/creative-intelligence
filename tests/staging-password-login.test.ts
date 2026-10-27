import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, scrypt as scryptCallback } from 'node:crypto'
import { promisify } from 'node:util'

import { jwtVerify } from 'jose'

import { AuthenticationError, RateLimitError } from '../src/domain/errors.ts'
import { StagingPasswordLogin } from '../src/auth/staging-password-login.ts'

const scrypt = promisify(scryptCallback)
const PASSWORD = 'correct horse battery staple'
const ISSUER = 'https://staging.example.test/oidc'
const AUDIENCE = 'creative-intelligence-staging'

async function passwordHash(password = PASSWORD): Promise<string> {
  const salt = Buffer.from('0123456789abcdef', 'utf8')
  const digest = await scrypt(password, salt, 32) as Buffer
  return `scrypt-v1$${salt.toString('base64url')}$${digest.toString('base64url')}`
}

async function fixture(maxAttempts = 5, maxConcurrency = 2) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  let now = new Date('2026-10-27T10:00:00.000Z')
  const login = new StagingPasswordLogin({
    passwordHash: await passwordHash(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'staging-key-1',
    issuer: ISSUER,
    audiences: [AUDIENCE],
    subject: 'denis',
    tokenTtlSeconds: 43_200,
    maxAttempts,
    attemptWindowMs: 300_000,
    maxConcurrency,
  }, { now: () => now })
  return { login, publicKey, setNow: (value: Date) => { now = value } }
}

test('staging password login exchanges the configured password for a bounded OIDC bearer token', async () => {
  const { login, publicKey } = await fixture()
  const token = await login.login(PASSWORD, '203.0.113.10')
  const verified = await jwtVerify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  })

  assert.equal(verified.protectedHeader.kid, 'staging-key-1')
  assert.equal(verified.payload.sub, 'denis')
  assert.equal(verified.payload.exp! - verified.payload.iat!, 43_200)
  assert.equal(JSON.stringify(verified.payload).includes(PASSWORD), false)
})

test('staging password login rejects a wrong password with the fixed authentication error', async () => {
  const { login } = await fixture()
  await assert.rejects(login.login('wrong password', '203.0.113.10'), AuthenticationError)
})

test('staging password login atomically reserves an attempt before concurrent password derivation', async () => {
  const { login } = await fixture(1)
  const results = await Promise.allSettled([
    login.login('wrong one', '203.0.113.10'),
    login.login('wrong two', '203.0.113.10'),
  ])
  const errorNames = results.map((result) => result.status === 'rejected' ? result.reason.constructor.name : 'fulfilled').sort()
  assert.deepEqual(errorNames, ['AuthenticationError', 'RateLimitError'])
})

test('staging password login rejects derivation overload across distinct addresses', async () => {
  const { login } = await fixture(5, 1)
  const results = await Promise.allSettled([
    login.login('wrong one', '203.0.113.10'),
    login.login('wrong two', '203.0.113.11'),
  ])
  const errorNames = results.map((result) => result.status === 'rejected' ? result.reason.constructor.name : 'fulfilled').sort()
  assert.deepEqual(errorNames, ['AuthenticationError', 'RateLimitError'])
})

test('staging password login rejects weak RSA signing keys before serving requests', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  const login = new StagingPasswordLogin({
    passwordHash: await passwordHash(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: 'staging-key-1', issuer: ISSUER, audiences: [AUDIENCE], subject: 'denis',
    tokenTtlSeconds: 43_200, maxAttempts: 5, attemptWindowMs: 300_000, maxConcurrency: 2,
  })
  await assert.rejects(login.ready(), /private key is invalid/u)
})

test('staging password login rate-limits repeated attempts per remote address and resets after its window', async () => {
  const { login, setNow } = await fixture(2)
  await assert.rejects(login.login('wrong one', '203.0.113.10'), AuthenticationError)
  await assert.rejects(login.login('wrong two', '203.0.113.10'), AuthenticationError)
  await assert.rejects(login.login(PASSWORD, '203.0.113.10'), RateLimitError)

  const otherAddressToken = await login.login(PASSWORD, '203.0.113.11')
  assert.ok(otherAddressToken.length > 100)

  setNow(new Date('2026-10-27T10:05:01.000Z'))
  const resetToken = await login.login(PASSWORD, '203.0.113.10')
  assert.ok(resetToken.length > 100)
})

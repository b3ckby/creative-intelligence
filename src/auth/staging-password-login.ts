import { createPrivateKey, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import { importPKCS8, SignJWT } from 'jose'

import { AuthenticationError, RateLimitError } from '../domain/errors.ts'

const scrypt = promisify(scryptCallback)
const MAX_PASSWORD_LENGTH = 1_024
const MAX_REMOTE_ADDRESS_LENGTH = 256
const MAX_TRACKED_ADDRESSES = 10_000

export interface StagingLoginAttemptLimiter {
  ready?(): Promise<void>
  claim(remoteAddress: string, nowMs: number): Promise<boolean>
  reset(remoteAddress: string): Promise<void>
}

export interface StagingPasswordLoginConfig {
  passwordHash: string
  privateKeyPem: string
  keyId: string
  issuer: string
  audiences: string[]
  subject: string
  tokenTtlSeconds: number
  maxAttempts: number
  attemptWindowMs: number
  maxConcurrency: number
}

export interface StagingPasswordLoginDependencies {
  now?: () => Date
  rateLimiter?: StagingLoginAttemptLimiter
}

interface AttemptWindow {
  startedAtMs: number
  attempts: number
}

export class StagingPasswordLogin {
  readonly #salt: Buffer
  readonly #expectedDigest: Buffer
  readonly #privateKey: Promise<CryptoKey>
  readonly #config: StagingPasswordLoginConfig
  readonly #now: () => Date
  readonly #rateLimiter: StagingLoginAttemptLimiter
  #activeDerivations = 0

  constructor(config: StagingPasswordLoginConfig, dependencies: StagingPasswordLoginDependencies = {}) {
    const parsedHash = parsePasswordHash(config.passwordHash)
    validateConfig(config)
    this.#salt = parsedHash.salt
    this.#expectedDigest = parsedHash.digest
    this.#privateKey = loadPrivateKey(config.privateKeyPem)
    this.#config = config
    this.#now = dependencies.now ?? (() => new Date())
    this.#rateLimiter = dependencies.rateLimiter ?? new InMemoryStagingLoginRateLimiter(config.maxAttempts, config.attemptWindowMs)
  }

  async ready(): Promise<void> {
    await this.#privateKey
  }

  async startupProbeToken(): Promise<string> {
    return await this.#issueToken(this.#now())
  }

  async login(password: string, remoteAddress: string): Promise<string> {
    const now = this.#now()
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Staging login clock is invalid')
    const address = normalizeRemoteAddress(remoteAddress)
    if (this.#activeDerivations >= this.#config.maxConcurrency) throw new RateLimitError()
    this.#activeDerivations += 1
    try {
      if (!await this.#rateLimiter.claim(address, nowMs)) throw new RateLimitError()
      const validPassword = typeof password === 'string' && password.length >= 1 && password.length <= MAX_PASSWORD_LENGTH
      const candidate = validPassword ? password : ''
      const actualDigest = await scrypt(candidate, this.#salt, this.#expectedDigest.length) as Buffer
      if (!validPassword || !timingSafeEqual(actualDigest, this.#expectedDigest)) throw new AuthenticationError()
      await this.#rateLimiter.reset(address)
      return await this.#issueToken(now)
    } finally {
      this.#activeDerivations -= 1
    }
  }

  async #issueToken(now: Date): Promise<string> {
    const nowMs = now.getTime()
    if (!Number.isFinite(nowMs)) throw new Error('Staging login clock is invalid')
    const issuedAt = Math.floor(nowMs / 1_000)
    return await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: this.#config.keyId, typ: 'JWT' })
      .setIssuer(this.#config.issuer)
      .setAudience(this.#config.audiences)
      .setSubject(this.#config.subject)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt - 5)
      .setExpirationTime(issuedAt + this.#config.tokenTtlSeconds)
      .sign(await this.#privateKey)
  }
}

class InMemoryStagingLoginRateLimiter implements StagingLoginAttemptLimiter {
  readonly #maximumAttempts: number
  readonly #windowMs: number
  readonly #attempts = new Map<string, AttemptWindow>()

  constructor(maximumAttempts: number, windowMs: number) {
    this.#maximumAttempts = maximumAttempts
    this.#windowMs = windowMs
  }

  async claim(remoteAddress: string, nowMs: number): Promise<boolean> {
    let window = this.#attempts.get(remoteAddress)
    if (!window || nowMs - window.startedAtMs >= this.#windowMs) {
      if (!window && this.#attempts.size >= MAX_TRACKED_ADDRESSES) {
        const oldest = this.#attempts.keys().next().value as string | undefined
        if (oldest !== undefined) this.#attempts.delete(oldest)
      }
      window = { startedAtMs: nowMs, attempts: 0 }
      this.#attempts.set(remoteAddress, window)
    }
    if (window.attempts >= this.#maximumAttempts) return false
    window.attempts += 1
    return true
  }

  async reset(remoteAddress: string): Promise<void> {
    this.#attempts.delete(remoteAddress)
  }
}

async function loadPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  try {
    const key = createPrivateKey(privateKeyPem)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2_048) throw new Error('weak key')
    return await importPKCS8(privateKeyPem, 'RS256')
  } catch {
    throw new Error('Staging private key is invalid')
  }
}

function parsePasswordHash(value: string): { salt: Buffer, digest: Buffer } {
  const [version, saltText, digestText, extra] = value.split('$')
  if (version !== 'scrypt-v1' || !saltText || !digestText || extra !== undefined) throw new Error('Staging password hash is invalid')
  const salt = canonicalBase64Url(saltText)
  const digest = canonicalBase64Url(digestText)
  if (salt.length !== 16 || digest.length !== 32) throw new Error('Staging password hash is invalid')
  return { salt, digest }
}

function canonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Staging password hash is invalid')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new Error('Staging password hash is invalid')
  return decoded
}

function validateConfig(config: StagingPasswordLoginConfig): void {
  if (!config.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error('Staging private key is invalid')
  if (!boundedToken(config.keyId, 128) || !boundedToken(config.subject, 200)) throw new Error('Staging login identity is invalid')
  if (!URL.canParse(config.issuer) || !config.issuer.startsWith('https://')) throw new Error('Staging login issuer is invalid')
  if (config.audiences.length === 0 || config.audiences.some((value) => !boundedToken(value, 2_048))) throw new Error('Staging login audience is invalid')
  if (!Number.isSafeInteger(config.tokenTtlSeconds) || config.tokenTtlSeconds < 300 || config.tokenTtlSeconds > 43_200) throw new Error('Staging login token lifetime is invalid')
  if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 100) throw new Error('Staging login attempt limit is invalid')
  if (!Number.isSafeInteger(config.attemptWindowMs) || config.attemptWindowMs < 1_000 || config.attemptWindowMs > 3_600_000) throw new Error('Staging login attempt window is invalid')
  if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1 || config.maxConcurrency > 16) throw new Error('Staging login concurrency is invalid')
}

function boundedToken(value: string, maximum: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\s\p{Cc}\p{Cf}]/u.test(value)
}

function normalizeRemoteAddress(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REMOTE_ADDRESS_LENGTH || /[\s\p{Cc}\p{Cf}]/u.test(value)) return 'unknown'
  return value
}

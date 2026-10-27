import { createHash, randomUUID } from 'node:crypto'

import type { StagingLoginAttemptLimiter } from '../auth/staging-password-login.ts'
import type { SqlPool } from './postgres-organization-repository.ts'

export interface PostgresStagingLoginRateLimiterConfig {
  maxAttempts: number
  attemptWindowMs: number
}

export class PostgresStagingLoginRateLimiter implements StagingLoginAttemptLimiter {
  readonly #pool: SqlPool
  readonly #config: PostgresStagingLoginRateLimiterConfig

  constructor(pool: SqlPool, config: PostgresStagingLoginRateLimiterConfig) {
    if (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 100) throw new Error('Staging login attempt limit is invalid')
    if (!Number.isSafeInteger(config.attemptWindowMs) || config.attemptWindowMs < 1_000 || config.attemptWindowMs > 3_600_000) throw new Error('Staging login attempt window is invalid')
    this.#pool = pool
    this.#config = config
  }

  async ready(): Promise<void> {
    const remoteAddress = `startup-${randomUUID()}`
    if (!await this.claim(remoteAddress)) throw new Error('Staging login limiter is unavailable')
    await this.reset(remoteAddress)
  }

  async claim(remoteAddress: string): Promise<boolean> {
    const result = await this.#pool.query<{ claimed: boolean }>(`
      SELECT public.claim_staging_login_attempt($1, $2, $3) AS claimed
    `, [addressHash(remoteAddress), this.#config.maxAttempts, this.#config.attemptWindowMs])
    return result.rowCount === 1 && result.rows[0]?.claimed === true
  }

  async reset(remoteAddress: string): Promise<void> {
    await this.#pool.query(`SELECT public.reset_staging_login_attempt($1)`, [addressHash(remoteAddress)])
  }
}

function addressHash(remoteAddress: string): string {
  return createHash('sha256').update('creative-intelligence-staging-login\0').update(remoteAddress).digest('base64url')
}

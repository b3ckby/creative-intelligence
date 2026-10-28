export interface ScheduledProviderSyncWorkerOptions<T> {
  intervalMs: number
  concurrency: number
  batchSize: number
  poll: (batchSize: number) => Promise<readonly T[]>
  run: (item: T) => Promise<void>
  sleep?: (milliseconds: number) => Promise<void>
  onPollError?: (error: { category: 'poll_failed' }) => void
  onRunError?: (error: { category: 'run_failed'; at: string }) => void
}

export interface ScheduledWorkerState {
  firstSuccessfulPollAt: string | null
  lastSuccessfulPollAt: string | null
  currentFailure: { category: 'poll_failed'; at: string } | null
  lastRunFailure: { category: 'run_failed'; at: string } | null
}

/** Deterministic retry delay: base * 2^(attempt-1), capped. */
export function deterministicBackoffMs(attempt: number, baseMs: number, maximumMs: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(maximumMs) || maximumMs < baseMs) {
    throw new Error('Retry backoff configuration is invalid')
  }
  return Math.min(maximumMs, baseMs * 2 ** Math.min(attempt - 1, 30))
}

export class ScheduledProviderSyncWorker<T> {
  private readonly sleep: (milliseconds: number) => Promise<void>
  private stopping = false
  private loop: Promise<void> | undefined
  private wakeStop: (() => void) | undefined
  private firstSuccessfulPollAt: string | null = null
  private lastSuccessfulPollAt: string | null = null
  private currentFailure: ScheduledWorkerState['currentFailure'] = null
  private lastRunFailure: ScheduledWorkerState['lastRunFailure'] = null

  constructor(private readonly options: ScheduledProviderSyncWorkerOptions<T>) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100 || options.intervalMs > 3_600_000
      || !Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16
      || !Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100
      || options.concurrency > options.batchSize) {
      throw new Error('Scheduled sync worker configuration is invalid')
    }
    this.sleep = options.sleep ?? (async (milliseconds) => await new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  start(): Promise<void> {
    if (this.loop) return this.loop
    this.stopping = false
    this.loop = this.runLoop().finally(() => { this.loop = undefined })
    return this.loop
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.wakeStop?.()
    await this.loop
  }

  state(): ScheduledWorkerState {
    return { firstSuccessfulPollAt: this.firstSuccessfulPollAt, lastSuccessfulPollAt: this.lastSuccessfulPollAt, currentFailure: this.currentFailure, lastRunFailure: this.lastRunFailure }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        const items = (await this.options.poll(this.options.batchSize)).slice(0, this.options.batchSize)
        const at = new Date().toISOString()
        this.firstSuccessfulPollAt ??= at
        this.lastSuccessfulPollAt = at
        this.currentFailure = null
        await runBounded(items, this.options.concurrency, this.options.run, () => {
          const failure = { category: 'run_failed' as const, at: new Date().toISOString() }
          this.lastRunFailure = failure
          this.options.onRunError?.(failure)
        })
      } catch {
        const failure = { category: 'poll_failed' as const, at: new Date().toISOString() }
        this.currentFailure = failure
        this.options.onPollError?.({ category: failure.category })
      }
      if (!this.stopping) {
        await Promise.race([
          this.sleep(this.options.intervalMs),
          new Promise<void>((resolve) => { this.wakeStop = resolve }),
        ])
        this.wakeStop = undefined
      }
    }
  }
}

async function runBounded<T>(items: readonly T[], concurrency: number, operation: (item: T) => Promise<void>, onError: () => void): Promise<void> {
  let next = 0
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      try { await operation(items[index]!) } catch { onError() }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner))
}

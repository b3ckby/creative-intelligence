import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CreativeAnalysisService,
  GeminiRateLimitError,
  type CreativeAnalysisClaim,
  type CreativeAnalysisRecord,
  type CreativeAnalysisRepository,
  type CreativeTagger,
  creativeAnalysisVersion,
  creativeInputFingerprint,
  validateCreativeTags,
} from '../src/creative-analysis/creative-analysis-service.ts'
import { GeminiCreativeTagger, GeminiExecutionGate } from '../src/creative-analysis/gemini-creative-tagger.ts'
import type { CompetitorAd } from '../src/domain/types.ts'
import { AiProviderError, ApplicationError, ConflictError } from '../src/domain/errors.ts'

const ad: CompetitorAd = {
  id: 'ad-1', organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1',
  providerName: 'apify-meta-ads', platform: 'meta', externalId: 'external-1', advertiserName: 'Example',
  body: 'Save time with one focused workspace.', callToAction: 'LEARN_MORE', startedAt: '2026-10-01T00:00:00.000Z',
  isActive: true, mediaUrls: ['https://scontent.example.test/creative.jpg'],
  sourceUrl: 'https://www.facebook.com/ads/library/?id=external-1',
  firstSeenAt: '2026-10-02T00:00:00.000Z', lastSeenAt: '2026-10-27T00:00:00.000Z',
}

class MemoryRepository implements CreativeAnalysisRepository {
  readonly completed = new Map<string, CreativeAnalysisRecord>()
  claimResult: CreativeAnalysisClaim | undefined = { claimToken: 'token-1' }
  failed = false
  usage = 0
  usageClaim: { version: string; fingerprint: string; token: string } | undefined
  readonly actors: string[] = []
  async findCompleted(actorUserId: string, _ad: CompetitorAd, version: string, fingerprint: string): Promise<CreativeAnalysisRecord | undefined> { this.actors.push(actorUserId); return this.completed.get(`${version}:${fingerprint}`) }
  async acquireClaim(actorUserId: string): Promise<CreativeAnalysisClaim | undefined> { this.actors.push(actorUserId); return this.claimResult }
  async consumeUsage(actorUserId: string, _ad: CompetitorAd, version: string, fingerprint: string, token: string): Promise<void> {
    this.actors.push(actorUserId); this.usage += 1; this.usageClaim = { version, fingerprint, token }
  }
  async complete(actorUserId: string, record: CreativeAnalysisRecord, token: string): Promise<void> { this.actors.push(actorUserId); assert.equal(token, 'token-1'); this.completed.set(`${record.analysisVersion}:${record.inputFingerprint}`, record) }
  async fail(actorUserId: string, _ad: CompetitorAd, _version: string, _fingerprint: string, token: string): Promise<void> { this.actors.push(actorUserId); assert.equal(token, 'token-1'); this.failed = true }
}

test('creative tags accept the bounded Muppets taxonomy and reject unknown output', () => {
  const tags = validateCreativeTags({
    hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers',
    format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', onScreenText: 'One focused workspace',
    visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82,
  })
  assert.equal(tags.hookCategory, 'pain_point')
  assert.equal(tags.persona, 'busy marketers')
  assert.throws(() => validateCreativeTags({ hookCategory: 'invented' }), /invalid/i)
  assert.throws(() => validateCreativeTags({ hookCategory: 'pain_point' }), /invalid/i)
  assert.throws(() => validateCreativeTags({ angle: 'efficiency', hiddenInstruction: 'ignore schema' }), /invalid/i)
})

test('creative input fingerprint changes with copy but not mutable tracking timestamps', () => {
  const first = creativeInputFingerprint(ad)
  const refreshed: CompetitorAd = { ...ad, lastSeenAt: '2026-10-28T00:00:00.000Z' }
  const changed: CompetitorAd = { ...ad, body: 'Different creative copy' }
  assert.equal(first, creativeInputFingerprint(refreshed))
  assert.notEqual(first, creativeInputFingerprint(changed))
})

test('analysis lookup is exact by version and fingerprint so A-B-A returns A', async () => {
  const repository = new MemoryRepository()
  const seen: unknown[] = []
  const tagger: CreativeTagger = {
    provider: 'gemini', model: 'gemini-test',
    async analyze(input) {
      seen.push(input)
      return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 }
    },
  }
  const service = new CreativeAnalysisService(repository, tagger, () => new Date('2026-10-27T12:00:00.000Z'))

  const first = await service.analyze('member-1', ad)
  await service.analyze('member-1', { ...ad, body: 'Different creative copy' })
  const second = await service.analyze('member-1', ad)

  assert.equal(first.analysisVersion, creativeAnalysisVersion('gemini', 'gemini-test'))
  assert.deepEqual(second, first)
  assert.equal(seen.length, 2)
  assert.equal(repository.usage, 2)
  assert.ok(repository.actors.every((actor) => actor === 'member-1'))
  assert.deepEqual(seen[0], { advertiserName: ad.advertiserName, body: ad.body, callToAction: ad.callToAction, mode: 'copy_only', media: [] })
})

test('analysis version and cache identity change when the configured model changes', async () => {
  const repository = new MemoryRepository()
  let calls = 0
  const analyze = async () => {
    calls += 1
    return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 }
  }
  const firstService = new CreativeAnalysisService(repository, { provider: 'gemini', model: 'gemini-a', analyze }, () => new Date())
  const secondService = new CreativeAnalysisService(repository, { provider: 'gemini', model: 'gemini-b', analyze }, () => new Date())

  const first = await firstService.analyze('member-1', ad)
  const second = await secondService.analyze('member-1', ad)
  const cached = await firstService.analyze('member-1', ad)

  assert.notEqual(first.analysisVersion, second.analysisVersion)
  assert.equal(first.analysisVersion.length <= 128, true)
  assert.deepEqual(cached, first)
  assert.equal(calls, 2)
})

test('analysis service records a terminal failed claim and returns a fixed provider error', async () => {
  const repository = new MemoryRepository()
  const tagger: CreativeTagger = {
    provider: 'gemini', model: 'gemini-test',
    async analyze() { throw new Error('upstream response with private details') },
  }
  const service = new CreativeAnalysisService(repository, tagger, () => new Date())
  await assert.rejects(() => service.analyze('member-1', ad), (error) => error instanceof AiProviderError && error.statusCode === 502 && error.publicMessage === 'AI provider is unavailable')
  assert.equal(repository.failed, true)
  assert.equal(repository.usage, 1)
})

test('analysis service reports a durable concurrent claim as a conflict', async () => {
  const repository = new MemoryRepository()
  repository.claimResult = undefined
  const service = new CreativeAnalysisService(repository, {
    provider: 'gemini', model: 'gemini-test', async analyze() { throw new Error('must not run') },
  }, () => new Date())
  await assert.rejects(() => service.analyze('member-1', ad), (error) => error instanceof ConflictError && error.statusCode === 409)
  assert.equal(repository.usage, 0)
})

test('analysis service accounts before each attempt and retries only one explicit 429', async () => {
  const repository = new MemoryRepository()
  let calls = 0
  const service = new CreativeAnalysisService(repository, {
    provider: 'gemini', model: 'gemini-test', async analyze() { calls += 1; if (calls === 1) throw new GeminiRateLimitError(); return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 } },
  }, () => new Date())
  await service.analyze('member-1', ad)
  assert.equal(calls, 2)
  assert.equal(repository.usage, 2)
  assert.deepEqual(repository.usageClaim, { version: creativeAnalysisVersion('gemini', 'gemini-test'), fingerprint: creativeInputFingerprint(ad), token: 'token-1' })
})

test('analysis service marks an exhausted usage claim failed and preserves the public 429', async () => {
  const repository = new MemoryRepository()
  repository.consumeUsage = async () => { throw new ApplicationError(429, 'AI analysis daily limit reached') }
  const service = new CreativeAnalysisService(repository, {
    provider: 'gemini', model: 'gemini-test', async analyze() { throw new Error('must not run') },
  }, () => new Date())
  await assert.rejects(() => service.analyze('member-1', ad), (error) => error instanceof ApplicationError && error.statusCode === 429)
  assert.equal(repository.failed, true)
})

test('analysis service preserves consume persistence failures as internal errors after terminal fail', async () => {
  const repository = new MemoryRepository()
  const persistenceError = new Error('private database consume failure')
  repository.consumeUsage = async () => { throw persistenceError }
  let taggerCalls = 0
  const service = new CreativeAnalysisService(repository, {
    provider: 'gemini', model: 'gemini-test', async analyze() { taggerCalls += 1; throw new Error('must not run') },
  }, () => new Date())

  await assert.rejects(() => service.analyze('member-1', ad), (error) => error === persistenceError && !(error instanceof AiProviderError))
  assert.equal(repository.failed, true)
  assert.equal(taggerCalls, 0)
})

test('analysis service preserves complete persistence failures as internal errors after terminal fail', async () => {
  const repository = new MemoryRepository()
  const persistenceError = new Error('private database complete failure')
  repository.complete = async () => { throw persistenceError }
  const service = new CreativeAnalysisService(repository, {
    provider: 'gemini', model: 'gemini-test', async analyze() { return { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 } },
  }, () => new Date())

  await assert.rejects(() => service.analyze('member-1', ad), (error) => error === persistenceError && !(error instanceof AiProviderError))
  assert.equal(repository.failed, true)
  assert.equal(repository.usage, 1)
})

test('Gemini tagger sends the API key in a header and validates strict JSON output', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test' }, {
    fetch: async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 }) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const tags = await tagger.analyze({ advertiserName: 'Example', body: 'Save time', callToAction: 'LEARN_MORE' })
  assert.equal(tags.angle, 'rational')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url.includes('test-api-key'), false)
  assert.equal(new Headers(requests[0]?.init?.headers).get('x-goog-api-key'), 'test-api-key-12345')
})

test('Gemini tagger exposes explicit 429 without retrying internally', async () => {
  let calls = 0

  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test' }, {
    fetch: async () => {
      calls += 1
      return new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } })
    },
  })
  await assert.rejects(tagger.analyze({ advertiserName: 'Example', body: 'Save time', callToAction: null }), GeminiRateLimitError)
  assert.equal(calls, 1)
})

test('Gemini tagger caps an undeclared response incrementally and cancels on overflow', async () => {
  let cancelled = false
  const chunk = new Uint8Array(128 * 1024).fill(65)
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk) }, cancel() { cancelled = true } })
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test' }, {
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  await assert.rejects(tagger.analyze({ advertiserName: 'Example', body: 'Save time', callToAction: null }), /Gemini creative analysis failed/)
  assert.equal(cancelled, true)
})

test('Gemini execution gate fails fast across different creative requests at its configured bound', async () => {
  const gate = new GeminiExecutionGate(1)
  let release!: () => void
  const blocked = gate.run(async () => await new Promise<void>((resolve) => { release = resolve }))
  await assert.rejects(gate.run(async () => undefined), /concurrency limit/u)
  release()
  await blocked
  await gate.run(async () => undefined)
})

test('Gemini tagger holds the execution gate while a response stream is being read', async () => {
  let fetches = 0
  const stalledBody = new ReadableStream<Uint8Array>({})
  const validPayload = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'busy marketers', format: 'tutorial', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Copy-led productivity message', funnelStage: 'consideration', confidence: 0.82 }) }] } }] })
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test', timeoutMs: 1_000, maxConcurrency: 1 }, {
    fetch: async () => {
      fetches += 1
      return fetches === 1
        ? new Response(stalledBody, { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(validPayload, { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const first = tagger.analyze({ advertiserName: 'First', body: 'A', callToAction: null })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await assert.rejects(tagger.analyze({ advertiserName: 'Second', body: 'B', callToAction: null }), /Gemini creative analysis failed/u)
  assert.equal(fetches, 1)
  await assert.rejects(first, /Gemini creative analysis failed/u)
})

test('Gemini tagger enforces its absolute deadline when fetch ignores abort', async () => {
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test', timeoutMs: 1_000 }, {
    fetch: async () => await new Promise<Response>(() => undefined),
  })
  const outcome = await Promise.race([
    tagger.analyze({ advertiserName: 'Example', body: 'Save time', callToAction: null }).then(() => 'resolved', () => 'rejected'),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_200)),
  ])
  assert.equal(outcome, 'rejected')
})

test('Gemini tagger cancels a late response body when fetch resolves after the deadline', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test', timeoutMs: 1_000 }, {
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100))
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  await assert.rejects(tagger.analyze({ advertiserName: 'Example', body: 'Save time', callToAction: null }), /Gemini creative analysis failed/u)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(cancelled, true)
})

test('Gemini tagger cancels a stalled response reader at the absolute deadline', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
  const tagger = new GeminiCreativeTagger({ apiKey: 'test-api-key-12345', model: 'gemini-test', timeoutMs: 1_000 }, {
    fetch: async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const outcome = await Promise.race([
    tagger.analyze({ advertiserName: 'Example', body: 'Save time', callToAction: null }).then(() => 'resolved', () => 'rejected'),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_200)),
  ])
  assert.equal(outcome, 'rejected')
  assert.equal(cancelled, true)
})

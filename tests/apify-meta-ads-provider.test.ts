import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APIFY_META_ADS_ACTOR_ID,
  ApifyMetaAdsProvider,
  ApifyRequestGate,
  normalizeFacebookPageUrl,
} from '../src/ad-ingestion/apify-meta-ads-provider.ts'

const context = Object.freeze({ organizationId: 'org-1', productId: 'product-1', competitorId: 'competitor-1' })
const actorRecord = {
  ad_archive_id: 'archive-1',
  page_name: 'Orbit',
  is_active: true,
  start_date: 1_760_227_200,
  ad_library_url: 'https://www.facebook.com/ads/library/?id=archive-1',
  snapshot: {
    body: { text: 'Build faster.' },
    cta_text: 'Learn more',
    images: [{ original_image_url: 'https://cdn.example.test/creative.jpg' }],
    videos: [{ video_hd_url: 'https://cdn.example.test/creative.mp4' }],
    cards: [{ original_image_url: 'https://cdn.example.test/card.jpg' }],
  },
}

test('Apify provider calls the Muppets actor with header auth and normalizes records', async () => {
  let requestedUrl = ''
  let requestedInit: RequestInit | undefined
  const provider = new ApifyMetaAdsProvider({
    apiToken: 'secret-test-token',
    facebookPageUrl: 'https://facebook.com/p/Orbit-61570484743438/',
    limit: 25,
    activeStatus: 'active',
    countryCode: 'US',
  }, {
    fetch: async (input, init) => {
      requestedUrl = String(input)
      requestedInit = init
      return jsonResponse([actorRecord])
    },
  })

  const result = await provider.collect(context)

  assert.equal(APIFY_META_ADS_ACTOR_ID, 'curious_coder~facebook-ads-library-scraper')
  assert.equal(requestedUrl, `https://api.apify.com/v2/acts/${APIFY_META_ADS_ACTOR_ID}/run-sync-get-dataset-items`)
  assert.equal(requestedUrl.includes('secret-test-token'), false)
  assert.equal(new Headers(requestedInit?.headers).get('authorization'), 'Bearer secret-test-token')
  assert.equal(requestedInit?.redirect, 'error')
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    count: 25,
    scrapeAdDetails: true,
    'scrapePageAds.activeStatus': 'active',
    'scrapePageAds.countryCode': 'US',
    urls: [{ url: 'https://www.facebook.com/profile.php?id=61570484743438', method: 'GET' }],
  })
  assert.deepEqual(result, [{
    platform: 'meta',
    externalId: 'archive-1',
    pageId: null,
    advertiserName: 'Orbit',
    body: 'Build faster.',
    headline: null,
    description: null,
    callToAction: 'Learn more',
    displayFormat: null,
    adType: 'video',
    startedAt: '2025-10-12T00:00:00.000Z',
    endedAt: null,
    isActive: true,
    publisherPlatforms: null,
    impressionsLowerBound: null,
    impressionsUpperBound: null,
    spendLowerBound: null,
    spendUpperBound: null,
    currency: null,
    media: [
      { kind: 'image', sourceUrl: 'https://cdn.example.test/creative.jpg', posterUrl: null, cardIndex: null, order: 0 },
      { kind: 'video', sourceUrl: 'https://cdn.example.test/creative.mp4', posterUrl: null, cardIndex: null, order: 1 },
      { kind: 'image', sourceUrl: 'https://cdn.example.test/card.jpg', posterUrl: null, cardIndex: 0, order: 2 },
    ],
    mediaUrls: [
      'https://cdn.example.test/creative.jpg',
      'https://cdn.example.test/creative.mp4',
      'https://cdn.example.test/card.jpg',
    ],
    sourceUrl: 'https://www.facebook.com/ads/library/?id=archive-1',
  }])
})

test('Apify marks a limit-sized collection partial because truncation cannot prove completeness', async () => {
  const provider = new ApifyMetaAdsProvider({ apiToken: 'secret-test-token', facebookPageUrl: 'https://facebook.com/orbit', limit: 10 }, {
    fetch: async () => jsonResponse(Array.from({ length: 10 }, (_, index) => ({ ...actorRecord, ad_archive_id: `bounded-${index}` }))),
  })
  const snapshot = await provider.collectSnapshot(context)
  assert.equal(snapshot.items.length, 10)
  assert.equal(snapshot.completeness, 'partial')
})

test('Apify provider preserves expanded metadata and structured media without inventing zero values', async () => {
  const provider = providerWithResponse([{
    ...actorRecord,
    page_id: 'page-123',
    end_date: 1_760_313_600,
    publisher_platform: ['facebook', 'instagram'],
    impressions: { lower_bound: '1000', upper_bound: '1999' },
    spend: { lower_bound: '25.50', upper_bound: '49.75', currency: 'USD' },
    snapshot: {
      ...actorRecord.snapshot,
      title: 'Move faster',
      link_description: 'One focused workspace',
      display_format: 'CAROUSEL',
      images: [],
      videos: [],
      cards: [
        { original_image_url: 'https://cdn.example.test/card-1.jpg' },
        {
          video_hd_url: 'https://cdn.example.test/card-2.mp4',
          video_preview_image_url: 'https://cdn.example.test/card-2-poster.jpg',
        },
      ],
    },
  }])

  const [ad] = await provider.collect(context)

  assert.deepEqual(ad, {
    platform: 'meta',
    externalId: 'archive-1',
    pageId: 'page-123',
    advertiserName: 'Orbit',
    body: 'Build faster.',
    headline: 'Move faster',
    description: 'One focused workspace',
    callToAction: 'Learn more',
    displayFormat: 'CAROUSEL',
    adType: 'carousel',
    startedAt: '2025-10-12T00:00:00.000Z',
    endedAt: '2025-10-13T00:00:00.000Z',
    isActive: true,
    publisherPlatforms: ['facebook', 'instagram'],
    impressionsLowerBound: 1000,
    impressionsUpperBound: 1999,
    spendLowerBound: 25.5,
    spendUpperBound: 49.75,
    currency: 'USD',
    media: [
      { kind: 'image', sourceUrl: 'https://cdn.example.test/card-1.jpg', posterUrl: null, cardIndex: 0, order: 0 },
      { kind: 'video', sourceUrl: 'https://cdn.example.test/card-2.mp4', posterUrl: 'https://cdn.example.test/card-2-poster.jpg', cardIndex: 1, order: 1 },
    ],
    mediaUrls: [
      'https://cdn.example.test/card-1.jpg',
      'https://cdn.example.test/card-2.mp4',
      'https://cdn.example.test/card-2-poster.jpg',
    ],
    sourceUrl: 'https://www.facebook.com/ads/library/?id=archive-1',
  })
})

test('Apify provider preserves card positions when cards reuse the same media URL', async () => {
  const shared = 'https://cdn.example.test/shared.jpg'
  const provider = providerWithResponse([{ ...actorRecord, snapshot: {
    ...actorRecord.snapshot, display_format: 'CAROUSEL', videos: [], images: [{ original_image_url: shared }],
    cards: [{ original_image_url: shared }, { original_image_url: shared }],
  } }])
  const [collected] = await provider.collect(context)
  assert.deepEqual(collected?.media?.map(({ sourceUrl, cardIndex, order }) => ({ sourceUrl, cardIndex, order })), [
    { sourceUrl: shared, cardIndex: null, order: 0 },
    { sourceUrl: shared, cardIndex: 0, order: 1 },
    { sourceUrl: shared, cardIndex: 1, order: 2 },
  ])
})

test('Facebook page normalization accepts only canonical Facebook HTTPS inputs', () => {
  assert.equal(normalizeFacebookPageUrl('https://www.facebook.com/profile.php?id=61570484743438'), 'https://www.facebook.com/profile.php?id=61570484743438')
  assert.equal(normalizeFacebookPageUrl('https://facebook.com/people/Orbit/61570484743438/'), 'https://www.facebook.com/profile.php?id=61570484743438')
  assert.equal(normalizeFacebookPageUrl('https://www.facebook.com/orbit/'), 'https://www.facebook.com/orbit')
  assert.throws(() => normalizeFacebookPageUrl('http://facebook.com/orbit'), /Facebook page URL is invalid/)
  assert.throws(() => normalizeFacebookPageUrl('https://evil.example/orbit'), /Facebook page URL is invalid/)
  assert.throws(() => normalizeFacebookPageUrl('https://facebook.com/orbit?token=secret'), /Facebook page URL is invalid/)
})

test('Apify provider rejects malformed records atomically with a fixed error', async () => {
  const provider = providerWithResponse([actorRecord, { ...actorRecord, ad_archive_id: '' }])
  await assert.rejects(provider.collect(context), exactProviderError)
})

test('Apify provider rejects an end timestamp before the start timestamp', async () => {
  const provider = providerWithResponse([{
    ...actorRecord,
    end_date: actorRecord.start_date - 1,
  }])

  await assert.rejects(provider.collect(context), exactProviderError)
})

test('Apify provider rejects non-string values in optional text fields', async () => {
  for (const invalidValue of [{ injected: true }, ['headline'], 123, false]) {
    const provider = providerWithResponse([{ ...actorRecord, page_id: invalidValue }])
    await assert.rejects(provider.collect(context), exactProviderError)
  }
})

test('Apify provider rejects duplicate IDs and oversized actor batches', async () => {
  await assert.rejects(providerWithResponse([actorRecord, actorRecord]).collect(context), exactProviderError)
  await assert.rejects(providerWithResponse(Array.from({ length: 131 }, (_, index) => ({ ...actorRecord, ad_archive_id: `ad-${index}` }))).collect(context), exactProviderError)
})

test('Apify provider sanitizes HTTP, JSON, network, timeout, and oversized response failures', async () => {
  await assert.rejects(providerWithFetch(async () => new Response(JSON.stringify({ error: { message: 'token leaked' } }), { status: 401, headers: { 'content-type': 'application/json' } })).collect(context), exactProviderError)
  await assert.rejects(providerWithFetch(async () => new Response('<html>proxy</html>', { status: 200, headers: { 'content-type': 'text/html' } })).collect(context), exactProviderError)
  await assert.rejects(providerWithFetch(async () => { throw new Error('request URL and token leaked') }).collect(context), exactProviderError)
  await assert.rejects(providerWithFetch(async () => new Response('[' + ' '.repeat(2_000) + ']', { status: 200, headers: { 'content-type': 'application/json' } }), { maxResponseBytes: 1_000 }).collect(context), exactProviderError)
  await assert.rejects(providerWithFetch(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  }), { timeoutMs: 5 }).collect(context), exactProviderError)
  const streaming = providerWithFetch(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('[')) },
  }), { status: 200, headers: { 'content-type': 'application/json' } }), { timeoutMs: 5 }).collect(context)
  await assert.rejects(Promise.race([
    streaming,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('deadline escaped')), 100)),
  ]), exactProviderError)
})

test('Apify provider cancels rejected response bodies before releasing capacity', async () => {
  const cases = [
    { status: 503, headers: { 'content-type': 'application/json' } },
    { status: 200, headers: { 'content-type': 'text/html' } },
    { status: 200, headers: { 'content-type': 'application/json', 'content-length': '1001' } },
  ]
  for (const responseInit of cases) {
    let cancelled = 0
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1 } })
    const provider = providerWithFetch(async () => new Response(stream, responseInit), { maxResponseBytes: 1_000 })
    await assert.rejects(provider.collect(context), exactProviderError)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(cancelled, 1)
    assert.equal(stream.locked, false)
  }
})

test('Apify provider cancels a late response body when fetch ignores the expired signal', async () => {
  let cancelled = 0
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('[')) },
    cancel() { cancelled += 1 },
  })
  const provider = providerWithFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  }, { timeoutMs: 5 })

  await assert.rejects(provider.collect(context), exactProviderError)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(cancelled, 1)
  assert.equal(stream.locked, false)
})

test('durable cooldown claim runs after gate acquisition and immediately before the Actor request', async () => {
  const gate = new ApifyRequestGate(1)
  let releaseGate: (() => void) | undefined
  const blocker = gate.run(
    async () => await new Promise<void>((resolve) => { releaseGate = resolve }),
    new AbortController().signal,
  )
  await new Promise((resolve) => setImmediate(resolve))
  const events: string[] = []
  const provider = new ApifyMetaAdsProvider({
    apiToken: 'secret-test-token',
    facebookPageUrl: 'https://www.facebook.com/orbit',
  }, {
    gate,
    beforeActorStart: async () => { events.push('claim') },
    fetch: async () => { events.push('fetch'); return jsonResponse([]) },
  })

  const collection = provider.collect(context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [])
  releaseGate?.()
  await blocker
  await collection
  assert.deepEqual(events, ['claim', 'fetch'])
})

test('an expired deadline after cooldown claim prevents a late Actor request', async () => {
  let actorStarts = 0
  const provider = new ApifyMetaAdsProvider({
    apiToken: 'secret-test-token',
    facebookPageUrl: 'https://www.facebook.com/orbit',
    timeoutMs: 5,
  }, {
    beforeActorStart: async () => { await new Promise((resolve) => setTimeout(resolve, 20)) },
    fetch: async () => { actorStarts += 1; return jsonResponse([]) },
  })

  await assert.rejects(provider.collect(context), exactProviderError)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(actorStarts, 0)
})

test('shared gate rejects overload instead of growing an unbounded queue', async () => {
  const gate = new ApifyRequestGate(1, 1)
  const releases: Array<() => void> = []
  const provider = new ApifyMetaAdsProvider({ apiToken: 'secret-test-token', facebookPageUrl: 'https://www.facebook.com/orbit', timeoutMs: 1_000 }, {
    gate,
    fetch: async () => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return jsonResponse([])
    },
  })
  const first = provider.collect(context)
  const second = provider.collect(context)
  await new Promise((resolve) => setImmediate(resolve))
  const overload = await Promise.race([
    provider.collect(context).then(() => 'resolved', (error: unknown) => exactProviderError(error) ? 'rejected' : 'wrong-error'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
  ])
  assert.equal(overload, 'rejected')
  releases.shift()?.()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  releases.shift()?.()
  await second
})

test('shared gate bounds concurrent actor runs without retrying them', async () => {
  const gate = new ApifyRequestGate(1)
  let started = 0
  const releases: Array<() => void> = []
  const makeProvider = () => new ApifyMetaAdsProvider({
    apiToken: 'secret-test-token',
    facebookPageUrl: 'https://www.facebook.com/orbit',
  }, {
    gate,
    fetch: async () => {
      started += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return jsonResponse([])
    },
  })
  const manualProvider = makeProvider()
  const scheduledProvider = makeProvider()

  const first = manualProvider.collect(context)
  const second = scheduledProvider.collect(context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, 1)
  releases.shift()?.()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, 2)
  releases.shift()?.()
  await second
  assert.equal(started, 2)
})

function providerWithResponse(records: unknown[]): ApifyMetaAdsProvider {
  return providerWithFetch(async () => jsonResponse(records))
}

function providerWithFetch(fetch: typeof globalThis.fetch, overrides: { timeoutMs?: number; maxResponseBytes?: number } = {}): ApifyMetaAdsProvider {
  return new ApifyMetaAdsProvider({
    apiToken: 'secret-test-token',
    facebookPageUrl: 'https://www.facebook.com/orbit',
    ...overrides,
  }, { fetch })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function exactProviderError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Apify provider request failed'
}

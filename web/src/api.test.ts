import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, createApiClient, exchangeStagingPassword } from './api.ts'

const connection = {
  apiBaseUrl: 'https://api.example.test/',
  accessToken: 'signed.jwt.value',
  organizationId: 'org / north',
}

describe('Creative Intelligence API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('strictly decodes Inspiration boards and items and builds bounded trusted-source routes', async () => {
    const board = { id: 'board-1', organizationId: 'org / north', name: 'Launch worlds', description: '', version: 1, archivedAt: null, createdAt: '2026-10-28T10:00:00.000Z', updatedAt: '2026-10-28T10:00:00.000Z' }
    const item = {
      id: 'inspiration-1', organizationId: 'org / north', boardId: board.id, sourceKind: 'competitor_ad', sourceId: 'ad-1', title: 'Kinetic proof', notes: '', tags: ['motion'],
      source: { provider: 'manual-meta', platform: 'meta', externalId: 'external-1', url: 'https://example.test/ad', advertiserName: 'Orbit' },
      copy: { body: 'Ship faster.', headline: 'Move faster' },
      media: [{ position: 0, kind: 'image', mediaType: 'image/png', checksum: 'a'.repeat(64), url: `/media/sha256/${'a'.repeat(64)}` }],
      version: 1, archivedAt: null, createdAt: '2026-10-28T10:00:00.000Z', updatedAt: '2026-10-28T10:00:00.000Z',
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [board], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ items: [item], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...item, media: [{ ...item.media[0], url: 'https://evil.test/x' }] }], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)
    await expect(client.listInspirationBoards()).resolves.toEqual({ items: [board], nextCursor: null })
    await expect(client.listInspirationItems({ boardId: board.id, search: 'proof', tag: 'motion', sourceKind: 'competitor_ad', sort: 'updated_desc' })).resolves.toEqual({ items: [item], nextCursor: null })
    await expect(client.updateInspirationItem(item.id, { expectedVersion: 1, boardId: board.id, title: item.title, notes: '', tags: ['motion'] })).resolves.toEqual(item)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.example.test/organizations/org%20%2F%20north/inspiration/boards?limit=100', 'GET'],
      ['https://api.example.test/organizations/org%20%2F%20north/inspiration/items?limit=100&boardId=board-1&search=proof&tag=motion&sourceKind=competitor_ad&sort=updated_desc', 'GET'],
      ['https://api.example.test/organizations/org%20%2F%20north/inspiration/items/inspiration-1', 'PATCH'],
    ])
    await expect(client.listInspirationItems()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('strictly decodes Winning Ads and uses bounded lifecycle routes', async () => {
    const item = {
      id: 'winning-1', organizationId: 'org / north', sourceAdId: 'ad-1', title: 'Launch reference', category: 'modern', notes: '',
      source: { provider: 'manual-meta', platform: 'meta', externalId: 'external-1', url: 'https://example.test/ad', advertiserName: 'Orbit', isActive: true },
      copy: { body: 'Ship faster.', headline: 'Move faster', description: null, callToAction: 'Learn more' },
      media: [{ position: 0, kind: 'image', mediaType: 'image/png', checksum: 'a'.repeat(64), url: `/media/sha256/${'a'.repeat(64)}` }],
      analysis: null, version: 1, archivedAt: null, createdAt: '2026-10-28T10:00:00.000Z', updatedAt: '2026-10-28T10:00:00.000Z',
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [item], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(item))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...item, category: 'retro' }], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)
    await expect(client.listWinningAds({ search: 'launch', category: 'modern', active: true })).resolves.toEqual({ items: [item], nextCursor: null })
    await expect(client.updateWinningAd('winning/1', { expectedVersion: 1, title: 'Launch reference', category: 'modern', notes: '' })).resolves.toEqual(item)
    await expect(client.removeWinningAd('winning/1')).resolves.toBeUndefined()
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.example.test/organizations/org%20%2F%20north/winning-ads?limit=100&search=launch&category=modern&active=true', 'GET'],
      ['https://api.example.test/organizations/org%20%2F%20north/winning-ads/winning%2F1', 'PATCH'],
      ['https://api.example.test/organizations/org%20%2F%20north/winning-ads/winning%2F1', 'DELETE'],
    ])
    await expect(client.listWinningAds()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('strictly decodes bounded Iteration Map brief evidence', async () => {
    const dimensions = { audience: 'Teams', market: 'US', angle: 'Speed', format: 'Video' }
    const covered = { dimensions, briefIds: ['brief-1'], briefs: [{ id: 'brief-1', title: 'Move quickly', status: 'production' }], briefCount: 1, hasMoreBriefs: false }
    const missing = { dimensions: { ...dimensions, angle: 'Proof' }, briefIds: [], briefs: [], briefCount: 0, hasMoreBriefs: false }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ totalCombinations: 2, covered: [covered], missing: [missing] }))
      .mockResolvedValueOnce(jsonResponse({ totalCombinations: 1, covered: [{ ...covered, briefCount: 0 }], missing: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)

    await expect(client.analyzeIterationMap('product/one', { audience: ['Teams'], market: ['US'], angle: ['Speed', 'Proof'], format: ['Video'] }))
      .resolves.toEqual({ totalCombinations: 2, covered: [covered], missing: [missing] })
    await expect(client.analyzeIterationMap('product/one', { audience: ['Teams'], market: ['US'], angle: ['Speed'], format: ['Video'] }))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('exchanges the staging password without sending an authorization header', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ accessToken: 'signed.jwt.value', organizationId: 'staging-org' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(exchangeStagingPassword('https://api.example.test/', ' password with spaces ')).resolves.toEqual({ accessToken: 'signed.jwt.value', organizationId: 'staging-org' })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.test/auth/staging-login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ' password with spaces ' }),
    })
  })

  it('rejects malformed staging login success responses', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ token: 'wrong-field' })))
    await expect(exchangeStagingPassword('https://api.example.test', 'password'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('authenticates requests, encodes path values, and serializes filters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient(connection)
    await client.listAds({ productId: 'product/one', competitorId: 'competitor two', isActive: true, provider: 'manual-meta', search: 'missed calls', hookCategory: 'pain_point', angle: 'rational', creativeFormat: 'ugc', bookmarked: true, sort: 'impressions_desc' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.test/organizations/org%20%2F%20north/ads?limit=100&productId=product%2Fone&competitorId=competitor+two&isActive=true&provider=manual-meta&search=missed+calls&hookCategory=pain_point&angle=rational&creativeFormat=ugc&bookmarked=true&sort=impressions_desc')
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer signed.jwt.value' },
    })
  })

  it('sets and strictly decodes private ad bookmarks', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ bookmarked: true }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createApiClient(connection).setAdBookmark('ad/one', true)).resolves.toEqual({ bookmarked: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/organizations/org%20%2F%20north/ads/ad%2Fone/bookmark',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ bookmarked: true }) }),
    )
  })

  it('edits, archives, and restores products through encoded lifecycle routes', async () => {
    const active = product('product / one')
    const archived = { ...active, archivedAt: '2026-10-28T00:00:00.000Z' }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ...active, name: 'Updated' }))
      .mockResolvedValueOnce(jsonResponse(archived))
      .mockResolvedValueOnce(jsonResponse(active))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)
    const draft = { name: 'Updated', markets: ['US'], platforms: ['web' as const], targetAudiences: ['Teams'], uniqueSellingPoints: ['Fast'] }

    await expect(client.updateProduct('product / one', draft)).resolves.toMatchObject({ name: 'Updated' })
    await expect(client.archiveProduct('product / one')).resolves.toEqual(archived)
    await expect(client.restoreProduct('product / one')).resolves.toEqual(active)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.example.test/organizations/org%20%2F%20north/products/product%20%2F%20one', 'PATCH'],
      ['https://api.example.test/organizations/org%20%2F%20north/products/product%20%2F%20one/archive', 'POST'],
      ['https://api.example.test/organizations/org%20%2F%20north/products/product%20%2F%20one/restore', 'POST'],
    ])
  })

  it('bounds product lifecycle identifiers before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)

    await expect(client.archiveProduct('x'.repeat(257))).rejects.toEqual(new ApiError(0, 'Resource ID is invalid'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('loads and strictly validates competitor analytics history and comparison', async () => {
    const snapshot = {
      snapshotDate: '2026-10-27', capturedAt: '2026-10-27T12:00:00.000Z', activeAdCount: 12, newAdsLast7d: 5,
      launchVelocityDelta: 3, avgDaysActive: 18.5, longRunnerCount: 4, formatMix: { image: 5, video: 6, carousel: 1, text: 0 },
      scaleScore: 88, newlyTracked: false,
    }
    const trend7d = { activeAdCountChange: 2, activeAdCountChangePercent: 20, scaleScoreChange: 4, direction: 'up' as const }
    const history = { label: 'Public Ad Library momentum proxy' as const, competitor: { id: 'competitor-1', name: 'Orbit' }, windowDays: 30 as const, trend7d, items: [snapshot] }
    const comparison = { label: 'Public Ad Library momentum proxy' as const, items: [
      { competitor: { id: 'competitor-2', name: 'Nova' }, latest: null, trend7d: null },
      { competitor: history.competitor, latest: snapshot, trend7d },
    ] }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(history))
      .mockResolvedValueOnce(jsonResponse(comparison))
      .mockResolvedValueOnce(jsonResponse({ ...history, trend7d: { ...trend7d, direction: 'sideways' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)

    await expect(client.getCompetitorAnalyticsHistory('product/one', 'competitor/one', 30)).resolves.toEqual(history)
    await expect(client.compareCompetitorAnalytics('product/one', ['competitor-2', 'competitor-1'])).resolves.toEqual(comparison)
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      'https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/competitors/competitor%2Fone/analytics/history?window=30',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      'https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/analytics/comparison',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ competitorIds: ['competitor-2', 'competitor-1'] }) }),
    )
    await expect(client.getCompetitorAnalyticsHistory('product/one', 'competitor/one', 30))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('loads and strictly validates product scaling analytics', async () => {
    const payload = {
      label: 'Scale signals',
      generatedAt: '2026-10-27T09:30:00.000Z',
      items: [{
        competitorId: 'competitor-1', competitorName: 'Orbit', activeAdCount: 12, newAdsLast7d: 5, newAdsPrev7d: 2,
        launchVelocityDelta: 3, avgDaysActive: 18.5, longRunnerCount: 4, formatMix: { image: 5, video: 6, carousel: 2, text: 1 },
        impressionWeight: 1.25, scaleScore: 88, newlyTracked: false,
      }],
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(connection).getScalingAnalytics('product/one')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/analytics/scaling',
      expect.objectContaining({ method: 'GET' }),
    )

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, unexpected: true }))
    await expect(createApiClient(connection).getScalingAnalytics('product/one'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, items: [{ ...payload.items[0], launchVelocityDelta: 1.5 }] }))
    await expect(createApiClient(connection).getScalingAnalytics('product/one'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, items: [{ ...payload.items[0], scaleScore: 87.5 }] }))
    await expect(createApiClient(connection).getScalingAnalytics('product/one'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('rejects scaling labels and competitor names beyond server bounds', async () => {
    const item = {
      competitorId: 'competitor-1', competitorName: 'Orbit', activeAdCount: 12, newAdsLast7d: 5, newAdsPrev7d: 2,
      launchVelocityDelta: 3, avgDaysActive: 18.5, longRunnerCount: 4, formatMix: { image: 5, video: 6, carousel: 2, text: 1 },
      scaleScore: 88, newlyTracked: false,
    }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ label: 'x'.repeat(201), generatedAt: '2026-10-27T09:30:00.000Z', items: [item] }))
      .mockResolvedValueOnce(jsonResponse({ label: 'x'.repeat(200), generatedAt: '2026-10-27T09:30:00.000Z', items: [{ ...item, competitorName: 'x'.repeat(301) }] }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)

    await expect(client.getScalingAnalytics('product-1')).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
    await expect(client.getScalingAnalytics('product-1')).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('updates briefs with optimistic concurrency and strictly validates version history', async () => {
    const brief = {
      id: 'brief-1', organizationId: 'org / north', productId: 'product-1', title: 'Ready', status: 'triage', sourceAdId: null,
      hook: 'Hook', callToAction: null, dimensions: { audience: 'students', market: 'US', angle: 'focus', format: 'video' },
      version: 2, createdAt: '2026-10-27T09:00:00.000Z', updatedAt: '2026-10-27T10:00:00.000Z',
    }
    const history = { items: [{ ...brief, changedBy: 'user-1', changedAt: '2026-10-27T10:00:00.000Z' }] }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(brief)).mockResolvedValueOnce(jsonResponse(history))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)

    await expect(client.updateBrief('brief / one', {
      expectedVersion: 1, title: 'Ready', status: 'triage', hook: 'Hook', callToAction: null, dimensions: brief.dimensions,
    })).resolves.toEqual(brief)
    await expect(client.listBriefVersions('brief / one')).resolves.toEqual(history.items)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/organizations/org%20%2F%20north/briefs/brief%20%2F%20one')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PATCH' })
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://api.example.test/organizations/org%20%2F%20north/briefs/brief%20%2F%20one/versions?limit=100')

    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ ...history.items[0], changedBy: '' }] }))
    await expect(client.listBriefVersions('brief-1')).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('creates and strictly decodes AI production briefs and handoffs', async () => {
    const details = {
      strategy: { targetAudience: 'Students', objective: 'conversion', keyMessage: 'Focus faster', tension: 'distraction', proofPoints: ['Fast'] },
      artDirection: { format: 'ugc', visualStyle: 'authentic', setting: 'Desk', talent: 'Student', audio: 'Voiceover', color: 'Brand', mandatoryElements: ['Logo'] },
      narrative: { storyArc: 'Problem to solution', hooks: [{ visual: 'Messy desk', spoken: 'Distracted?', onScreenText: 'Focus' }], bodyScript: 'Use the app.', ctas: ['Install'] },
      production: { aspectRatios: ['9:16'], durationSeconds: 30, deliverables: ['1 master'], shotList: [{ sequence: 1, description: 'Hook', audio: 'Distracted?', onScreenText: 'Focus' }], handoffNotes: 'Use cleared assets.', sourceAnalysis: { analysisVersion: 'gemini-grounded-v2', confidence: 0.9 } },
    }
    const brief = {
      id: 'brief-ai', organizationId: 'org / north', productId: 'product-1', title: 'AI brief', status: 'draft', sourceAdId: 'ad-1', hook: 'Hook', callToAction: 'Install',
      dimensions: { audience: 'Students', market: 'US', angle: 'emotional', format: 'ugc' }, details, version: 1,
      createdAt: '2026-10-28T10:00:00.000Z', updatedAt: '2026-10-28T10:00:00.000Z',
    }
    const handoff = { briefId: 'brief-ai', version: 1, filename: 'AI-brief-v1.md', markdown: '# AI brief' }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse(brief)).mockResolvedValueOnce(jsonResponse(handoff))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)

    await expect(client.createAiBriefFromAd('product/one', { adId: 'ad/one', title: 'AI brief' })).resolves.toEqual(brief)
    await expect(client.getBriefHandoff('brief/ai')).resolves.toEqual(handoff)
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/briefs/from-ad/ai', 'POST'],
      ['https://api.example.test/organizations/org%20%2F%20north/briefs/brief%2Fai/handoff', 'GET'],
    ])
  })

  it('requests and strictly validates creative analysis', async () => {
    const payload = {
      organizationId: 'org / north', productId: 'product-1', competitorAdId: 'ad-1', analysisVersion: 'v1',
      modelProvider: 'gemini', modelName: 'gemini-test', promptVersion: 'creative-tags-v2', inputFingerprint: 'a'.repeat(64),
      tags: {
        hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'Founder', format: 'tutorial',
        offerFrame: 'demo', cta: 'Start now', onScreenText: 'Launch today', visualSummary: 'Product walkthrough',
        funnelStage: 'consideration', confidence: 0.92,
      },
      analyzedAt: '2026-10-27T09:45:00.000Z', provenance: 'automatic', analysisMode: 'media', mediaCount: 1,
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(connection).analyzeCreative('product/one', 'ad / one')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/ads/ad%20%2F%20one/creative-analysis',
      expect.objectContaining({ method: 'POST' }),
    )

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, tags: { ...payload.tags, unknown: 'reject me' } }))
    await expect(createApiClient(connection).analyzeCreative('product/one', 'ad / one'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, tags: { ...payload.tags, confidence: 1.5 } }))
    await expect(createApiClient(connection).analyzeCreative('product/one', 'ad / one'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, tags: { ...payload.tags, hookCategory: 'invented' } }))
    await expect(createApiClient(connection).analyzeCreative('product/one', 'ad / one'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('requests and strictly validates a competitor creative strategy summary', async () => {
    const payload = {
      organizationId: 'org / north', productId: 'product-1', competitorId: 'competitor-1', totalAds: 8, analyzedAds: 5,
      dimensions: {
        hooks: [{ value: 'pain_point', count: 3, percentage: 60 }], angles: [], formats: [], emotions: [],
        personas: [{ value: 'Founders', count: 2, percentage: 40 }], offers: [], funnelStages: [],
      },
    }
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(connection).getCreativeStrategy('product/one', 'competitor / one')).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/competitors/competitor%20%2F%20one/creative-strategy',
      expect.objectContaining({ method: 'GET' }),
    )

    fetchMock.mockResolvedValueOnce(jsonResponse({ ...payload, dimensions: { ...payload.dimensions, hooks: [{ value: 'pain_point', count: 6, percentage: 120 }] } }))
    await expect(createApiClient(connection).getCreativeStrategy('product-1', 'competitor-1'))
      .rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('parses expanded nullable ad metadata and structured media without inventing zero values', async () => {
    const payload = { items: [{ ...ad('ad-1'),
      mirroredMediaUrls: [`/media/sha256/${'c'.repeat(64)}`, null],
      media: [{ ...ad('ad-1').media![0]!, mirroredUrl: `/media/sha256/${'a'.repeat(64)}`, mirroredPosterUrl: `/media/sha256/${'b'.repeat(64)}` }],
    }], nextCursor: null }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload)))
    const result = await createApiClient(connection).listAds()
    expect(result.items[0]).toMatchObject({ pageId: 'page-1', impressionsLowerBound: null, spendLowerBound: null, adType: 'video' })
    expect(result.items[0]?.media).toEqual([{
      kind: 'video', sourceUrl: 'https://example.com/video.mp4', mirroredUrl: `/media/sha256/${'a'.repeat(64)}`,
      posterUrl: 'https://example.com/poster.jpg', mirroredPosterUrl: `/media/sha256/${'b'.repeat(64)}`, cardIndex: null, order: 0,
    }])
    expect(result.items[0]?.mirroredMediaUrls).toEqual([`/media/sha256/${'c'.repeat(64)}`, null])

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [{ ...ad('bad-media'), media: [{ kind: 'image', sourceUrl: 'https://example.com/image.jpg', posterUrl: null, cardIndex: 50, order: 0 }] }], nextCursor: null,
    })))
    await expect(createApiClient(connection).listAds()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('starts Apify sync without a browser-visible provider credential and validates counts', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ inserted: 3, duplicates: 2 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(connection).syncApifyMetaAds('product/one', 'competitor two')).resolves.toEqual({ inserted: 3, duplicates: 2 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/organizations/org%20%2F%20north/products/product%2Fone/competitors/competitor%20two/ads/apify-meta/sync',
      expect.objectContaining({ method: 'POST', headers: { Accept: 'application/json', Authorization: 'Bearer signed.jwt.value' } }),
    )
  })

  it('surfaces only the API public error envelope', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: 'Access denied',
      detail: 'must never escape into UI',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })))

    const client = createApiClient(connection)
    await expect(client.listProducts()).rejects.toEqual(new ApiError(403, 'Access denied'))
  })

  it('fails closed when a success response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>proxy failure</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })))

    const client = createApiClient(connection)
    await expect(client.listProducts()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('never sends bearer tokens over non-loopback plain HTTP', () => {
    expect(() => createApiClient({ ...connection, apiBaseUrl: 'http://api.example.test' }))
      .toThrow(new ApiError(0, 'API URL must use HTTPS'))
    expect(() => createApiClient({ ...connection, apiBaseUrl: 'http://127.0.0.1:3000' })).not.toThrow()
  })

  it('follows authenticated cursors instead of silently truncating collections', async () => {
    const first = product('product-1')
    const second = product('product-2')
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [first], nextCursor: 'next/cursor' }))
      .mockResolvedValueOnce(jsonResponse({ items: [second], nextCursor: null }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createApiClient(connection).listProducts()).resolves.toEqual({ items: [first, second], nextCursor: null })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.test/organizations/org%20%2F%20north/products?limit=100&includeArchived=true',
      'https://api.example.test/organizations/org%20%2F%20north/products?limit=100&includeArchived=true&cursor=next%2Fcursor',
    ])
  })

  it('strictly decodes AI tag review provenance and serializes exact-identity decisions', async () => {
    const tags = { hookCategory: 'pain_point', angle: 'rational', emotion: 'relief', persona: 'Founder', format: 'ugc', offerFrame: 'demo', cta: 'Learn more', visualSummary: 'Founder demo', funnelStage: 'consideration', confidence: 0.9 }
    const analysis = { organizationId: 'org / north', productId: 'product-1', competitorAdId: 'ad-1', analysisVersion: 'v1', modelProvider: 'gemini', modelName: 'gemini-test', promptVersion: 'prompt-v1', inputFingerprint: 'a'.repeat(64), tags, analyzedAt: '2026-10-29T09:00:00.000Z', provenance: 'automatic', analysisMode: 'media', mediaCount: 1 }
    const review = { organizationId: 'org / north', productId: 'product-1', competitorAdId: 'ad-1', analysisVersion: 'v1', inputFingerprint: 'a'.repeat(64), reviewVersion: 1, decision: 'corrected', corrections: { format: 'tutorial' }, reason: 'Verified against source.', reviewerUserId: 'member-1', reviewedAt: '2026-10-29T10:00:00.000Z' }
    const item = { advertiserName: 'Orbit', analysis, status: 'corrected', review, originalTags: tags, effectiveTags: { ...tags, format: 'tutorial' }, stale: false }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [item] }))
      .mockResolvedValueOnce(jsonResponse(review, 201))
      .mockResolvedValueOnce(jsonResponse({ items: [review] }))
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...item, review: { ...review, reviewerUserId: '' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createApiClient(connection)
    await expect(client.listCreativeTagReviews({ productId: 'product-1', status: 'corrected' })).resolves.toEqual([item])
    await expect(client.submitCreativeTagReview('ad/1', { analysisVersion: 'v1', inputFingerprint: 'a'.repeat(64), expectedReviewVersion: 0, decision: 'corrected', corrections: { format: 'tutorial' }, reason: 'Verified against source.' })).resolves.toEqual(review)
    await expect(client.listCreativeTagReviewHistory('ad/1', 'v1', 'a'.repeat(64))).resolves.toEqual([review])
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.example.test/organizations/org%20%2F%20north/creative-tag-reviews?limit=100&productId=product-1&status=corrected', 'GET'],
      ['https://api.example.test/organizations/org%20%2F%20north/ads/ad%2F1/creative-tag-review', 'POST'],
      [`https://api.example.test/organizations/org%20%2F%20north/ads/ad%2F1/creative-tag-review/history?analysisVersion=v1&inputFingerprint=${'a'.repeat(64)}&limit=100`, 'GET'],
    ])
    await expect(client.listCreativeTagReviews()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })

  it('rejects malformed successful resources and unsafe external URLs', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [{ ...ad('ad-1'), sourceUrl: 'javascript:alert(1)' }], nextCursor: null,
    })))

    await expect(createApiClient(connection).listAds()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function product(id: string) {
  return {
    id, organizationId: 'org / north', name: 'Northstar', markets: ['US'], platforms: ['web'], targetAudiences: ['Founders'],
    uniqueSellingPoints: ['Fast setup'], archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
  }
}

function ad(id: string) {
  return {
    id, organizationId: 'org / north', productId: 'product-1', competitorId: 'competitor-1', providerName: 'manual-meta',
    platform: 'meta', externalId: 'external-1', pageId: 'page-1', advertiserName: 'Orbit', body: 'Evidence.',
    headline: 'Move faster', description: 'A focused workflow', callToAction: null, displayFormat: 'video', adType: 'video',
    startedAt: '2026-10-01T00:00:00.000Z', endedAt: null, isActive: true, publisherPlatforms: ['facebook'],
    impressionsLowerBound: null, impressionsUpperBound: null, spendLowerBound: null, spendUpperBound: null, currency: null,
    media: [{ kind: 'video', sourceUrl: 'https://example.com/video.mp4', posterUrl: 'https://example.com/poster.jpg', cardIndex: null, order: 0 }],
    mediaUrls: ['https://example.com/video.mp4', 'https://example.com/poster.jpg'], sourceUrl: 'https://example.com/ad',
    firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-02T00:00:00.000Z',
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, createApiClient } from './api.ts'

const connection = {
  apiBaseUrl: 'https://api.example.test/',
  accessToken: 'signed.jwt.value',
  organizationId: 'org / north',
}

describe('Creative Intelligence API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('authenticates requests, encodes path values, and serializes filters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createApiClient(connection)
    await client.listAds({ productId: 'product/one', competitorId: 'competitor two', isActive: true, provider: 'manual-meta' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.example.test/organizations/org%20%2F%20north/ads?limit=100&productId=product%2Fone&competitorId=competitor+two&isActive=true&provider=manual-meta')
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer signed.jwt.value' },
    })
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
      'https://api.example.test/organizations/org%20%2F%20north/products?limit=100',
      'https://api.example.test/organizations/org%20%2F%20north/products?limit=100&cursor=next%2Fcursor',
    ])
  })

  it('rejects malformed successful resources and unsafe external URLs', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      items: [{ ...ad('ad-1'), sourceUrl: 'javascript:alert(1)' }], nextCursor: null,
    })))

    await expect(createApiClient(connection).listAds()).rejects.toEqual(new ApiError(502, 'The API returned an invalid response'))
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
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
    platform: 'meta', externalId: 'external-1', advertiserName: 'Orbit', body: 'Evidence.', callToAction: null,
    startedAt: '2026-10-01T00:00:00.000Z', isActive: true, mediaUrls: [], sourceUrl: 'https://example.com/ad',
    firstSeenAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-10-02T00:00:00.000Z',
  }
}

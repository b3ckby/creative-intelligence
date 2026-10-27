// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CreativeIntelligenceApi } from './api.ts'
import { Workspace } from './Workspace.tsx'

const product = {
  id: 'product-1', organizationId: 'org-1', name: 'Northstar', markets: ['US'], platforms: ['ios' as const],
  targetAudiences: ['Founders'], uniqueSellingPoints: ['Fast setup'], archivedAt: null, createdAt: '2026-10-01T00:00:00.000Z',
}
const competitor = {
  id: 'competitor-1', organizationId: 'org-1', productId: product.id, name: 'Orbit', metaPageUrl: 'https://example.com/orbit',
  archivedAt: null, createdAt: '2026-10-02T00:00:00.000Z',
}
const ad = {
  id: 'ad-1', organizationId: 'org-1', productId: product.id, competitorId: competitor.id, providerName: 'manual-meta' as const,
  platform: 'meta' as const, externalId: 'external-1', advertiserName: 'Orbit', body: 'Ship campaigns without the spreadsheet.',
  callToAction: 'Learn more', startedAt: '2026-10-03T00:00:00.000Z', isActive: true, mediaUrls: [],
  sourceUrl: 'https://example.com/ad', firstSeenAt: '2026-10-03T00:00:00.000Z', lastSeenAt: '2026-10-04T00:00:00.000Z',
}
const brief = {
  id: 'brief-1', organizationId: 'org-1', productId: product.id, title: 'Founder speed', status: 'draft' as const,
  sourceAdId: ad.id, hook: ad.body, callToAction: ad.callToAction,
  dimensions: { audience: 'Founders', market: 'US', angle: 'Speed', format: 'Static' }, createdAt: '2026-10-05T00:00:00.000Z',
}

function api(): CreativeIntelligenceApi {
  return {
    listProducts: vi.fn().mockResolvedValue({ items: [product], nextCursor: null }),
    createProduct: vi.fn(),
    listCompetitors: vi.fn().mockResolvedValue({ items: [competitor], nextCursor: null }),
    createCompetitor: vi.fn(),
    syncApifyMetaAds: vi.fn().mockResolvedValue({ inserted: 0, duplicates: 0 }),
    listAds: vi.fn().mockResolvedValue({ items: [ad], nextCursor: null }),
    listBriefs: vi.fn().mockResolvedValue({ items: [brief], nextCursor: null }),
    createManualBrief: vi.fn().mockResolvedValue(brief),
    createBriefFromAd: vi.fn().mockResolvedValue(brief),
    analyzeIterationMap: vi.fn().mockResolvedValue({ totalCombinations: 1, covered: [{ dimensions: brief.dimensions, briefIds: [brief.id] }], missing: [] }),
  }
}

afterEach(cleanup)

describe('Creative Intelligence workspace', () => {
  it('loads a product context and exposes every MVP surface', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)

    expect(await screen.findByRole('heading', { name: 'Northstar' })).toBeTruthy()
    await waitFor(() => expect(client.listAds).toHaveBeenCalledWith({ productId: product.id }))

    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    expect(await screen.findByText('Ship campaigns without the spreadsheet.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    expect(await screen.findByText('Founder speed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Iteration Map' }))
    expect(screen.getByRole('button', { name: 'Analyze coverage' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))
    expect(await screen.findByText('Orbit')).toBeTruthy()
  })

  it('runs one competitor sync at a time and refreshes ads after success', async () => {
    const client = api()
    const pending = deferred<{ inserted: number; duplicates: number }>()
    vi.mocked(client.syncApifyMetaAds).mockReturnValue(pending.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))
    const sync = await screen.findByRole('button', { name: 'Sync ads for Orbit' })

    fireEvent.click(sync)
    fireEvent.click(sync)
    expect(client.syncApifyMetaAds).toHaveBeenCalledTimes(1)
    expect((sync as HTMLButtonElement).disabled).toBe(true)
    pending.resolve({ inserted: 3, duplicates: 2 })

    expect(await screen.findByText('3 new ads imported; 2 already current.')).toBeTruthy()
    await waitFor(() => expect(client.listAds).toHaveBeenCalledTimes(2))
  })

  it('refreshes the latest requested ad filters while that filter request is still pending', async () => {
    const client = api()
    const pendingSync = deferred<{ inserted: number; duplicates: number }>()
    const pendingFilter = deferred<{ items: typeof ad[]; nextCursor: null }>()
    vi.mocked(client.syncApifyMetaAds).mockReturnValue(pendingSync.promise)
    vi.mocked(client.listAds)
      .mockResolvedValueOnce({ items: [ad], nextCursor: null })
      .mockReturnValueOnce(pendingFilter.promise)
      .mockResolvedValueOnce({ items: [ad], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    await waitFor(() => expect(client.listAds).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sync ads for Orbit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    fireEvent.change(await screen.findByLabelText('Competitor'), { target: { value: competitor.id } })
    await waitFor(() => expect(client.listAds).toHaveBeenCalledTimes(2))

    pendingSync.resolve({ inserted: 1, duplicates: 0 })
    await waitFor(() => expect(client.listAds).toHaveBeenCalledTimes(3))
    expect(client.listAds).toHaveBeenLastCalledWith({ productId: product.id, competitorId: competitor.id })
    pendingFilter.resolve({ items: [ad], nextCursor: null })
  })

  it('creates a normalized manual brief from the builder', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    fireEvent.click(screen.getByRole('button', { name: 'New brief' }))

    fireEvent.change(screen.getByLabelText('Brief title'), { target: { value: 'Launch proof' } })
    fireEvent.change(screen.getByLabelText('Hook'), { target: { value: 'Show the work.' } })
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'Founders' } })
    fireEvent.change(screen.getByLabelText('Market'), { target: { value: 'US' } })
    fireEvent.change(screen.getByLabelText('Angle'), { target: { value: 'Proof' } })
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'Static' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))

    await waitFor(() => expect(client.createManualBrief).toHaveBeenCalledWith(product.id, {
      title: 'Launch proof', hook: 'Show the work.',
      dimensions: { audience: 'Founders', market: 'US', angle: 'Proof', format: 'Static' },
    }))
  })

  it('clears old product data while switching and keeps it cleared after a partial failure', async () => {
    const secondProduct = { ...product, id: 'product-2', name: 'Beacon' }
    const client = api()
    vi.mocked(client.listProducts).mockResolvedValue({ items: [product, secondProduct], nextCursor: null })
    vi.mocked(client.listCompetitors)
      .mockResolvedValueOnce({ items: [competitor], nextCursor: null })
      .mockRejectedValueOnce(new Error('New product unavailable'))
    vi.mocked(client.listAds).mockResolvedValueOnce({ items: [ad], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null })
    vi.mocked(client.listBriefs).mockResolvedValueOnce({ items: [brief], nextCursor: null }).mockResolvedValueOnce({ items: [], nextCursor: null })

    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Competitors' }))
    expect(await screen.findByText('Orbit')).toBeTruthy()

    fireEvent.change(screen.getByRole('combobox', { name: 'Select product' }), { target: { value: secondProduct.id } })
    expect(await screen.findByRole('heading', { name: 'Beacon' })).toBeTruthy()
    expect(screen.queryByText('Orbit')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toContain('New product unavailable')
    expect(screen.queryByText('Orbit')).toBeNull()
  })

  it('exposes active navigation state and an accessible dismissible dialog', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    const briefsButton = screen.getByRole('button', { name: 'Brief Builder' })
    fireEvent.click(briefsButton)
    expect(briefsButton.getAttribute('aria-pressed')).toBe('true')
    const trigger = screen.getByRole('button', { name: 'New brief' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'New creative brief' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })

  it('keeps failed form errors inside the dialog and focuses them', async () => {
    const client = api()
    vi.mocked(client.createManualBrief).mockRejectedValue(new Error('Brief could not be saved'))
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    fireEvent.click(screen.getByRole('button', { name: 'New brief' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Brief title'), { target: { value: 'Launch proof' } })
    fireEvent.change(within(dialog).getByLabelText('Hook'), { target: { value: 'Show the work.' } })
    fireEvent.change(within(dialog).getByLabelText('Audience'), { target: { value: 'Founders' } })
    fireEvent.change(within(dialog).getByLabelText('Market'), { target: { value: 'US' } })
    fireEvent.change(within(dialog).getByLabelText('Angle'), { target: { value: 'Proof' } })
    fireEvent.change(within(dialog).getByLabelText('Format'), { target: { value: 'Static' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save brief' }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toContain('Brief could not be saved')
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it('does not contact third-party media hosts until the user explicitly loads a creative', async () => {
    const client = api()
    vi.mocked(client.listAds).mockResolvedValue({ items: [{ ...ad, mediaUrls: ['https://media.example.com/creative.jpg'] }], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))

    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Load creative from Orbit' }))
    expect(screen.getByRole('img', { name: 'Orbit ad creative' })).toBeTruthy()
  })

  it('keeps a submitting dialog open until its mutation settles', async () => {
    const client = api()
    const pending = deferred<typeof brief>()
    vi.mocked(client.createManualBrief).mockReturnValue(pending.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    fireEvent.click(screen.getByRole('button', { name: 'New brief' }))
    fireEvent.change(screen.getByLabelText('Brief title'), { target: { value: 'Pending brief' } })
    fireEvent.change(screen.getByLabelText('Hook'), { target: { value: 'Wait for it' } })
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'Founders' } })
    fireEvent.change(screen.getByLabelText('Market'), { target: { value: 'US' } })
    fireEvent.change(screen.getByLabelText('Angle'), { target: { value: 'Proof' } })
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'Static' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save brief' }))
    await waitFor(() => expect(client.createManualBrief).toHaveBeenCalled())

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)

    pending.resolve(brief)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('ignores analysis results that finish after the selected product changes', async () => {
    const secondProduct = { ...product, id: 'product-2', name: 'Beacon', targetAudiences: ['Teams'] }
    const client = api()
    const pending = deferred<Awaited<ReturnType<CreativeIntelligenceApi['analyzeIterationMap']>>>()
    vi.mocked(client.listProducts).mockResolvedValue({ items: [product, secondProduct], nextCursor: null })
    vi.mocked(client.analyzeIterationMap).mockReturnValue(pending.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Iteration Map' }))
    fireEvent.click(screen.getByRole('button', { name: 'Analyze coverage' }))
    await waitFor(() => expect(client.analyzeIterationMap).toHaveBeenCalled())

    fireEvent.change(screen.getByRole('combobox', { name: 'Select product' }), { target: { value: secondProduct.id } })
    await screen.findByRole('heading', { name: 'Beacon' })
    pending.resolve({ totalCombinations: 1, covered: [{ dimensions: { audience: 'STALE', market: 'US', angle: 'Old result', format: 'Static' }, briefIds: ['brief-old'] }], missing: [] })
    await waitFor(() => expect(screen.queryByText('Old result')).toBeNull())
    expect(screen.getByText('Map the white space.')).toBeTruthy()
  })

  it('keeps the newest same-product analysis when responses finish out of order', async () => {
    const client = api()
    const first = deferred<Awaited<ReturnType<CreativeIntelligenceApi['analyzeIterationMap']>>>()
    const second = deferred<Awaited<ReturnType<CreativeIntelligenceApi['analyzeIterationMap']>>>()
    vi.mocked(client.analyzeIterationMap).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Iteration Map' }))
    const analyzeButton = screen.getByRole('button', { name: 'Analyze coverage' })
    fireEvent.click(analyzeButton)
    fireEvent.click(analyzeButton)
    await waitFor(() => expect(client.analyzeIterationMap).toHaveBeenCalledTimes(2))

    second.resolve({ totalCombinations: 1, covered: [{ dimensions: { audience: 'Founders', market: 'US', angle: 'Newest', format: 'Static' }, briefIds: ['brief-new'] }], missing: [] })
    expect(await screen.findByText('Newest')).toBeTruthy()
    first.resolve({ totalCombinations: 1, covered: [{ dimensions: { audience: 'Founders', market: 'US', angle: 'Stale', format: 'Static' }, briefIds: ['brief-old'] }], missing: [] })
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
    expect(screen.getByText('Newest')).toBeTruthy()
    expect(screen.queryByText('Stale')).toBeNull()
  })

  it('submits at most one from-ad brief while the first request is pending', async () => {
    const client = api()
    const pending = deferred<typeof brief>()
    vi.mocked(client.createBriefFromAd).mockReturnValue(pending.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    const createButton = await screen.findByRole('button', { name: 'Create brief' })
    fireEvent.click(createButton)
    fireEvent.click(createButton)

    await waitFor(() => expect(client.createBriefFromAd).toHaveBeenCalledTimes(1))
    expect((createButton as HTMLButtonElement).disabled).toBe(true)
    pending.resolve(brief)
    await screen.findByRole('heading', { name: 'Brief Builder' })
  })

  it('does not let a slow initial ad response replace a newer filtered result', async () => {
    const client = api()
    const initialAds = deferred<{ items: Array<typeof ad>; nextCursor: null }>()
    const filteredAd = { ...ad, id: 'ad-filtered', body: 'Filtered creative' }
    vi.mocked(client.listAds)
      .mockReturnValueOnce(initialAds.promise)
      .mockResolvedValueOnce({ items: [filteredAd], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'true' } })
    expect(await screen.findByText('Filtered creative')).toBeTruthy()

    initialAds.resolve({ items: [ad], nextCursor: null })
    await Promise.resolve()
    expect(screen.getByText('Filtered creative')).toBeTruthy()
    expect(screen.queryByText('Ship campaigns without the spreadsheet.')).toBeNull()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

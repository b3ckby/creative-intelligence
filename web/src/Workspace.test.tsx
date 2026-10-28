// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BRIEF_STATUS_TRANSITIONS } from '../../src/domain/brief-status-transitions.ts'
import type { CreativeIntelligenceApi } from './api.ts'
import type { BriefStatus } from './types.ts'
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
  platform: 'meta' as const, externalId: 'external-1', pageId: 'page-1', advertiserName: 'Orbit', body: 'Ship campaigns without the spreadsheet.',
  headline: 'Move faster', description: 'A focused campaign workflow.', callToAction: 'Learn more', displayFormat: 'video', adType: 'video' as const,
  startedAt: '2026-10-03T00:00:00.000Z', endedAt: null, isActive: true, publisherPlatforms: ['facebook', 'instagram'],
  impressionsLowerBound: 100, impressionsUpperBound: 200, spendLowerBound: null, spendUpperBound: null, currency: null, media: null, mediaUrls: [],
  sourceUrl: 'https://example.com/ad', firstSeenAt: '2026-10-03T00:00:00.000Z', lastSeenAt: '2026-10-04T00:00:00.000Z',
}
const brief = {
  id: 'brief-1', organizationId: 'org-1', productId: product.id, title: 'Founder speed', status: 'draft' as const,
  sourceAdId: ad.id, hook: ad.body, callToAction: ad.callToAction,
  dimensions: { audience: 'Founders', market: 'US', angle: 'Speed', format: 'Static' }, version: 1,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
}
const scaling = {
  label: 'Scale signals', generatedAt: '2026-10-27T09:30:00.000Z',
  items: [{
    competitorId: competitor.id, competitorName: competitor.name, activeAdCount: 12, newAdsLast7d: 5, newAdsPrev7d: 2,
    launchVelocityDelta: 3, avgDaysActive: 18.5, longRunnerCount: 4, formatMix: { image: 5, video: 6, carousel: 2, text: 1 },
    impressionWeight: 1.25, scaleScore: 88, newlyTracked: false,
  }],
}
const creativeAnalysis = {
  organizationId: 'org-1', productId: product.id, competitorAdId: ad.id, analysisVersion: 'v1',
  modelProvider: 'openai', modelName: 'gpt-5-mini', promptVersion: 'creative-tags-v2', inputFingerprint: 'sha256:abc',
  tags: {
    hookCategory: 'Problem agitation', angle: 'Speed', emotion: 'Relief', persona: 'Founder', format: 'Demo',
    offerFrame: 'Free trial', cta: 'Start now', onScreenText: 'Launch today', visualSummary: 'Product walkthrough',
    funnelStage: 'Consideration', confidence: 0.92,
  },
  analyzedAt: '2026-10-27T09:45:00.000Z',
}

function api(): CreativeIntelligenceApi {
  return {
    listProducts: vi.fn().mockResolvedValue({ items: [product], nextCursor: null }),
    createProduct: vi.fn(),
    updateProduct: vi.fn().mockResolvedValue({ ...product, name: 'Northstar Pro' }),
    archiveProduct: vi.fn().mockResolvedValue({ ...product, archivedAt: '2026-10-28T00:00:00.000Z' }),
    restoreProduct: vi.fn().mockResolvedValue(product),
    listCompetitors: vi.fn().mockResolvedValue({ items: [competitor], nextCursor: null }),
    createCompetitor: vi.fn(),
    syncApifyMetaAds: vi.fn().mockResolvedValue({ inserted: 0, duplicates: 0 }),
    listAds: vi.fn().mockResolvedValue({ items: [ad], nextCursor: null }),
    listBriefs: vi.fn().mockResolvedValue({ items: [brief], nextCursor: null }),
    createManualBrief: vi.fn().mockResolvedValue(brief),
    createBriefFromAd: vi.fn().mockResolvedValue(brief),
    updateBrief: vi.fn().mockResolvedValue({ ...brief, title: 'Founder velocity', status: 'triage', version: 2, updatedAt: '2026-10-06T00:00:00.000Z' }),
    listBriefVersions: vi.fn().mockResolvedValue([{ ...brief, changedBy: 'admin-1', changedAt: brief.createdAt }]),
    analyzeIterationMap: vi.fn().mockResolvedValue({ totalCombinations: 1, covered: [{ dimensions: brief.dimensions, briefIds: [brief.id] }], missing: [] }),
    getScalingAnalytics: vi.fn().mockResolvedValue(scaling),
    analyzeCreative: vi.fn().mockResolvedValue(creativeAnalysis),
  }
}

afterEach(cleanup)

describe('Creative Intelligence workspace', () => {
  it('edits the selected product from its product profile', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit product' }))
    const name = screen.getByLabelText('Product name')
    fireEvent.change(name, { target: { value: 'Northstar Pro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save product' }))

    await waitFor(() => expect(client.updateProduct).toHaveBeenCalledWith(product.id, expect.objectContaining({ name: 'Northstar Pro' })))
    expect(await screen.findByRole('heading', { name: 'Northstar Pro' })).toBeTruthy()
  })

  it('round-trips comma-bearing product list values through the editor', async () => {
    const client = api()
    const commaProduct = {
      ...product,
      markets: ['Washington, D.C.', 'New York'],
      targetAudiences: ['Founders, operators', 'Marketing teams'],
      uniqueSellingPoints: ['Fast, safe setup', 'No lock-in'],
    }
    vi.mocked(client.listProducts).mockResolvedValue({ items: [commaProduct], nextCursor: null })
    vi.mocked(client.updateProduct).mockResolvedValue(commaProduct)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })

    fireEvent.click(screen.getByRole('button', { name: 'Edit product' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save product' }))

    await waitFor(() => expect(client.updateProduct).toHaveBeenCalledWith(product.id, expect.objectContaining({
      markets: ['Washington, D.C.', 'New York'],
      targetAudiences: ['Founders, operators', 'Marketing teams'],
      uniqueSellingPoints: ['Fast, safe setup', 'No lock-in'],
    })))
  })

  it('clears descendant surfaces and creation actions when a product is archived', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))
    expect(await screen.findByText('Orbit')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Products' }))

    fireEvent.click(screen.getByRole('button', { name: 'Archive product' }))
    await screen.findByText('Archived')
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))

    expect(screen.queryByText('Orbit')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add competitor' })).toBeNull()
    expect(screen.getByText('Restore the product to access its descendants.')).toBeTruthy()
  })

  it('keeps the selected product descendants when another product archive resolves late', async () => {
    const secondProduct = { ...product, id: 'product-2', name: 'Beacon' }
    const secondCompetitor = { ...competitor, id: 'competitor-2', productId: secondProduct.id, name: 'Beacon Rival' }
    const archive = deferred<Awaited<ReturnType<CreativeIntelligenceApi['archiveProduct']>>>()
    const client = api()
    vi.mocked(client.listProducts).mockResolvedValue({ items: [product, secondProduct], nextCursor: null })
    vi.mocked(client.archiveProduct).mockReturnValue(archive.promise)
    vi.mocked(client.listCompetitors).mockImplementation(async (productId) => ({
      items: productId === secondProduct.id ? [secondCompetitor] : [competitor],
      nextCursor: null,
    }))
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })

    fireEvent.click(screen.getByRole('button', { name: 'Archive product' }))
    await waitFor(() => expect(client.archiveProduct).toHaveBeenCalledWith(product.id))
    fireEvent.change(screen.getByLabelText('Select product'), { target: { value: secondProduct.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))
    expect(await screen.findByText('Beacon Rival')).toBeTruthy()

    await act(async () => {
      archive.resolve({ ...product, archivedAt: '2026-10-28T00:00:00.000Z' })
    })

    expect(screen.getByText('Beacon Rival')).toBeTruthy()
    expect(client.listCompetitors).toHaveBeenCalledTimes(2)
    expect(client.listCompetitors).toHaveBeenLastCalledWith(secondProduct.id)

    fireEvent.change(screen.getByLabelText('Select product'), { target: { value: product.id } })
    expect(await screen.findByRole('heading', { name: 'Product archived' })).toBeTruthy()
  })

  it('reloads preserved descendants when an archived product is restored', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    await waitFor(() => expect(client.listCompetitors).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Archive product' }))
    await screen.findByText('Archived')
    fireEvent.click(screen.getByRole('button', { name: 'Restore product' }))
    await waitFor(() => expect(client.restoreProduct).toHaveBeenCalledWith(product.id))
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))

    expect(await screen.findByText('Orbit')).toBeTruthy()
    expect(client.listCompetitors).toHaveBeenCalledTimes(2)
    expect(client.listAds).toHaveBeenCalledTimes(2)
    expect(client.listBriefs).toHaveBeenCalledTimes(2)
  })

  it('archives and restores the selected product without removing it from the workspace', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })

    fireEvent.click(screen.getByRole('button', { name: 'Archive product' }))
    await waitFor(() => expect(client.archiveProduct).toHaveBeenCalledWith(product.id))
    expect(await screen.findByText('Archived')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore product' }))
    await waitFor(() => expect(client.restoreProduct).toHaveBeenCalledWith(product.id))
    expect(screen.queryByText('Archived')).toBeNull()
  })

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

  it('edits a brief with its current version and shows immutable history', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Founder speed' }))

    expect(await screen.findByRole('heading', { name: 'Edit creative brief' })).toBeTruthy()
    await waitFor(() => expect(client.listBriefVersions).toHaveBeenCalledWith(brief.id))
    expect(await screen.findByText(/Version 1 by admin-1/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Brief title'), { target: { value: 'Founder velocity' } })
    fireEvent.change(screen.getByLabelText('Brief status'), { target: { value: 'triage' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(client.updateBrief).toHaveBeenCalledWith(brief.id, expect.objectContaining({
      expectedVersion: 1, title: 'Founder velocity', status: 'triage',
    })))
    expect(await screen.findByText('Founder velocity')).toBeTruthy()
    expect(screen.getByText('triage')).toBeTruthy()
  })

  it.each(Object.entries(BRIEF_STATUS_TRANSITIONS) as Array<[BriefStatus, readonly BriefStatus[]]>)('offers shared backend-valid transitions from %s', async (status, expected) => {
    const client = api()
    vi.mocked(client.listBriefs).mockResolvedValue({ items: [{ ...brief, status }], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Founder speed' }))

    const options = within(screen.getByLabelText('Brief status')).getAllByRole('option').map((option) => option.getAttribute('value'))
    expect(options).toEqual(expected)
  })

  it('does not request Analytics for a product that starts or becomes archived', async () => {
    const initiallyArchivedClient = api()
    vi.mocked(initiallyArchivedClient.listProducts).mockResolvedValue({
      items: [{ ...product, archivedAt: '2026-10-28T00:00:00.000Z' }],
      nextCursor: null,
    })
    const initialView = render(<Workspace api={initiallyArchivedClient} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }))
    await act(async () => Promise.resolve())
    const initiallyArchivedCalls = vi.mocked(initiallyArchivedClient.getScalingAnalytics).mock.calls.length
    initialView.unmount()

    const archivedInSessionClient = api()
    render(<Workspace api={archivedInSessionClient} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Archive product' }))
    await screen.findByText('Archived')
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }))
    await act(async () => Promise.resolve())

    expect([
      initiallyArchivedCalls,
      vi.mocked(archivedInSessionClient.getScalingAnalytics).mock.calls.length,
    ]).toEqual([0, 0])
  })

  it('loads the Analytics surface on demand and explains proxy metrics', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })

    expect(client.getScalingAnalytics).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }))

    expect(await screen.findByRole('heading', { name: 'Scale signals' })).toBeTruthy()
    expect(client.getScalingAnalytics).toHaveBeenCalledWith(product.id)
    expect(screen.getByText('88')).toBeTruthy()
    expect(screen.getByText(/2 carousel/i)).toBeTruthy()
    expect(screen.getByText(/directional proxies/i)).toBeTruthy()
    expect(screen.getByText(/not verified spend or revenue/i)).toBeTruthy()
  })

  it('shows explicit Analytics loading and empty states', async () => {
    const client = api()
    const pending = deferred<typeof scaling>()
    vi.mocked(client.getScalingAnalytics).mockReturnValue(pending.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }))

    expect((await screen.findByRole('status')).textContent).toContain('Loading scaling signals')
    pending.resolve({ ...scaling, items: [] })
    expect(await screen.findByRole('heading', { name: 'No scaling signals yet' })).toBeTruthy()
  })

  it('keeps Analytics failures inside the surface', async () => {
    const client = api()
    vi.mocked(client.getScalingAnalytics).mockRejectedValue(new Error('Scaling signals are unavailable'))
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Scaling signals are unavailable')
    expect(screen.getByRole('heading', { name: 'Scaling signals' })).toBeTruthy()
  })

  it('shows the complete Meta page URL in the competitor list', async () => {
    const client = api()
    const fullMetaPageUrl = 'https://www.facebook.com/profile.php?id=61570484743438'
    vi.mocked(client.listCompetitors).mockResolvedValue({
      items: [{ ...competitor, metaPageUrl: fullMetaPageUrl }],
      nextCursor: null,
    })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }))

    expect(await screen.findByText(fullMetaPageUrl)).toBeTruthy()
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
    fireEvent.click(screen.getAllByRole('button', { name: 'New brief' })[0]!)

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
    const trigger = screen.getAllByRole('button', { name: 'New brief' })[0]!
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
    fireEvent.click(screen.getAllByRole('button', { name: 'New brief' })[0]!)
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

  it('loads image creatives immediately without a consent button', async () => {
    const client = api()
    vi.mocked(client.listAds).mockResolvedValue({ items: [{ ...ad, adType: 'image', mediaUrls: ['https://scontent-gru1-2.xx.fbcdn.net/creative.jpg'] }], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))

    const image = await screen.findByRole('img', { name: 'Orbit ad creative' })
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.queryByRole('button', { name: 'Load creative from Orbit' })).toBeNull()
  })

  it('does not auto-load media from an untrusted or private host', async () => {
    const client = api()
    vi.mocked(client.listAds).mockResolvedValue({ items: [{ ...ad, adType: 'image', mediaUrls: ['https://127.0.0.1/private.jpg'] }], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    await screen.findByText(ad.body)
    expect(screen.queryByRole('img', { name: 'Orbit ad creative' })).toBeNull()
    expect(screen.getByText('External media is not on an approved host.')).toBeTruthy()
  })

  it('rejects approved-host suffix confusion', async () => {
    const client = api()
    const hosts = [
      'fbcdn.net.evil.test', 'notfbcdn.net', 'facebook.com.evil.test',
      'notfacebook.com', 'fbsbx.com.evil.test', 'notfbsbx.com',
    ]
    vi.mocked(client.listAds).mockResolvedValue({
      items: hosts.map((host, index) => ({
        ...ad,
        id: `ad-${index}`,
        advertiserName: `Orbit ${index}`,
        adType: 'image' as const,
        mediaUrls: [`https://${host}/creative.jpg`],
      })),
      nextCursor: null,
    })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    await screen.findByText('Orbit 0')

    for (const index of hosts.keys()) {
      expect(screen.queryByRole('img', { name: `Orbit ${index} ad creative` })).toBeNull()
    }
    expect(screen.getAllByText('External media is not on an approved host.')).toHaveLength(hosts.length)
  })

  it('renders every ordered carousel card from approved Meta media hosts', async () => {
    const client = api()
    vi.mocked(client.listAds).mockResolvedValue({ items: [{ ...ad, adType: 'carousel', mediaUrls: [], media: [
      { kind: 'image', sourceUrl: 'https://scontent-gru1-2.xx.fbcdn.net/card-1.jpg', posterUrl: null, cardIndex: 0, order: 0 },
      { kind: 'image', sourceUrl: 'https://scontent-gru1-2.xx.fbcdn.net/card-2.jpg', posterUrl: null, cardIndex: 1, order: 1 },
    ] }], nextCursor: null })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    const carousel = await screen.findByRole('region', { name: 'Orbit carousel' })
    expect(within(carousel).getByRole('img', { name: 'Orbit ad creative card 1' })).toBeTruthy()
    expect(within(carousel).getByRole('img', { name: 'Orbit ad creative card 2' })).toBeTruthy()
  })

  it('renders opaque Facebook video URLs as playable video creatives', async () => {
    const client = api()
    vi.mocked(client.listAds).mockResolvedValue({
      items: [{
        ...ad,
        mediaUrls: [
          'https://scontent-gru1-2.xx.fbcdn.net/v/t39.35426-6/preview-token',
          'https://video-gru1-1.xx.fbcdn.net/o1/v/t2/f2/m366/opaque-video-token',
        ],
      }],
      nextCursor: null,
    })
    const { container } = render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))

    await waitFor(() => expect(container.querySelector('video')).not.toBeNull())
    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Load creative from Orbit' })).toBeNull()
    expect(video?.controls).toBe(true)
    expect(video?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(getComputedStyle(video!).objectFit).toBe('contain')
    expect(video?.getAttribute('poster')).toBe('https://scontent-gru1-2.xx.fbcdn.net/v/t39.35426-6/preview-token')
    expect(video?.querySelector('source')?.getAttribute('src')).toBe('https://video-gru1-1.xx.fbcdn.net/o1/v/t2/f2/m366/opaque-video-token')
  })

  it('does not force creatives into a cropped card aspect ratio', () => {
    const styles = readFileSync('web/src/styles.css', 'utf8')
    expect(styles).not.toMatch(/\.ad-visual\s*\{[^}]*aspect-ratio:\s*4\/3/su)
    expect(styles).toMatch(/\.ad-visual img[^}]*height:\s*auto/su)
    expect(styles).toMatch(/\.ad-visual video[^}]*height:\s*auto/su)
  })

  it('opens a complete creative detail dialog from an ad card', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View creative details for Orbit' }))

    const dialog = screen.getByRole('dialog', { name: 'Orbit creative' })
    expect(within(dialog).getByText(ad.body)).toBeTruthy()
    expect(within(dialog).getByText('Move faster')).toBeTruthy()
    expect(within(dialog).getByText('100–200')).toBeTruthy()
    expect(within(dialog).getByText('facebook, instagram')).toBeTruthy()
    expect(within(dialog).getByText('Not available')).toBeTruthy()
    expect(within(dialog).getByText('Learn more')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'Open original ad' }).getAttribute('href')).toBe(ad.sourceUrl)
  })

  it('analyzes a creative from its detail dialog and shows versioned model tags', async () => {
    const client = api()
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    fireEvent.click(await screen.findByRole('button', { name: 'View creative details for Orbit' }))
    const dialog = screen.getByRole('dialog', { name: 'Orbit creative' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Analyze creative' }))

    await waitFor(() => expect(client.analyzeCreative).toHaveBeenCalledWith(product.id, ad.id))
    expect(await within(dialog).findByText('Problem agitation')).toBeTruthy()
    expect(within(dialog).getByText('openai · gpt-5-mini')).toBeTruthy()
    expect(within(dialog).getByText('v1 · prompt creative-tags-v2')).toBeTruthy()
    expect(within(dialog).getByText('92% confidence')).toBeTruthy()
  })

  it('keeps focus inside the creative dialog across parent rerenders', async () => {
    const client = api()
    const view = render(<StrictMode><Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} /></StrictMode>)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    const trigger = await screen.findByRole('button', { name: 'View creative details for Orbit' })
    const restoreFocus = vi.spyOn(trigger, 'focus')
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Orbit creative' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    restoreFocus.mockClear()

    view.rerender(<StrictMode><Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} /></StrictMode>)
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(restoreFocus).not.toHaveBeenCalled()
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('restores focus to the creative opener after closing in StrictMode', async () => {
    const client = api()
    render(<StrictMode><Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} /></StrictMode>)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    const trigger = await screen.findByRole('button', { name: 'View creative details for Orbit' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Orbit creative' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }))
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(screen.queryByRole('dialog', { name: 'Orbit creative' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('filters creatives by text and media format in the browser', async () => {
    const client = api()
    vi.mocked(client.listAds).mockResolvedValue({
      items: [
        { ...ad, id: 'video-ad', body: 'Vertical product demo', adType: 'video', mediaUrls: ['https://cdn.example.test/demo.mp4'] },
        { ...ad, id: 'text-ad', body: 'Founder testimonial', adType: 'text', mediaUrls: [] },
      ],
      nextCursor: null,
    })
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Ad Library' }))
    expect(await screen.findByText('2 creatives')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Search creatives'), { target: { value: 'testimonial' } })
    expect(screen.getByText('1 creative')).toBeTruthy()
    expect(screen.queryByText('Vertical product demo')).toBeNull()

    fireEvent.change(screen.getByLabelText('Search creatives'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Media format'), { target: { value: 'video' } })
    expect(screen.getByText('1 creative')).toBeTruthy()
    expect(screen.queryByText('Founder testimonial')).toBeNull()
  })

  it('keeps a submitting dialog open until its mutation settles', async () => {
    const client = api()
    const pending = deferred<typeof brief>()
    vi.mocked(client.createManualBrief).mockReturnValue(pending.promise)
    render(<Workspace api={client} organizationLabel="Acme Studio" onDisconnect={() => undefined} />)
    await screen.findByRole('heading', { name: 'Northstar' })
    fireEvent.click(screen.getByRole('button', { name: 'Brief Builder' }))
    fireEvent.click(screen.getAllByRole('button', { name: 'New brief' })[0]!)
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

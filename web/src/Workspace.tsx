import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { BRIEF_STATUS_TRANSITIONS } from '../../src/domain/brief-status-transitions.ts'
import { ApiError, type AdFilters, type CreativeIntelligenceApi } from './api.ts'
import type {
  AnalyticsHistoryWindow,
  CompetitorAnalyticsComparison,
  CompetitorAnalyticsHistory,
  BriefDimensions,
  BriefStatus,
  Competitor,
  CompetitorAd,
  CreativeAnalysis,
  CreativeTagCorrections,
  CreativeTagReviewDecision,
  CreativeTagReviewItem,
  CreativeTagReviewStatus,
  CreativeStrategySummary,
  CreativeBrief,
  CreativeBriefVersion,
  IterationAxes,
  IterationCell,
  IterationMap,
  InspirationBoard,
  InspirationFilters,
  InspirationItem,
  Platform,
  Product,
  ScalingAnalytics,
  WinningAd,
  WinningAdCategory,
  WinningAdFilters,
} from './types.ts'

type Surface = 'overview' | 'competitors' | 'ads' | 'review' | 'winning' | 'inspiration' | 'briefs' | 'map' | 'analytics'

interface WorkspaceProps {
  api: CreativeIntelligenceApi
  organizationLabel: string
  onDisconnect: () => void
}

const surfaces: Array<{ id: Surface; label: string; index: string }> = [
  { id: 'overview', label: 'Products', index: '01' },
  { id: 'competitors', label: 'Competitors', index: '02' },
  { id: 'ads', label: 'Ad Library', index: '03' },
  { id: 'review', label: 'AI review', index: '04' },
  { id: 'winning', label: 'Winning Ads', index: '05' },
  { id: 'inspiration', label: 'Inspiration', index: '06' },
  { id: 'briefs', label: 'Brief Builder', index: '07' },
  { id: 'map', label: 'Iteration Map', index: '08' },
  { id: 'analytics', label: 'Analytics', index: '09' },
]

export function Workspace({ api, organizationLabel, onDisconnect }: WorkspaceProps) {
  const [surface, setSurface] = useState<Surface>('overview')
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProductId, setSelectedProductId] = useState('')
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [ads, setAds] = useState<CompetitorAd[]>([])
  const [winningAds, setWinningAds] = useState<WinningAd[]>([])
  const [winningFilters, setWinningFilters] = useState<WinningAdFilters>({})
  const [editingWinningAd, setEditingWinningAd] = useState<WinningAd | null>(null)
  const [winningLoading, setWinningLoading] = useState(false)
  const [winningError, setWinningError] = useState('')
  const [inspirationBoards, setInspirationBoards] = useState<InspirationBoard[]>([])
  const [inspirationItems, setInspirationItems] = useState<InspirationItem[]>([])
  const [inspirationFilters, setInspirationFilters] = useState<InspirationFilters>({ sort: 'updated_desc' })
  const [inspirationLoading, setInspirationLoading] = useState(false)
  const [inspirationError, setInspirationError] = useState('')
  const [briefs, setBriefs] = useState<CreativeBrief[]>([])
  const [iterationMap, setIterationMap] = useState<IterationMap | null>(null)
  const [iterationMapLoading, setIterationMapLoading] = useState(false)
  const [iterationMapError, setIterationMapError] = useState('')
  const [scalingAnalytics, setScalingAnalytics] = useState<ScalingAnalytics | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState('')
  const [pendingOperations, setPendingOperations] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [aiBriefErrors, setAiBriefErrors] = useState<Record<string, string>>({})
  const [showProductForm, setShowProductForm] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [productLifecyclePending, setProductLifecyclePending] = useState(false)
  const [showCompetitorForm, setShowCompetitorForm] = useState(false)
  const [showBriefForm, setShowBriefForm] = useState(false)
  const [briefSeed, setBriefSeed] = useState<BriefDimensions | null>(null)
  const [selectedAd, setSelectedAd] = useState<CompetitorAd | null>(null)
  const [selectedBrief, setSelectedBrief] = useState<CreativeBrief | null>(null)
  const [productionHandoff, setProductionHandoff] = useState<{ filename: string; markdown: string } | null>(null)
  const [adFilters, setAdFilters] = useState<AdFilters>({})
  const adFiltersRef = useRef<AdFilters>({})
  adFiltersRef.current = adFilters
  const [productLoadAttempt, setProductLoadAttempt] = useState(0)
  const [productsFailed, setProductsFailed] = useState(false)
  const [pendingBriefAdIds, setPendingBriefAdIds] = useState<Set<string>>(() => new Set())
  const [pendingBookmarkAdIds, setPendingBookmarkAdIds] = useState<Set<string>>(() => new Set())
  const [pendingSyncCompetitorIds, setPendingSyncCompetitorIds] = useState<Set<string>>(() => new Set())
  const detailRequest = useRef(0)
  const adsRequest = useRef(0)
  const analysisRequest = useRef(0)
  const briefMutationPending = useRef<Set<string>>(new Set())
  const syncMutationPending = useRef<Set<string>>(new Set())
  const loading = pendingOperations > 0

  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? products[0]
  const selectedProductRef = useRef('')
  selectedProductRef.current = selectedProduct?.id ?? ''
  const dialogOpen = showProductForm || editingProduct !== null || showCompetitorForm || showBriefForm || selectedAd !== null || selectedBrief !== null || editingWinningAd !== null || productionHandoff !== null

  useEffect(() => {
    let active = true
    setPendingOperations((count) => count + 1)
    setProductsFailed(false)
    setError('')
    api.listProducts()
      .then((page) => {
        if (!active) return
        setProducts(page.items)
        setSelectedProductId((current) => current || page.items[0]?.id || '')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setProducts([])
        setProductsFailed(true)
        setError(message(reason))
      })
      .finally(() => setPendingOperations((count) => Math.max(0, count - 1)))
    return () => { active = false }
  }, [api, productLoadAttempt])

  useEffect(() => {
    const requestId = ++detailRequest.current
    const adRequestId = ++adsRequest.current
    ++analysisRequest.current
    setCompetitors([])
    setAds([])
    setBriefs([])
    setSelectedAd(null)
    setSelectedBrief(null)
    setProductionHandoff(null)
    setAdFilters(selectedProduct ? { productId: selectedProduct.id } : {})
    setIterationMap(null)
    setIterationMapError('')
    setIterationMapLoading(false)
    if (!selectedProduct || selectedProduct.archivedAt !== null) return
    let active = true
    setPendingOperations((count) => count + 1)
    setError('')
    Promise.all([
      api.listCompetitors(selectedProduct.id),
      api.listAds({ productId: selectedProduct.id }),
      api.listBriefs(selectedProduct.id),
    ]).then(([competitorPage, adPage, briefPage]) => {
      if (!active || requestId !== detailRequest.current || selectedProductRef.current !== selectedProduct.id) return
      setCompetitors(competitorPage.items)
      if (adRequestId === adsRequest.current) setAds(adPage.items)
      setBriefs(briefPage.items)
    }).catch((reason: unknown) => {
      if (!active || requestId !== detailRequest.current) return
      setError(message(reason))
    }).finally(() => {
      setPendingOperations((count) => Math.max(0, count - 1))
    })
    return () => { active = false }
  }, [api, selectedProduct?.id, selectedProduct?.archivedAt])

  useEffect(() => {
    setScalingAnalytics(null)
    setAnalyticsError('')
    if (surface !== 'analytics' || !selectedProduct || selectedProduct.archivedAt !== null) return
    let active = true
    const productId = selectedProduct.id
    setAnalyticsLoading(true)
    api.getScalingAnalytics(productId)
      .then((result) => {
        if (active && selectedProductRef.current === productId) setScalingAnalytics(result)
      })
      .catch((reason: unknown) => {
        if (active && selectedProductRef.current === productId) setAnalyticsError(message(reason))
      })
      .finally(() => { if (active) setAnalyticsLoading(false) })
    return () => { active = false }
  }, [api, selectedProduct?.id, surface])

  useEffect(() => {
    if (surface !== 'winning') return
    let active = true
    setWinningLoading(true)
    setWinningError('')
    api.listWinningAds(winningFilters).then((page) => { if (active) setWinningAds(page.items) })
      .catch((reason: unknown) => { if (active) setWinningError(message(reason)) })
      .finally(() => { if (active) setWinningLoading(false) })
    return () => { active = false }
  }, [api, surface, winningFilters])

  useEffect(() => {
    if (surface !== 'inspiration') return
    let active = true
    setInspirationLoading(true); setInspirationError('')
    Promise.all([api.listInspirationBoards(), api.listInspirationItems(inspirationFilters), api.listWinningAds()])
      .then(([boards, items, winning]) => { if (active) { setInspirationBoards(boards.items); setInspirationItems(items.items); setWinningAds(winning.items) } })
      .catch((reason: unknown) => { if (active) setInspirationError(message(reason)) })
      .finally(() => { if (active) setInspirationLoading(false) })
    return () => { active = false }
  }, [api, surface, inspirationFilters])

  const reloadWinningAds = (filters: WinningAdFilters) => { setWinningFilters(filters) }

  const createInspirationBoard = async (draft: { name: string; description: string }) => {
    setInspirationError('')
    try {
      const created = await api.createInspirationBoard(draft)
      setInspirationBoards((current) => [created, ...current.filter(({ id }) => id !== created.id)])
      setNotice(`Inspiration board ${created.name} created.`)
      return true
    } catch (reason) { setInspirationError(message(reason)); return false }
  }

  const addInspiration = async (boardId: string, sourceKind: 'competitor_ad' | 'winning_ad', sourceId: string, title: string) => {
    const board = inspirationBoards.find(({ id }) => id === boardId)
    if (!board) return
    try {
      const created = await api.createInspirationItem(board.id, sourceKind, sourceId, { title, notes: '', tags: [] })
      setInspirationItems((current) => [created, ...current.filter(({ id }) => id !== created.id)])
      setNotice(`Reference added to ${board.name}.`)
    } catch (reason) { setError(message(reason)) }
  }

  const saveWinningAd = async (ad: CompetitorAd) => {
    if (!hasTrustedMirror(ad)) return
    setError('')
    try {
      const saved = await api.saveWinningAd(ad.id, { title: `${ad.advertiserName} reference`, category: 'modern', notes: '' })
      setWinningAds((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      setNotice('Creative saved to Winning Ads.')
    } catch (reason) { setError(message(reason)) }
  }

  const updateWinningAd = async (item: WinningAd, draft: { title: string; category: WinningAdCategory; notes: string }) => {
    const updated = await api.updateWinningAd(item.id, { ...draft, expectedVersion: item.version })
    setWinningAds((current) => current.map((entry) => entry.id === updated.id ? updated : entry))
    setEditingWinningAd(null)
    setNotice(`Winning Ad updated to version ${updated.version}.`)
  }

  const removeWinningAd = async (item: WinningAd) => {
    try {
      await api.removeWinningAd(item.id)
      setWinningAds((current) => current.filter((entry) => entry.id !== item.id))
      setNotice('Winning Ad removed; shared media remains protected.')
    } catch (reason) { setError(message(reason)) }
  }

  const reloadAds = async (filters: AdFilters) => {
    const productId = filters.productId
    if (!productId || productId !== selectedProductRef.current) return
    const requestId = ++adsRequest.current
    adFiltersRef.current = filters
    setAdFilters(filters)
    setPendingOperations((count) => count + 1)
    setError('')
    try {
      const page = await api.listAds(filters)
      if (requestId !== adsRequest.current || selectedProductRef.current !== productId) return
      setAds(page.items)
      setAdFilters(filters)
    } catch (reason) {
      if (requestId === adsRequest.current && selectedProductRef.current === productId) setError(message(reason))
    } finally {
      setPendingOperations((count) => Math.max(0, count - 1))
    }
  }

  const toggleAdBookmark = async (ad: CompetitorAd) => {
    if (pendingBookmarkAdIds.has(ad.id)) return
    const bookmarked = !ad.bookmarked
    setPendingBookmarkAdIds((current) => new Set(current).add(ad.id))
    setError('')
    try {
      await api.setAdBookmark(ad.id, bookmarked)
      setAds((current) => current
        .map((item) => item.id === ad.id ? { ...item, bookmarked } : item)
        .filter((item) => !adFiltersRef.current.bookmarked || item.bookmarked))
    } catch (reason) {
      setError(message(reason))
    } finally {
      setPendingBookmarkAdIds((current) => { const next = new Set(current); next.delete(ad.id); return next })
    }
  }

  const createProduct = async (draft: {
    name: string; markets: string[]; platforms: Platform[]; targetAudiences: string[]; uniqueSellingPoints: string[]
  }) => {
    const created = await api.createProduct(draft)
    setProducts((current) => [created, ...current])
    setSelectedProductId(created.id)
    setShowProductForm(false)
    setNotice('Product added to the workspace.')
  }

  const updateProduct = async (draft: {
    name: string; markets: string[]; platforms: Platform[]; targetAudiences: string[]; uniqueSellingPoints: string[]
  }) => {
    if (!editingProduct) return
    const updated = await api.updateProduct(editingProduct.id, draft)
    setProducts((current) => current.map((item) => item.id === updated.id ? updated : item))
    setEditingProduct(null)
    setNotice('Product updated.')
  }

  const toggleProductArchive = async () => {
    if (!selectedProduct || productLifecyclePending) return
    const productId = selectedProduct.id
    const wasArchived = selectedProduct.archivedAt !== null
    setProductLifecyclePending(true)
    setError('')
    try {
      const updated = wasArchived
        ? await api.restoreProduct(productId)
        : await api.archiveProduct(productId)
      setProducts((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (selectedProductRef.current !== productId) return
      if (updated.archivedAt !== null) {
        ++detailRequest.current
        ++adsRequest.current
        ++analysisRequest.current
        setCompetitors([])
        setAds([])
        setBriefs([])
        setIterationMap(null)
        setScalingAnalytics(null)
        setShowCompetitorForm(false)
        setShowBriefForm(false)
        setSelectedAd(null)
        setSelectedBrief(null)
      }
      setNotice(updated.archivedAt === null ? 'Product restored.' : 'Product archived.')
    } catch (reason) {
      if (selectedProductRef.current === productId) setError(message(reason))
    } finally {
      setProductLifecyclePending(false)
    }
  }

  const createCompetitor = async (draft: { name: string; metaPageUrl?: string | null }) => {
    if (!selectedProduct) return
    const productId = selectedProduct.id
    const generation = detailRequest.current
    const created = await api.createCompetitor(productId, draft)
    if (generation !== detailRequest.current || selectedProductRef.current !== productId) return
    setCompetitors((current) => [created, ...current])
    setShowCompetitorForm(false)
    setNotice('Competitor added.')
  }

  const createBrief = async (draft: {
    title: string; hook: string; callToAction?: string; dimensions: BriefDimensions
  }) => {
    if (!selectedProduct) return
    const productId = selectedProduct.id
    const generation = detailRequest.current
    const created = await api.createManualBrief(productId, draft)
    if (generation !== detailRequest.current || selectedProductRef.current !== productId) return
    setBriefs((current) => [created, ...current.filter((brief) => brief.id !== created.id)])
    setShowBriefForm(false)
    setNotice('Draft brief saved.')
  }

  const updateBrief = async (briefId: string, input: {
    expectedVersion: number; title: string; status: BriefStatus; hook: string; callToAction: string | null; dimensions: BriefDimensions
  }) => {
    const updated = await api.updateBrief(briefId, input)
    setBriefs((current) => current.map((item) => item.id === updated.id ? updated : item))
    setSelectedBrief(null)
    setNotice(`Brief updated to version ${updated.version}.`)
  }

  const syncCompetitorAds = async (competitor: Competitor) => {
    if (!selectedProduct || !competitor.metaPageUrl || syncMutationPending.current.has(competitor.id)) return
    syncMutationPending.current = new Set(syncMutationPending.current).add(competitor.id)
    setPendingSyncCompetitorIds(new Set(syncMutationPending.current))
    const productId = selectedProduct.id
    const generation = detailRequest.current
    setPendingOperations((count) => count + 1)
    setError('')
    setNotice('')
    try {
      const result = await api.syncApifyMetaAds(productId, competitor.id)
      if (generation !== detailRequest.current || selectedProductRef.current !== productId) return
      setNotice(`${result.inserted} new ads imported; ${result.duplicates} already current.`)
      await reloadAds({ ...adFiltersRef.current, productId })
    } catch (reason) {
      if (generation === detailRequest.current && selectedProductRef.current === productId) setError(message(reason))
    } finally {
      const pending = new Set(syncMutationPending.current)
      pending.delete(competitor.id)
      syncMutationPending.current = pending
      setPendingSyncCompetitorIds(new Set(pending))
      setPendingOperations((count) => Math.max(0, count - 1))
    }
  }

  const createBriefFromAd = async (selectedAd: CompetitorAd) => {
    if (!selectedProduct || briefMutationPending.current.has(selectedAd.id)) return
    briefMutationPending.current = new Set(briefMutationPending.current).add(selectedAd.id)
    setPendingBriefAdIds(new Set(briefMutationPending.current))
    const productId = selectedProduct.id
    const generation = detailRequest.current
    setError('')
    try {
      const created = await api.createBriefFromAd(productId, {
        adId: selectedAd.id,
        title: `${selectedAd.advertiserName} — creative response`,
        dimensions: {
          audience: selectedProduct.targetAudiences[0] ?? 'Unspecified audience',
          market: selectedProduct.markets[0] ?? 'Unspecified market',
          angle: 'Competitive response',
          format: selectedAd.mediaUrls.length > 0 ? 'Visual ad' : 'Text ad',
        },
      })
      if (generation !== detailRequest.current || selectedProductRef.current !== productId) return
      setBriefs((current) => [created, ...current])
      setSurface('briefs')
      setNotice('Brief created from the selected ad.')
    } catch (reason) {
      if (generation === detailRequest.current && selectedProductRef.current === productId) setError(message(reason))
    } finally {
      const pending = new Set(briefMutationPending.current)
      pending.delete(selectedAd.id)
      briefMutationPending.current = pending
      setPendingBriefAdIds(new Set(pending))
    }
  }

  const createAiBriefFromAd = async (selectedAd: CompetitorAd) => {
    if (!selectedProduct || briefMutationPending.current.has(selectedAd.id)) return
    briefMutationPending.current = new Set(briefMutationPending.current).add(selectedAd.id)
    setPendingBriefAdIds(new Set(briefMutationPending.current))
    const productId = selectedProduct.id
    const generation = detailRequest.current
    setError('')
    setAiBriefErrors((current) => {
      const next = { ...current }
      delete next[selectedAd.id]
      return next
    })
    try {
      const created = await api.createAiBriefFromAd(productId, { adId: selectedAd.id, title: `${selectedAd.advertiserName} — AI production brief` })
      if (generation !== detailRequest.current || selectedProductRef.current !== productId) return
      setBriefs((current) => [created, ...current.filter(({ id }) => id !== created.id)])
      setNotice('AI production brief created from the latest grounded analysis.')
    } catch (reason) {
      if (generation === detailRequest.current && selectedProductRef.current === productId) {
        const detail = reason instanceof ApiError && reason.status === 503
          ? 'AI analysis is unavailable because Gemini is not configured.'
          : message(reason)
        setError(detail)
        setAiBriefErrors((current) => ({ ...current, [selectedAd.id]: detail }))
      }
    } finally {
      const pending = new Set(briefMutationPending.current)
      pending.delete(selectedAd.id)
      briefMutationPending.current = pending
      setPendingBriefAdIds(new Set(pending))
    }
  }

  const openProductionHandoff = async (brief: CreativeBrief) => {
    setError('')
    try {
      const handoff = await api.getBriefHandoff(brief.id)
      setProductionHandoff({ filename: handoff.filename, markdown: handoff.markdown })
    } catch (reason) {
      setError(message(reason))
    }
  }

  const analyze = async (axes: IterationAxes) => {
    if (!selectedProduct) return
    const productId = selectedProduct.id
    const generation = detailRequest.current
    const requestId = ++analysisRequest.current
    setIterationMapLoading(true)
    setIterationMapError('')
    setPendingOperations((count) => count + 1)
    try {
      const result = await api.analyzeIterationMap(productId, axes)
      if (requestId === analysisRequest.current && generation === detailRequest.current && selectedProductRef.current === productId) setIterationMap(result)
    } catch (reason) {
      if (requestId === analysisRequest.current && generation === detailRequest.current && selectedProductRef.current === productId) setIterationMapError(message(reason))
    } finally {
      if (requestId === analysisRequest.current && generation === detailRequest.current && selectedProductRef.current === productId) setIterationMapLoading(false)
      setPendingOperations((count) => Math.max(0, count - 1))
    }
  }

  const analyzeCreative = async (ad: CompetitorAd): Promise<CreativeAnalysis> => {
    if (!selectedProduct || ad.productId !== selectedProduct.id) throw new Error('Select the matching product before analyzing this creative')
    return api.analyzeCreative(selectedProduct.id, ad.id)
  }

  return (
    <>
    <div className="workspace-shell" inert={dialogOpen ? true : undefined} aria-hidden={dialogOpen ? true : undefined}>
      <aside className="rail">
        <div className="brand-mark" aria-label="Creative Intelligence">
          <span className="brand-symbol">CI</span>
          <span className="brand-copy">Creative<br />Intelligence</span>
          <button className="mobile-disconnect" onClick={onDisconnect}>Disconnect</button>
        </div>
        <div className="organization-block">
          <span className="eyebrow">Workspace</span>
          <strong title={organizationLabel}>{organizationLabel}</strong>
        </div>
        <nav className="surface-nav" aria-label="Workspace sections">
          {surfaces.map((item) => (
            <button key={item.id} aria-label={item.label} aria-pressed={surface === item.id} className={surface === item.id ? 'active' : ''} onClick={() => setSurface(item.id)}>
              <span aria-hidden="true">{item.index}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <span className="security-dot" /> Secure API session
          <button className="text-button" onClick={onDisconnect}>Disconnect</button>
        </div>
      </aside>

      <main className="workspace-main" aria-busy={loading}>
        <header className="workspace-header">
          <div>
            <span className="eyebrow">Selected product</span>
            {selectedProduct ? <h1>{selectedProduct.name}</h1> : <h1>Product workspace</h1>}
          </div>
          <div className="header-actions">
            {products.length > 0 && (
              <label className="product-switcher">
                <span className="sr-only">Select product</span>
                <select value={selectedProduct?.id ?? ''} onChange={(event) => setSelectedProductId(event.target.value)}>
                  {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
                </select>
              </label>
            )}
            <button className="square-button" onClick={() => setShowProductForm(true)} aria-label="Add product">＋</button>
          </div>
        </header>

        {(error || notice) && (
          <div className={error ? 'message error' : 'message success'} role={error ? 'alert' : 'status'}>
            <span>{error || notice}</span>
            <button aria-label="Dismiss message" onClick={() => { setError(''); setNotice('') }}>×</button>
          </div>
        )}

        {loading && <div className="loading-line" role="progressbar" aria-label="Loading workspace" />}

        {!loading && products.length === 0 ? (
          productsFailed
            ? <EmptyPanel title="Products could not be loaded" copy="Check the connection or credentials, then try again." action="Retry" onAction={() => setProductLoadAttempt((attempt) => attempt + 1)} />
            : <EmptyWorkspace onAdd={() => setShowProductForm(true)} />
        ) : selectedProduct ? (
          <>
            {surface === 'overview' && <ProductOverview product={selectedProduct} competitors={competitors} ads={ads} briefs={briefs} lifecyclePending={productLifecyclePending} onEdit={() => setEditingProduct(selectedProduct)} onToggleArchive={toggleProductArchive} />}
            {surface !== 'overview' && selectedProduct.archivedAt !== null && <EmptyPanel title="Product archived" copy="Restore the product to access its descendants." />}
            {selectedProduct.archivedAt === null && <>
            {surface === 'competitors' && (
              <CompetitorsSurface
                competitors={competitors}
                pendingSyncIds={pendingSyncCompetitorIds}
                onAdd={() => setShowCompetitorForm(true)}
                onSync={syncCompetitorAds}
                onLoadStrategy={(competitorId) => api.getCreativeStrategy(selectedProduct.id, competitorId)}
              />
            )}
            {surface === 'ads' && (
              <AdsSurface
                ads={ads}
                competitors={competitors}
                filters={adFilters}
                productId={selectedProduct.id}
                pendingBriefAdIds={pendingBriefAdIds}
                aiBriefErrors={aiBriefErrors}
                pendingBookmarkAdIds={pendingBookmarkAdIds}
                onFilter={reloadAds}
                onBookmark={toggleAdBookmark}
                onSaveWinning={saveWinningAd}
                onCreateBrief={createBriefFromAd}
                onCreateAiBrief={createAiBriefFromAd}
                onInspect={setSelectedAd}
              />
            )}
            {surface === 'review' && (
              <AiTagReviewSurface api={api} productId={selectedProduct.id} />
            )}
            {surface === 'winning' && (
              <WinningAdsSurface items={winningAds} filters={winningFilters} loading={winningLoading} error={winningError} onFilter={reloadWinningAds} onEdit={setEditingWinningAd} onRemove={removeWinningAd} />
            )}
            {surface === 'inspiration' && (
              <InspirationSurface boards={inspirationBoards} items={inspirationItems} adCandidates={ads.filter(hasTrustedMirror)} winningCandidates={winningAds.filter((item) => item.media.some(({ url }) => isMirroredMediaReference(url)))} filters={inspirationFilters} loading={inspirationLoading} error={inspirationError} onFilter={setInspirationFilters} onCreateBoard={createInspirationBoard} onAdd={addInspiration} />
            )}
            {surface === 'briefs' && (
              <BriefsSurface briefs={briefs} onAdd={() => setShowBriefForm(true)} onEdit={setSelectedBrief} onHandoff={openProductionHandoff} />
            )}
            {surface === 'map' && (
              <IterationMapSurface product={selectedProduct} briefs={briefs} result={iterationMap} loading={iterationMapLoading} error={iterationMapError} onAnalyze={analyze} onCreateGap={(dimensions) => { setBriefSeed(dimensions); setShowBriefForm(true) }} />
            )}
            {surface === 'analytics' && (
              <AnalyticsSurface api={api} productId={selectedProduct.id} competitors={competitors} result={scalingAnalytics} loading={analyticsLoading} error={analyticsError} />
            )}
            </>}
          </>
        ) : null}
      </main>

    </div>
      {showProductForm && <ProductDialog onClose={() => setShowProductForm(false)} onSubmit={createProduct} />}
      {editingProduct && <ProductDialog product={editingProduct} onClose={() => setEditingProduct(null)} onSubmit={updateProduct} />}
      {showCompetitorForm && <CompetitorDialog onClose={() => setShowCompetitorForm(false)} onSubmit={createCompetitor} />}
      {showBriefForm && <BriefDialog product={selectedProduct} seed={briefSeed} onClose={() => { setShowBriefForm(false); setBriefSeed(null) }} onSubmit={createBrief} />}
      {selectedBrief && <EditBriefDialog brief={selectedBrief} loadVersions={api.listBriefVersions} onClose={() => setSelectedBrief(null)} onSubmit={updateBrief} />}
      {selectedAd && <CreativeDetailDialog ad={selectedAd} pending={pendingBriefAdIds.has(selectedAd.id)} onClose={() => setSelectedAd(null)} onCreateBrief={createBriefFromAd} onAnalyze={analyzeCreative} />}
      {editingWinningAd && <WinningAdDialog item={editingWinningAd} onClose={() => setEditingWinningAd(null)} onSubmit={(draft) => updateWinningAd(editingWinningAd, draft)} />}
      {productionHandoff && <Dialog title="Production handoff" onClose={() => setProductionHandoff(null)}><div className="dialog-form"><pre className="production-handoff">{productionHandoff.markdown}</pre><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setProductionHandoff(null)}>Close</button><a className="primary-button" download={productionHandoff.filename} href={`data:text/markdown;charset=utf-8,${encodeURIComponent(productionHandoff.markdown)}`}>Download .md</a></div></div></Dialog>}
    </>
  )
}

function ProductOverview({ product, competitors, ads, briefs, lifecyclePending, onEdit, onToggleArchive }: {
  product: Product; competitors: Competitor[]; ads: CompetitorAd[]; briefs: CreativeBrief[]; lifecyclePending: boolean; onEdit: () => void; onToggleArchive: () => Promise<void>
}) {
  const activeAds = ads.filter((ad) => ad.isActive).length
  return (
    <section className="surface overview-surface">
      <div className="surface-intro split-intro">
        <div><span className="eyebrow">Product intelligence</span><h2>Evidence before ideas.</h2></div>
        <p>Track the competitive field, turn useful signals into briefs, then inspect where the creative plan is still thin.</p>
      </div>
      <div className="metric-strip">
        <Metric value={competitors.length} label="competitors tracked" />
        <Metric value={ads.length} label="ads in view" accent />
        <Metric value={activeAds} label="active creatives" />
        <Metric value={briefs.length} label="briefs drafted" />
      </div>
      <div className="overview-grid">
        <article className="product-profile paper-panel">
          <div className="panel-heading"><span>Product profile</span><small>{product.platforms.join(' · ') || 'No platform'}</small></div>
          <dl>
            <div><dt>Markets</dt><dd>{product.markets.join(', ') || 'Not set'}</dd></div>
            <div><dt>Audience</dt><dd>{product.targetAudiences.join(', ') || 'Not set'}</dd></div>
            <div><dt>Promise</dt><dd>{product.uniqueSellingPoints.join(' · ') || 'Not set'}</dd></div>
          </dl>
          {product.archivedAt && <span className="status-pill muted">Archived</span>}
          <div className="card-actions">
            <button type="button" className="text-button" onClick={onEdit}>Edit product</button>
            <button type="button" className="text-button" disabled={lifecyclePending} onClick={() => void onToggleArchive()}>{product.archivedAt ? 'Restore product' : 'Archive product'}</button>
          </div>
        </article>
        <article className="signal-board ink-panel">
          <div className="panel-heading"><span>Signal board</span><small>live snapshot</small></div>
          <div className="signal-list">
            {ads.slice(0, 3).map((ad, index) => (
              <div key={ad.id}><span>0{index + 1}</span><p>{ad.body || `${ad.advertiserName} visual creative`}</p><small>{ad.advertiserName}</small></div>
            ))}
            {ads.length === 0 && <p className="quiet-copy">Import ads to begin building a competitive point of view.</p>}
          </div>
        </article>
      </div>
    </section>
  )
}

function Metric({ value, label, accent = false }: { value: number; label: string; accent?: boolean }) {
  return <div className={accent ? 'metric accent' : 'metric'}><strong>{String(value).padStart(2, '0')}</strong><span>{label}</span></div>
}

function CompetitorsSurface({ competitors, pendingSyncIds, onAdd, onSync, onLoadStrategy }: {
  competitors: Competitor[]
  pendingSyncIds: ReadonlySet<string>
  onAdd: () => void
  onSync: (competitor: Competitor) => Promise<void>
  onLoadStrategy: (competitorId: string) => Promise<CreativeStrategySummary>
}) {
  const [strategyCompetitorId, setStrategyCompetitorId] = useState('')
  const [strategy, setStrategy] = useState<CreativeStrategySummary | null>(null)
  const [strategyLoading, setStrategyLoading] = useState(false)
  const [strategyError, setStrategyError] = useState('')
  const strategyRequest = useRef(0)
  const openStrategy = async (competitorId: string) => {
    if (strategyCompetitorId === competitorId) {
      ++strategyRequest.current
      setStrategyCompetitorId(''); setStrategy(null); setStrategyError(''); setStrategyLoading(false)
      return
    }
    const requestId = ++strategyRequest.current
    setStrategyCompetitorId(competitorId); setStrategy(null); setStrategyError(''); setStrategyLoading(true)
    try {
      const result = await onLoadStrategy(competitorId)
      if (requestId === strategyRequest.current) setStrategy(result)
    } catch (reason) {
      if (requestId === strategyRequest.current) setStrategyError(message(reason))
    } finally {
      if (requestId === strategyRequest.current) setStrategyLoading(false)
    }
  }
  const selectedCompetitor = competitors.find((item) => item.id === strategyCompetitorId)
  return (
    <section className="surface">
      <SurfaceHeading eyebrow="Competitive set" title="Know who shapes the category." action="Add competitor" onAction={onAdd} />
      <div className="competitor-list">
        {competitors.map((competitor, index) => (
          <article key={competitor.id} className="competitor-row">
            <span className="row-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="competitor-details"><h3>{competitor.name}</h3><p>{competitor.metaPageUrl ?? 'Meta page not linked'}</p></div>
            <span className={competitor.archivedAt ? 'status-pill muted' : 'status-pill'}>{competitor.archivedAt ? 'Archived' : 'Tracking'}</span>
            {competitor.metaPageUrl && !competitor.archivedAt && (
              <button
                className="secondary-button"
                aria-label={`Sync ads for ${competitor.name}`}
                disabled={pendingSyncIds.has(competitor.id)}
                onClick={() => void onSync(competitor)}
              >{pendingSyncIds.has(competitor.id) ? 'Syncing…' : 'Sync ads'}</button>
            )}
            {!competitor.archivedAt && <button className="secondary-button" aria-label={`View creative strategy for ${competitor.name}`} onClick={() => void openStrategy(competitor.id)}>Creative strategy</button>}
            {competitor.metaPageUrl && <a href={competitor.metaPageUrl} target="_blank" rel="noreferrer">Open source ↗</a>}
          </article>
        ))}
        {competitors.length === 0 && <EmptyPanel title="No competitors yet" copy="Add the first company you want to study." action="Add competitor" onAction={onAdd} />}
      </div>
      {selectedCompetitor && (
        <section className="panel-card creative-strategy" aria-label={`${selectedCompetitor.name} creative strategy`}>
          <div className="panel-heading"><div><span className="eyebrow">AI pattern rollup</span><h3>{selectedCompetitor.name} creative strategy</h3></div></div>
          {strategyLoading && <p className="quiet-copy">Loading creative strategy…</p>}
          {strategyError && <div className="form-error" role="alert">{strategyError}</div>}
          {!strategyLoading && strategy && strategy.analyzedAds === 0 && <p className="quiet-copy">No analyzed ads yet.</p>}
          {!strategyLoading && strategy && strategy.analyzedAds > 0 && <>
            <div className="strategy-dimensions">
              {(Object.entries(strategy.dimensions) as Array<[keyof CreativeStrategySummary['dimensions'], CreativeStrategySummary['dimensions']['hooks']]>).map(([dimension, values]) => values.length > 0 && (
                <div className="strategy-dimension" key={dimension}><strong>{strategyDimensionLabel(dimension)}</strong><div className="analysis-tags">{values.map((item) => <span className="analysis-tag" key={item.value}>{item.value.replaceAll('_', ' ')} <b>{item.percentage}%</b></span>)}</div></div>
              ))}
            </div>
            <p className="quiet-copy">Based on {strategy.analyzedAds} of {strategy.totalAds} analyzed ads. Uses effective human-reviewed tags; rejected analyses are excluded and raw model tags remain visible in AI review.</p>
          </>}
        </section>
      )}
    </section>
  )
}

function strategyDimensionLabel(dimension: keyof CreativeStrategySummary['dimensions']): string {
  return ({ hooks: 'Hooks', angles: 'Angles', formats: 'Formats', emotions: 'Emotions', personas: 'Personas', offers: 'Offers', funnelStages: 'Funnel stages' })[dimension]
}

function InspirationSurface({ boards, items, adCandidates, winningCandidates, filters, loading, error, onFilter, onCreateBoard, onAdd }: {
  boards: InspirationBoard[]; items: InspirationItem[]; filters: InspirationFilters; loading: boolean; error: string
  adCandidates: CompetitorAd[]; winningCandidates: WinningAd[]
  onFilter: (filters: InspirationFilters) => void
  onCreateBoard: (draft: { name: string; description: string }) => Promise<boolean>
  onAdd: (boardId: string, sourceKind: 'competitor_ad' | 'winning_ad', sourceId: string, title: string) => Promise<void>
}) {
  const [search, setSearch] = useState(filters.search ?? '')
  const [boardId, setBoardId] = useState(filters.boardId ?? '')
  const [boardName, setBoardName] = useState('')
  const [boardDescription, setBoardDescription] = useState('')
  const [creatingBoard, setCreatingBoard] = useState(false)
  const destinationBoard = boards.find(({ id }) => id === boardId) ?? boards[0]
  return <section className="surface inspiration-surface">
    <div className="inspiration-hero">
      <span className="eyebrow">Reference desk · not a performance ranking</span>
      <h2>Inspiration Library</h2>
      <p>Arrange reusable visual and strategic references into working boards. Winning Ads stays the curated ad collection; this space is for patterns, notes, and recombination.</p>
    </div>
    <form className="inspiration-filter" onSubmit={(event) => { event.preventDefault(); onFilter({ ...filters, ...(search ? { search } : {}), ...(boardId ? { boardId } : {}) }) }}>
      <label>Search inspiration<input aria-label="Search inspiration" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} placeholder="Composition, motion, proof…" /></label>
      <label>Board<select aria-label="Inspiration board" value={boardId} onChange={(event) => setBoardId(event.target.value)}><option value="">All boards</option>{boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}</select></label>
      <label>Sort<select aria-label="Sort inspiration" value={filters.sort ?? 'updated_desc'} onChange={(event) => onFilter({ ...filters, sort: event.target.value as NonNullable<InspirationFilters['sort']> })}><option value="updated_desc">Recently refined</option><option value="created_desc">Newest saved</option><option value="created_asc">Oldest saved</option></select></label>
      <button className="primary-button" aria-label="Filter inspiration" type="submit">Explore references</button>
    </form>
    {destinationBoard && (adCandidates.length > 0 || winningCandidates.length > 0) && <aside className="inspiration-candidates" aria-label="Trusted references ready to add"><strong>Ready for {destinationBoard.name}</strong>{adCandidates.slice(0, 4).map((ad) => <button key={`ad:${ad.id}`} type="button" aria-label={`Add ${ad.advertiserName} to ${destinationBoard.name}`} onClick={() => { void onAdd(destinationBoard.id, 'competitor_ad', ad.id, `${ad.advertiserName} visual reference`) }}>＋ {ad.advertiserName}</button>)}{winningCandidates.slice(0, 4).map((item) => <button key={`winning:${item.id}`} type="button" aria-label={`Add Winning Ad ${item.title} to ${destinationBoard.name}`} onClick={() => { void onAdd(destinationBoard.id, 'winning_ad', item.id, item.title) }}>＋ Winning Ad · {item.title}</button>)}</aside>}
    {boards.length === 0 && !loading && !error && <form className="inspiration-board-form" onSubmit={(event) => { event.preventDefault(); setCreatingBoard(true); void onCreateBoard({ name: boardName, description: boardDescription }).then((created) => { if (created) { setBoardName(''); setBoardDescription('') } }).finally(() => setCreatingBoard(false)) }}>
      <div><span className="eyebrow">First collection</span><h3>Create an inspiration board</h3><p>Boards keep reusable visual and strategic patterns separate from the curated Winning Ads library.</p></div>
      <label>Board name<input aria-label="Board name" required maxLength={200} value={boardName} onChange={(event) => setBoardName(event.target.value)} /></label>
      <label>Board description<textarea aria-label="Board description" maxLength={1000} value={boardDescription} onChange={(event) => setBoardDescription(event.target.value)} /></label>
      <button className="primary-button" type="submit" disabled={creatingBoard} aria-label="Create inspiration board">{creatingBoard ? 'Creating board…' : 'Create board'}</button>
    </form>}
    {loading ? <div className="analytics-state" role="status">Opening the reference drawers…</div>
      : error ? <div className="analytics-state error" role="alert">{error}</div>
        : boards.length > 0 && items.length === 0 ? <EmptyPanel title="This board is ready" copy="Add a trusted mirrored ad to start collecting reusable patterns. External URL and base64 uploads are intentionally unavailable." />
          : <div className="inspiration-grid">{items.map((item) => {
            const board = boards.find(({ id }) => id === item.boardId)
            const media = item.media[0]
            return <article className="inspiration-card" key={item.id}>
              <div className="inspiration-media">{media ? media.kind === 'video'
                ? <video controls preload="metadata" aria-label={item.title} src={media.url} />
                : <img alt={item.title} src={media.url} loading="lazy" />
                : <div className="media-unavailable">Preview unavailable</div>}</div>
              <div className="inspiration-card-copy"><span className="eyebrow">{board?.name ?? 'Board unavailable'}</span><h3>{item.title}</h3>
                <p className="inspiration-provenance">From {item.sourceKind === 'winning_ad' ? 'Winning Ad' : 'competitor ad'} · {item.source.advertiserName}</p>
                {item.notes ? <p>{item.notes}</p> : <p className="quiet-copy">No working note yet.</p>}
                <div className="inspiration-tags">{item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              </div>
            </article>
          })}</div>}
  </section>
}

function WinningAdsSurface({ items, filters, loading, error, onFilter, onEdit, onRemove }: {
  items: WinningAd[]; filters: WinningAdFilters; loading: boolean; error: string
  onFilter: (filters: WinningAdFilters) => void; onEdit: (item: WinningAd) => void; onRemove: (item: WinningAd) => Promise<void>
}) {
  const [search, setSearch] = useState(filters.search ?? '')
  const [category, setCategory] = useState<WinningAdCategory | ''>(filters.category ?? '')
  const [active, setActive] = useState<'' | 'true' | 'false'>(filters.active === undefined ? '' : String(filters.active) as 'true' | 'false')
  return <section className="surface winning-surface">
    <div className="winning-hero"><span className="eyebrow">Durable creative references</span><h2>Winning Ads</h2><p>A private, media-backed library. Every card preserves source attribution and only uses successful trusted mirrors.</p></div>
    <form className="winning-filter" onSubmit={(event) => { event.preventDefault(); onFilter({ ...(search.trim() ? { search: search.trim() } : {}), ...(category ? { category } : {}), ...(active ? { active: active === 'true' } : {}) }) }}>
      <label>Search<input aria-label="Search winning ads" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /></label>
      <label>Category<select aria-label="Winning ad category filter" value={category} onChange={(event) => setCategory(event.target.value as WinningAdCategory | '')}><option value="">All categories</option>{['classic','modern','minimal','bold','lifestyle','product'].map((value) => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
      <label>Source status<select aria-label="Winning ad source status" value={active} onChange={(event) => setActive(event.target.value as typeof active)}><option value="">Any</option><option value="true">Active</option><option value="false">Inactive</option></select></label>
      <button className="primary-button" type="submit" aria-label="Filter winning ads">Filter</button>
    </form>
    {loading && <div className="analytics-state">Loading Winning Ads…</div>}
    {error && <div className="analytics-state error">Winning Ads are unavailable: {error}</div>}
    {!loading && !error && <div className="winning-grid">
      {items.map((item) => <article className="winning-card" key={item.id}>
        <div className="winning-media">{item.media[0] && isMirroredMediaReference(item.media[0].url) ? (item.media[0].mediaType.startsWith('video/') ? <video controls playsInline preload="metadata" aria-label={item.title}><source src={item.media[0].url} /></video> : <img src={item.media[0].url} alt={item.title} loading="lazy" />) : <span>Trusted media unavailable.</span>}</div>
        <div className="winning-card-body"><div className="winning-kicker"><span>{item.category}</span><span>{item.source.isActive ? 'Active source' : 'Inactive source'}</span></div><h3>{item.title}</h3><p>{item.copy.body || 'Visual reference without body copy.'}</p>
          <div className="tag-row">{item.analysis ? [item.analysis.tags.hookCategory, item.analysis.tags.angle, item.analysis.tags.format].map((tag) => <span key={tag}>{tag.replaceAll('_', ' ')}</span>) : <span>Analysis unavailable — no completed creative analysis was captured.</span>}</div>
          <div className="winning-provenance"><a href={item.source.url} target="_blank" rel="noreferrer">{item.source.advertiserName} · {item.source.provider} ↗</a><span>{item.analysis ? `${item.analysis.provenance} · ${item.analysis.version}` : 'No analysis provenance'}</span></div>
          {item.notes && <p className="winning-notes">{item.notes}</p>}
        </div>
        <div className="winning-actions"><button aria-label={`Edit ${item.title}`} onClick={() => onEdit(item)}>Edit</button><button aria-label={`Remove ${item.title}`} onClick={() => void onRemove(item)}>Remove</button></div>
      </article>)}
      {items.length === 0 && <EmptyPanel title="No Winning Ads yet" copy="Save an Ad Library creative after at least one trusted media mirror succeeds." />}
    </div>}
  </section>
}

function WinningAdDialog({ item, onClose, onSubmit }: { item: WinningAd; onClose: () => void; onSubmit: (draft: { title: string; category: WinningAdCategory; notes: string }) => Promise<void> }) {
  const [title, setTitle] = useState(item.title)
  const [category, setCategory] = useState(item.category)
  const [notes, setNotes] = useState(item.notes)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return <Dialog title="Edit Winning Ad" onClose={onClose}><form className="form-stack" onSubmit={(event) => { event.preventDefault(); setPending(true); setError(''); void onSubmit({ title, category, notes }).catch((reason) => setError(message(reason))).finally(() => setPending(false)) }}>
    <label>Winning ad title<input aria-label="Winning ad title" required maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Category<select aria-label="Winning ad category" value={category} onChange={(event) => setCategory(event.target.value as WinningAdCategory)}>{['classic','modern','minimal','bold','lifestyle','product'].map((value) => <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label>
    <label>Notes<textarea aria-label="Winning ad notes" maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={pending} type="submit">Save Winning Ad changes</button></div>
  </form></Dialog>
}

function AiTagReviewSurface({ api, productId }: { api: CreativeIntelligenceApi; productId: string }) {
  const [status, setStatus] = useState<CreativeTagReviewStatus | ''>('')
  const [items, setItems] = useState<CreativeTagReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const load = async (nextStatus: CreativeTagReviewStatus | '' = status) => {
    const id = ++request.current; setLoading(true); setError('')
    try { const result = await api.listCreativeTagReviews({ productId, ...(nextStatus ? { status: nextStatus } : {}) }); if (id === request.current) setItems(result) }
    catch (reason) { if (id === request.current) setError(message(reason)) }
    finally { if (id === request.current) setLoading(false) }
  }
  useEffect(() => { setStatus(''); void load('') }, [productId])
  const replace = (item: CreativeTagReviewItem) => setItems((current) => current.map((candidate) => candidate.analysis.competitorAdId === item.analysis.competitorAdId ? item : candidate))
  return <section className="surface review-surface">
    <SurfaceHeading eyebrow="Human governance" title="AI tag review" />
    <p className="quiet-copy">Model output stays immutable. Decisions are reviewer-attributed versions attached to one analysis fingerprint.</p>
    <div className="filter-bar"><label>Review status<select aria-label="Review status" value={status} onChange={(event) => { const next = event.target.value as CreativeTagReviewStatus | ''; setStatus(next); void load(next) }}><option value="">All analyses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="corrected">Corrected</option></select></label></div>
    {loading && <div role="status" className="map-placeholder"><h3>Loading review queue…</h3></div>}
    {error && <div role="alert" className="map-placeholder error"><h3>Review queue failed</h3><p>{error}</p><button onClick={() => void load()}>Retry</button></div>}
    {!loading && !error && items.length === 0 && <EmptyPanel title="No analyses match this review view" copy="New completed analyses appear here without rerunning the model." />}
    {!loading && !error && <div className="review-grid">{items.map((item) => <AiTagReviewCard key={`${item.analysis.competitorAdId}:${item.analysis.analysisVersion}:${item.analysis.inputFingerprint}`} api={api} item={item} onUpdated={replace} />)}</div>}
  </section>
}

const correctionOptions = {
  hookCategory: ['pain_point','results','pattern_interrupt','pov_hook','listicle_hook','curiosity','data','social_proof'],
  angle: ['emotional','rational','identity','urgency','authority'],
  format: ['ugc','asmr','podcast','pov','review','teaser','stream','tutorial','documentary','news_story','meme','action','drama','cartoon'],
  offerFrame: ['discount','demo','free_tool','bundle','guarantee','social_proof','none'],
  funnelStage: ['awareness','consideration','conversion','retention'],
} as const

function AiTagReviewCard({ api, item, onUpdated }: { api: CreativeIntelligenceApi; item: CreativeTagReviewItem; onUpdated: (item: CreativeTagReviewItem) => void }) {
  const [decision, setDecision] = useState<CreativeTagReviewDecision>('approved')
  const [corrections, setCorrections] = useState<CreativeTagCorrections>({})
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Awaited<ReturnType<CreativeIntelligenceApi['listCreativeTagReviewHistory']>> | null>(null)
  const submit = async () => {
    setPending(true); setError('')
    try {
      const review = await api.submitCreativeTagReview(item.analysis.competitorAdId, {
        analysisVersion: item.analysis.analysisVersion, inputFingerprint: item.analysis.inputFingerprint,
        expectedReviewVersion: item.review?.reviewVersion ?? 0, decision,
        corrections: decision === 'corrected' ? corrections : null, reason,
      })
      const effectiveTags = decision === 'rejected' ? null : decision === 'corrected' ? { ...item.originalTags, ...corrections } : { ...item.originalTags }
      onUpdated({ ...item, status: decision, review, effectiveTags })
      setHistory((current) => current ? [review, ...current] : current)
    } catch (cause) { setError(message(cause)) } finally { setPending(false) }
  }
  const setCorrection = (key: keyof CreativeTagCorrections, value: string) => setCorrections((current) => {
    const next = { ...current }; if (value) (next as Record<string, string>)[key] = value; else delete next[key]; return next
  })
  return <article className="review-card paper-panel">
    <div className="panel-heading"><span>{item.advertiserName}</span><span className="status-pill">{item.status}</span></div>
    {item.stale && <div role="alert" className="stale-note">Stale analysis: this decision does not apply to the newer fingerprint.</div>}
    <div className="analysis-meta"><span>{item.analysis.modelProvider} · {item.analysis.modelName}</span><span>{item.analysis.analysisVersion}</span><span title={item.analysis.inputFingerprint}>fingerprint {item.analysis.inputFingerprint.slice(0, 12)}…</span></div>
    <div className="review-tag-compare"><TagSnapshot title="Raw model tags" tags={item.originalTags} /><TagSnapshot title="Effective reviewed tags" tags={item.effectiveTags} /></div>
    {item.review && <p className="review-provenance">v{item.review.reviewVersion} by {item.review.reviewerUserId} · {formatDate(item.review.reviewedAt)} — {item.review.reason}</p>}
    <label>Decision<select aria-label={`Decision for ${item.advertiserName}`} value={decision} onChange={(event) => setDecision(event.target.value as CreativeTagReviewDecision)}><option value="approved">Approve</option><option value="rejected">Reject</option><option value="corrected">Correct</option></select></label>
    {decision === 'corrected' && <div className="correction-grid">{(Object.keys(correctionOptions) as Array<keyof typeof correctionOptions>).map((key) => <label key={key}>Correct {key}<select aria-label={`Correct ${key === 'format' ? 'format' : key} for ${item.advertiserName}`} value={corrections[key] ?? ''} onChange={(event) => setCorrection(key, event.target.value)}><option value="">Keep model value</option>{correctionOptions[key].map((value) => <option key={value} value={value}>{value.replaceAll('_',' ')}</option>)}</select></label>)}</div>}
    <label>Reason<textarea aria-label={`Reason for ${item.advertiserName}`} value={reason} maxLength={1000} required onChange={(event) => setReason(event.target.value)} /></label>
    {error && <div role="alert" className="form-error">{error}</div>}
    <div className="card-actions"><button disabled={pending || reason.trim().length === 0 || (decision === 'corrected' && Object.keys(corrections).length === 0)} aria-label={`Submit review for ${item.advertiserName}`} onClick={() => void submit()}>{pending ? 'Submitting…' : 'Submit review'}</button><button onClick={() => void api.listCreativeTagReviewHistory(item.analysis.competitorAdId, item.analysis.analysisVersion, item.analysis.inputFingerprint).then(setHistory).catch((cause) => setError(message(cause)))}>History</button></div>
    {history && <ul aria-label={`Review history for ${item.advertiserName}`}>{history.map((entry) => <li key={entry.reviewVersion}>v{entry.reviewVersion} · {entry.decision} · {entry.reviewerUserId} · {formatDate(entry.reviewedAt)}</li>)}{history.length === 0 && <li>No prior decisions.</li>}</ul>}
  </article>
}

function TagSnapshot({ title, tags }: { title: string; tags: CreativeAnalysis['tags'] | null }) {
  return <section><h3>{title}</h3>{tags ? <dl>{[['Hook',tags.hookCategory],['Angle',tags.angle],['Format',tags.format],['Offer',tags.offerFrame],['Funnel',tags.funnelStage]].map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>Excluded by reviewer decision.</p>}</section>
}

function AdsSurface({ ads, competitors, filters, productId, pendingBriefAdIds, aiBriefErrors, pendingBookmarkAdIds, onFilter, onBookmark, onSaveWinning, onCreateBrief, onCreateAiBrief, onInspect }: {
  ads: CompetitorAd[]
  competitors: Competitor[]
  filters: AdFilters
  productId: string
  pendingBriefAdIds: ReadonlySet<string>
  aiBriefErrors: Readonly<Record<string, string>>
  pendingBookmarkAdIds: ReadonlySet<string>
  onFilter: (filters: AdFilters) => Promise<void>
  onBookmark: (ad: CompetitorAd) => Promise<void>
  onSaveWinning: (ad: CompetitorAd) => Promise<void>
  onCreateBrief: (ad: CompetitorAd) => Promise<void>
  onCreateAiBrief: (ad: CompetitorAd) => Promise<void>
  onInspect: (ad: CompetitorAd) => void
}) {
  const [query, setQuery] = useState(filters.search ?? '')
  const [mediaFormat, setMediaFormat] = useState<'all' | 'video' | 'image' | 'carousel' | 'text'>('all')
  const [startedAfter, setStartedAfter] = useState('')
  useEffect(() => setQuery(filters.search ?? ''), [filters.search, productId])
  const visibleAds = useMemo(() => {
    const minimumDate = startedAfter ? new Date(`${startedAfter}T00:00:00Z`).getTime() : null
    return ads.filter((ad) => {
      if (mediaFormat !== 'all' && creativeMediaFormat(ad) !== mediaFormat) return false
      if (minimumDate !== null && new Date(ad.startedAt).getTime() < minimumDate) return false
      return true
    })
  }, [ads, mediaFormat, startedAfter])
  const resultLabel = `${visibleAds.length} ${visibleAds.length === 1 ? 'creative' : 'creatives'}`
  const apply = (patch: { [K in keyof AdFilters]?: AdFilters[K] | undefined }) => {
    const next = { ...filters, ...patch, productId }
    for (const key of Object.keys(next) as Array<keyof AdFilters>) {
      if (next[key] === undefined || next[key] === '') delete next[key]
    }
    void onFilter(next)
  }

  return (
    <section className="surface">
      <SurfaceHeading eyebrow="Competitive evidence" title="Ad Library" />
      <div className="filter-bar">
        <form onSubmit={(event) => { event.preventDefault(); apply({ search: query.trim() || undefined }) }}>
          <label>Search creatives<input aria-label="Search creatives" type="search" value={query} maxLength={200} placeholder="Copy, CTA, advertiser" onChange={(event) => setQuery(event.target.value)} /></label>
          <button className="secondary-button" type="submit">Apply search</button>
        </form>
        <label>Competitor<select value={filters.competitorId ?? ''} onChange={(event) => apply({ competitorId: event.target.value || undefined })}>
          <option value="">All competitors</option>{competitors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Status<select value={filters.isActive === undefined ? '' : String(filters.isActive)} onChange={(event) => apply({ isActive: event.target.value === '' ? undefined : event.target.value === 'true' })}>
          <option value="">Any status</option><option value="true">Active</option><option value="false">Inactive</option>
        </select></label>
        <label>Hook category<select aria-label="Hook category" value={filters.hookCategory ?? ''} onChange={(event) => apply({ hookCategory: event.target.value || undefined })}>
          <option value="">Any hook</option>{['pain_point', 'results', 'pattern_interrupt', 'pov_hook', 'listicle_hook', 'curiosity', 'data', 'social_proof'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
        </select></label>
        <label>Creative angle<select aria-label="Creative angle" value={filters.angle ?? ''} onChange={(event) => apply({ angle: event.target.value || undefined })}>
          <option value="">Any angle</option>{['emotional', 'rational', 'identity', 'urgency', 'authority'].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>AI format<select aria-label="AI format" value={filters.creativeFormat ?? ''} onChange={(event) => apply({ creativeFormat: event.target.value || undefined })}>
          <option value="">Any AI format</option>{['ugc', 'asmr', 'podcast', 'pov', 'review', 'teaser', 'stream', 'tutorial', 'documentary', 'news_story', 'meme', 'action', 'drama', 'cartoon'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
        </select></label>
        <label>Sort creatives<select aria-label="Sort creatives" value={filters.sort ?? ''} onChange={(event) => apply({ sort: (event.target.value || undefined) as AdFilters['sort'] })}>
          <option value="">First seen — oldest</option><option value="first_seen_desc">First seen — newest</option><option value="last_seen_desc">Last seen — newest</option><option value="lifespan_desc">Longest running</option><option value="impressions_desc">Most impressions</option>
        </select></label>
        <label className="checkbox-label"><input aria-label="Bookmarked only" type="checkbox" checked={filters.bookmarked === true} onChange={(event) => apply({ bookmarked: event.target.checked ? true : undefined })} /> Bookmarked only</label>
        <label>Media format<select aria-label="Media format" value={mediaFormat} onChange={(event) => setMediaFormat(event.target.value as typeof mediaFormat)}>
          <option value="all">Any format</option><option value="video">Video</option><option value="image">Image</option><option value="carousel">Carousel</option><option value="text">Text only</option>
        </select></label>
        <label>Started on or after<input aria-label="Started on or after" type="date" value={startedAfter} onChange={(event) => setStartedAfter(event.target.value)} /></label>
        <span className="result-count" aria-live="polite">{resultLabel}</span>
      </div>
      <div className="ad-grid">
        {visibleAds.map((ad) => (
          <article className="ad-card" key={ad.id}>
            <div className="ad-card-top"><span>{ad.advertiserName}</span><span className={ad.isActive ? 'live-dot' : 'live-dot off'}>{ad.isActive ? 'Live' : 'Inactive'}</span></div>
            <div className="ad-visual"><AdCreative ad={ad} /></div>
            <div className="ad-copy"><p>{ad.body || 'Visual creative without body copy.'}</p></div>
            <div className="ad-meta"><span>{formatDate(ad.startedAt)}</span><span>{ad.callToAction ?? 'No CTA'}</span></div>
            <div className="card-actions"><a href={ad.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a><button aria-label={`View creative details for ${ad.advertiserName}`} onClick={() => onInspect(ad)}>View</button><button aria-label={ad.bookmarked ? `Remove bookmark from ${ad.advertiserName}` : `Bookmark ${ad.advertiserName}`} disabled={pendingBookmarkAdIds.has(ad.id)} onClick={() => void onBookmark(ad)}>{ad.bookmarked ? 'Saved' : 'Save'}</button>{hasTrustedMirror(ad) ? <button aria-label={`Save ${ad.advertiserName} to Winning Ads`} onClick={() => void onSaveWinning(ad)}>Winning Ads</button> : <span className="unavailable-note">Winning Ads unavailable until trusted media mirror completes.</span>}<button disabled={pendingBriefAdIds.has(ad.id)} onClick={() => onCreateBrief(ad)}>{pendingBriefAdIds.has(ad.id) ? 'Creating…' : 'Create brief'}</button><button aria-label={`AI brief for ${ad.advertiserName}`} disabled={pendingBriefAdIds.has(ad.id)} onClick={() => onCreateAiBrief(ad)}>{pendingBriefAdIds.has(ad.id) ? 'Creating AI brief…' : 'AI brief'}</button></div>
            {aiBriefErrors[ad.id] && <div className="form-error" role="alert">{aiBriefErrors[ad.id]}</div>}
          </article>
        ))}
        {visibleAds.length === 0 && <EmptyPanel title="No ads match this view" copy="Adjust the filters or import source records through the API." />}
      </div>
    </section>
  )
}

function hasTrustedMirror(ad: CompetitorAd): boolean {
  return (ad.mirroredMediaUrls?.some((value) => value !== null && isMirroredMediaReference(value)) ?? false)
    || (ad.media?.some((item) => (item.mirroredUrl && isMirroredMediaReference(item.mirroredUrl)) || (item.mirroredPosterUrl && isMirroredMediaReference(item.mirroredPosterUrl))) ?? false)
}

function creativeMediaFormat(ad: CompetitorAd): 'video' | 'image' | 'carousel' | 'text' {
  if (ad.adType) return ad.adType
  if (ad.mediaUrls.some(isVideoUrl)) return 'video'
  return ad.mediaUrls.length > 0 ? 'image' : 'text'
}

const noReferrerMediaProps = { referrerPolicy: 'no-referrer' } as Record<string, string>

export function AdCreative({ ad }: { ad: CompetitorAd }) {
  const structured = [...(ad.media ?? [])]
    .filter((media) => preferredMediaUrl(media) !== undefined)
    .sort((left, right) => left.order - right.order)
  if (ad.adType === 'carousel' && structured.length > 1) {
    return <div className="creative-carousel" role="region" aria-label={`${ad.advertiserName} carousel`}>
      {structured.map((media, index) => <div className="creative-carousel-card" key={`${media.order}:${media.cardIndex ?? 'root'}:${media.sourceUrl}`}>
        {media.kind === 'video'
          ? <video controls playsInline preload="metadata" {...noReferrerMediaProps} poster={preferredPosterUrl(media)} aria-label={`${ad.advertiserName} ad creative card ${index + 1}`}><source src={preferredMediaUrl(media)} /></video>
          : <img src={preferredMediaUrl(media)} alt={`${ad.advertiserName} ad creative card ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" />}
      </div>)}
    </div>
  }
  const trustedLegacy = ad.mediaUrls.map((canonicalUrl, index) => {
    const mirrored = ad.mirroredMediaUrls?.[index]
    const url = mirrored && isMirroredMediaReference(mirrored) ? mirrored : isApprovedMediaUrl(canonicalUrl) ? canonicalUrl : undefined
    return url ? { url, isVideo: isVideoUrl(canonicalUrl) } : undefined
  }).filter((item): item is { url: string; isVideo: boolean } => item !== undefined)
  const structuredVideo = structured.find((media) => media.kind === 'video')
  const structuredImage = structured.find((media) => media.kind === 'image')
  const videoUrl = structuredVideo ? preferredMediaUrl(structuredVideo) : trustedLegacy.find((item) => item.isVideo)?.url
  const mediaUrl = videoUrl ?? (structuredImage ? preferredMediaUrl(structuredImage) : undefined) ?? trustedLegacy[0]?.url
  if (!mediaUrl) {
    const hadExternalMedia = (ad.media?.length ?? 0) > 0 || ad.mediaUrls.length > 0
    return <span>{hadExternalMedia ? 'External media is not on an approved host.' : initials(ad.advertiserName)}</span>
  }
  if (videoUrl) {
    const structuredPoster = structuredVideo ? preferredPosterUrl(structuredVideo) : undefined
    const poster = structuredPoster ?? (structuredImage ? preferredMediaUrl(structuredImage) : undefined) ?? trustedLegacy.find((item) => !item.isVideo)?.url
    return <video controls playsInline preload="metadata" {...noReferrerMediaProps} poster={poster} aria-label={`${ad.advertiserName} ad creative`}><source src={videoUrl} /></video>
  }
  return <img src={mediaUrl} alt={`${ad.advertiserName} ad creative`} loading="lazy" referrerPolicy="no-referrer" />
}

function preferredMediaUrl(media: NonNullable<CompetitorAd['media']>[number]): string | undefined {
  if (media.mirroredUrl && isMirroredMediaReference(media.mirroredUrl)) return media.mirroredUrl
  return isApprovedMediaUrl(media.sourceUrl) ? media.sourceUrl : undefined
}

function preferredPosterUrl(media: NonNullable<CompetitorAd['media']>[number]): string | undefined {
  if (media.mirroredPosterUrl && isMirroredMediaReference(media.mirroredPosterUrl)) return media.mirroredPosterUrl
  return media.posterUrl && isApprovedMediaUrl(media.posterUrl) ? media.posterUrl : undefined
}

function isMirroredMediaReference(value: string): boolean {
  return /^\/media\/sha256\/[a-f0-9]{64}$/u.test(value)
}

function isApprovedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const hostname = url.hostname.toLowerCase()
    return hostname === 'fbcdn.net' || hostname.endsWith('.fbcdn.net')
      || hostname === 'facebook.com' || hostname.endsWith('.facebook.com')
      || hostname === 'fbsbx.com' || hostname.endsWith('.fbsbx.com')
  } catch {
    return false
  }
}

function isVideoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().startsWith('video-') || /\.(?:mp4|m4v|webm|mov)$/iu.test(url.pathname)
  } catch {
    return false
  }
}

function CreativeDetailDialog({ ad, pending, onClose, onCreateBrief, onAnalyze }: {
  ad: CompetitorAd
  pending: boolean
  onClose: () => void
  onCreateBrief: (ad: CompetitorAd) => Promise<void>
  onAnalyze: (ad: CompetitorAd) => Promise<CreativeAnalysis>
}) {
  const [analysis, setAnalysis] = useState<CreativeAnalysis | null>(null)
  const [analysisError, setAnalysisError] = useState('')
  const [analysisPending, setAnalysisPending] = useState(false)
  const analysisInFlight = useRef(false)
  const runAnalysis = async () => {
    if (analysisInFlight.current) return
    analysisInFlight.current = true
    setAnalysisPending(true)
    setAnalysisError('')
    try { setAnalysis(await onAnalyze(ad)) }
    catch (reason) { setAnalysisError(message(reason)) }
    finally { analysisInFlight.current = false; setAnalysisPending(false) }
  }
  return <Dialog title={`${ad.advertiserName} creative`} onClose={onClose} wide>
    <div className="creative-detail">
      <div className="creative-detail-media"><AdCreative ad={ad} /></div>
      <div className="creative-detail-copy">
        <span className={ad.isActive ? 'status-pill' : 'status-pill muted'}>{ad.isActive ? 'Active' : 'Inactive'}</span>
        {ad.headline && <h3>{ad.headline}</h3>}
        <p>{ad.body || 'Visual creative without body copy.'}</p>
        {ad.description && <p className="muted-copy">{ad.description}</p>}
        <dl>
          <div><dt>CTA</dt><dd>{ad.callToAction ?? 'Not provided'}</dd></div>
          <div><dt>Started</dt><dd>{formatDate(ad.startedAt)}</dd></div>
          <div><dt>Ended</dt><dd>{ad.endedAt ? formatDate(ad.endedAt) : ad.isActive ? 'Still active' : 'Not provided'}</dd></div>
          <div><dt>First seen</dt><dd>{formatDate(ad.firstSeenAt)}</dd></div>
          <div><dt>Last seen</dt><dd>{formatDate(ad.lastSeenAt)}</dd></div>
          <div><dt>Format</dt><dd>{creativeMediaFormat(ad)}</dd></div>
          <div><dt>Display format</dt><dd>{ad.displayFormat ?? 'Not provided'}</dd></div>
          <div><dt>Platforms</dt><dd>{ad.publisherPlatforms?.join(', ') || 'Not provided'}</dd></div>
          <div><dt>Impressions</dt><dd>{formatRange(ad.impressionsLowerBound, ad.impressionsUpperBound)}</dd></div>
          <div><dt>Spend</dt><dd>{formatRange(ad.spendLowerBound, ad.spendUpperBound, ad.currency)}</dd></div>
          <div><dt>Meta page ID</dt><dd>{ad.pageId ?? 'Not provided'}</dd></div>
          <div><dt>Provider</dt><dd>{ad.providerName}</dd></div>
        </dl>
        <section className="creative-analysis" aria-label="Creative analysis">
          <div className="analysis-heading"><div><span className="eyebrow">AI-assisted read</span><h3>Creative tags</h3></div><button className="secondary-button" disabled={analysisPending} onClick={() => void runAnalysis()}>{analysisPending ? 'Analyzing…' : analysis ? 'Analyze again' : 'Analyze creative'}</button></div>
          {analysisError && <div className="form-error" role="alert">{analysisError}</div>}
          {analysis && <>
            <div className="analysis-meta"><span>{analysis.modelProvider} · {analysis.modelName}</span><span>{analysis.provenance === 'automatic' ? 'Auto-tagged' : 'Manual'} · {analysis.analysisMode === 'media' ? `${analysis.mediaCount} mirrored media ${analysis.mediaCount === 1 ? 'asset' : 'assets'}` : 'Copy-only (no trusted media)'}</span><span>{analysis.analysisVersion} · prompt {analysis.promptVersion}</span><span>{analysis.tags.confidence === undefined ? 'Confidence not supplied' : `${Math.round(analysis.tags.confidence * 100)}% confidence`}</span></div>
            <dl className="analysis-tags">
              {analysisTagEntries(analysis).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
            </dl>
          </>}
        </section>
        <div className="creative-detail-actions">
          <a href={ad.sourceUrl} target="_blank" rel="noreferrer">Open original ad</a>
          <button className="primary-button" disabled={pending} onClick={() => { onClose(); void onCreateBrief(ad) }}>{pending ? 'Creating…' : 'Create brief'}</button>
        </div>
      </div>
    </div>
  </Dialog>
}

function formatRange(lower: number | null | undefined, upper: number | null | undefined, suffix?: string | null): string {
  if (lower == null && upper == null) return 'Not available'
  const value = lower != null && upper != null && lower !== upper
    ? `${lower.toLocaleString()}–${upper.toLocaleString()}`
    : (lower ?? upper)!.toLocaleString()
  return suffix ? `${value} ${suffix}` : value
}

function analysisTagEntries(analysis: CreativeAnalysis): Array<[string, string]> {
  const tags = analysis.tags
  return [
    ['Hook', tags.hookCategory], ['Angle', tags.angle], ['Emotion', tags.emotion], ['Persona', tags.persona],
    ['Format', tags.format], ['Offer', tags.offerFrame], ['CTA', tags.cta],
    ...(tags.funnelStage ? [['Funnel stage', tags.funnelStage] as [string, string]] : []),
    ...(tags.onScreenText ? [['On-screen text', tags.onScreenText] as [string, string]] : []),
    ...(tags.visualSummary ? [['Visual summary', tags.visualSummary] as [string, string]] : []),
  ]
}

function BriefsSurface({ briefs, onAdd, onEdit, onHandoff }: { briefs: CreativeBrief[]; onAdd: () => void; onEdit: (brief: CreativeBrief) => void; onHandoff: (brief: CreativeBrief) => Promise<void> }) {
  return (
    <section className="surface">
      <SurfaceHeading eyebrow="From evidence to action" title="Brief Builder" action="New brief" onAction={onAdd} />
      <div className="brief-board">
        {briefs.map((brief) => (
          <article className="brief-card" key={brief.id}>
            <div className="brief-number">{brief.sourceAdId ? '↗' : '✦'}</div>
            <div className="brief-content"><span className="status-pill">{brief.status}</span>{brief.details && <span className="status-pill">AI production brief</span>}<h3>{brief.title}</h3><p>{brief.hook || 'No hook written yet.'}</p></div>
            <div className="dimension-grid">
              {Object.entries(brief.dimensions).map(([key, value]) => <div key={key}><span>{key}</span><strong>{value}</strong></div>)}
            </div>
            <div className="card-actions"><button type="button" className="text-button" aria-label={`Edit ${brief.title}`} onClick={() => onEdit(brief)}>Edit · v{brief.version}</button>{brief.details && <button type="button" className="text-button" aria-label={`Production handoff for ${brief.title}`} onClick={() => void onHandoff(brief)}>Production handoff</button>}</div>
          </article>
        ))}
        {briefs.length === 0 && <EmptyPanel title="The brief board is empty" copy="Start manually or turn an ad into a grounded creative response." action="New brief" onAction={onAdd} />}
      </div>
    </section>
  )
}

function IterationMapSurface({ product, briefs, result, loading, error, onAnalyze, onCreateGap }: {
  product: Product
  briefs: CreativeBrief[]
  result: IterationMap | null
  loading: boolean
  error: string
  onAnalyze: (axes: IterationAxes) => Promise<void>
  onCreateGap: (dimensions: BriefDimensions) => void
}) {
  const defaults = useMemo<IterationAxes>(() => ({
    audience: unique([...product.targetAudiences, ...briefs.map((brief) => brief.dimensions.audience)]),
    market: unique([...product.markets, ...briefs.map((brief) => brief.dimensions.market)]),
    angle: unique(briefs.map((brief) => brief.dimensions.angle)),
    format: unique(briefs.map((brief) => brief.dimensions.format)),
  }), [product, briefs])
  const [axes, setAxes] = useState<IterationAxes>(() => fallbackAxes(defaults))
  const [visibility, setVisibility] = useState<'all' | 'covered' | 'gaps'>('all')
  const [visibleLimit, setVisibleLimit] = useState(24)

  useEffect(() => setAxes(fallbackAxes(defaults)), [defaults])
  useEffect(() => setVisibleLimit(24), [result, visibility])

  const cells = result ? [
    ...(visibility === 'gaps' ? [] : result.covered.map((cell) => ({ ...cell, covered: true as const }))),
    ...(visibility === 'covered' ? [] : result.missing.map((cell) => ({ ...cell, covered: false as const }))),
  ] : []
  const percent = result ? Math.round((result.covered.length / result.totalCombinations) * 100) : 0

  return (
    <section className="surface">
      <SurfaceHeading eyebrow="Coverage, not guesswork" title="Iteration Map" />
      <div className="map-layout">
        <form className="axis-panel paper-panel" onSubmit={(event) => { event.preventDefault(); void onAnalyze(axes) }}>
          <div className="panel-heading"><span>Analysis axes</span><small>comma separated</small></div>
          {(Object.keys(axes) as Array<keyof IterationAxes>).map((key) => (
            <label key={key}>{capitalize(key)}<input value={axes[key].join(', ')} onChange={(event) => setAxes((current) => ({ ...current, [key]: csv(event.target.value) }))} required /></label>
          ))}
          <button className="primary-button" type="submit">{loading ? 'Analyzing…' : 'Analyze coverage'}</button>
        </form>
        <div className="map-results">
          {loading && !result ? <div className="map-placeholder" role="status"><span>4D</span><h3>Analyzing coverage…</h3><p>Comparing active briefs with the selected combinations.</p></div>
            : error ? <div className="map-placeholder error" role="alert"><h3>Coverage analysis failed</h3><p>{error}</p></div>
              : result ? (
                <>
                  <div className="coverage-summary"><strong>{result.covered.length}<span>/{result.totalCombinations}</span></strong><p>{percent}% covered</p></div>
                  <div className="map-view-controls"><label>Show cells<select aria-label="Show cells" value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}><option value="all">Coverage and gaps</option><option value="covered">Covered only</option><option value="gaps">Gaps only</option></select></label><span>{Math.min(cells.length, visibleLimit)} of {cells.length}</span></div>
                  {cells.length === 0 ? <div className="map-empty">No cells match this view.</div> : <div className="coverage-grid" aria-label="Iteration coverage cells">
                    {cells.slice(0, visibleLimit).map((cell) => <CoverageCell key={dimensionKey(cell.dimensions)} cell={cell} onCreateGap={onCreateGap} />)}
                  </div>}
                  {cells.length > visibleLimit && <button type="button" className="secondary-button map-more" onClick={() => setVisibleLimit((value) => Math.min(value + 24, cells.length))}>Show 24 more</button>}
                </>
              ) : (
                <div className="map-placeholder"><span>4D</span><h3>Map the white space.</h3><p>Set the axes, then compare existing briefs with every intended creative combination.</p></div>
              )}
        </div>
      </div>
    </section>
  )
}

function AnalyticsSurface({ api, productId, competitors, result, loading, error }: {
  api: CreativeIntelligenceApi
  productId: string
  competitors: Competitor[]
  result: ScalingAnalytics | null
  loading: boolean
  error: string
}) {
  const [selectedCompetitorId, setSelectedCompetitorId] = useState(competitors[0]?.id ?? '')
  const [windowDays, setWindowDays] = useState<AnalyticsHistoryWindow>(30)
  const [history, setHistory] = useState<CompetitorAnalyticsHistory | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [comparisonIds, setComparisonIds] = useState<Set<string>>(() => new Set())
  const [comparison, setComparison] = useState<CompetitorAnalyticsComparison | null>(null)
  const [comparisonLoading, setComparisonLoading] = useState(false)
  const [comparisonError, setComparisonError] = useState('')
  const comparisonRequest = useRef(0)

  useEffect(() => {
    if (!competitors.some(({ id }) => id === selectedCompetitorId)) setSelectedCompetitorId(competitors[0]?.id ?? '')
    setComparisonIds((current) => new Set([...current].filter((id) => competitors.some((competitor) => competitor.id === id))))
  }, [competitors, selectedCompetitorId])

  useEffect(() => {
    comparisonRequest.current += 1
    setComparison(null)
    setComparisonError('')
    setComparisonLoading(false)
  }, [productId, competitors])

  useEffect(() => {
    setHistory(null)
    setHistoryError('')
    if (!selectedCompetitorId) return
    let active = true
    setHistoryLoading(true)
    api.getCompetitorAnalyticsHistory(productId, selectedCompetitorId, windowDays)
      .then((value) => { if (active) setHistory(value) })
      .catch((reason: unknown) => { if (active) setHistoryError(message(reason)) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [api, productId, selectedCompetitorId, windowDays])

  const toggleComparison = (competitorId: string) => setComparisonIds((current) => {
    const next = new Set(current)
    if (next.has(competitorId)) next.delete(competitorId)
    else if (next.size < 10) next.add(competitorId)
    return next
  })
  const compare = async () => {
    const selected = competitors.filter(({ id }) => comparisonIds.has(id)).map(({ id }) => id)
    if (selected.length < 2) return
    const request = ++comparisonRequest.current
    setComparisonLoading(true); setComparisonError(''); setComparison(null)
    try {
      const result = await api.compareCompetitorAnalytics(productId, selected)
      if (request === comparisonRequest.current) setComparison(result)
    } catch (reason) {
      if (request === comparisonRequest.current) setComparisonError(message(reason))
    } finally {
      if (request === comparisonRequest.current) setComparisonLoading(false)
    }
  }

  return (
    <section className="surface analytics-surface">
      <SurfaceHeading eyebrow="Competitive momentum" title={result?.label ?? 'Scaling signals'} />
      <aside className="proxy-note" aria-label="Metric methodology">
        <strong>Directional proxies</strong>
        <span>Scores and trends use observed public-library ad activity. They are not verified spend or revenue.</span>
      </aside>
      {loading ? <div className="analytics-state" role="status">Loading scaling signals…</div>
        : error ? <div className="analytics-state error" role="alert">{error}</div>
          : !result || result.items.length === 0 ? <EmptyPanel title="No scaling signals yet" copy="Track competitor ads over time to establish a comparison window." />
            : <>
              <p className="analytics-generated">Generated {formatDateTime(result.generatedAt)}</p>
              <div className="analytics-table-wrap">
                <table className="analytics-table">
                  <thead><tr><th>Competitor</th><th>Scale score</th><th>Active ads</th><th>New 7d</th><th>Velocity</th><th>Avg. active</th><th>Long runners</th><th>Format mix</th></tr></thead>
                  <tbody>{result.items.map((item) => <tr key={item.competitorId}>
                    <th scope="row"><span>{item.competitorName}</span>{item.newlyTracked && <small>Newly tracked</small>}</th>
                    <td className="score-cell">{formatNumber(item.scaleScore)}</td>
                    <td>{item.activeAdCount}</td><td>{item.newAdsLast7d}<small>prev. {item.newAdsPrev7d}</small></td>
                    <td className={item.launchVelocityDelta >= 0 ? 'positive' : 'negative'}>{signedNumber(item.launchVelocityDelta)}</td>
                    <td>{formatNumber(item.avgDaysActive)} days</td><td>{item.longRunnerCount}</td>
                    <td><span className="format-mix">{item.formatMix.image} image · {item.formatMix.video} video · {item.formatMix.carousel} carousel · {item.formatMix.text} text</span>{item.impressionWeight !== undefined && <small>weight {formatNumber(item.impressionWeight)}</small>}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </>}

      <div className="analytics-detail-grid">
        <section className="analytics-panel" aria-labelledby="analytics-history-title">
          <div className="analytics-panel-heading"><div><span className="eyebrow">Durable snapshots</span><h3 id="analytics-history-title">Analytics history</h3></div>
            <div className="analytics-controls">
              <label>Competitor<select aria-label="History competitor" value={selectedCompetitorId} onChange={(event) => setSelectedCompetitorId(event.target.value)}>{competitors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>Window<select aria-label="History window" value={windowDays} onChange={(event) => setWindowDays(Number(event.target.value) as AnalyticsHistoryWindow)}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
            </div>
          </div>
          {historyLoading ? <p>Loading history…</p>
            : historyError ? <div className="analytics-state error" role="alert">{historyError}</div>
              : competitors.length === 0 ? <p>No active competitors to inspect.</p>
                : history && <>
                  {history.trend7d && <p className={`analytics-trend ${history.trend7d.direction}`}><strong>{history.trend7d.activeAdCountChangePercent === null ? `${signedNumber(history.trend7d.activeAdCountChange)} active ads` : `${signedNumber(history.trend7d.activeAdCountChangePercent)}% active ads`}</strong><span> over 7 days · {signedNumber(history.trend7d.scaleScoreChange)} score</span></p>}
                  {history.items.length === 0 ? <p>No snapshots in this window.</p> : <div className="analytics-table-wrap"><table className="analytics-table compact"><thead><tr><th>Date</th><th>Score</th><th>Active</th><th>New 7d</th><th>Velocity</th></tr></thead><tbody>{history.items.map((item) => <tr key={item.snapshotDate}><th scope="row">{item.snapshotDate}</th><td>{item.scaleScore}</td><td>{item.activeAdCount}</td><td>{item.newAdsLast7d}</td><td>{signedNumber(item.launchVelocityDelta)}</td></tr>)}</tbody></table></div>}
                </>}
        </section>

        <section className="analytics-panel" aria-labelledby="analytics-comparison-title">
          <div className="analytics-panel-heading"><div><span className="eyebrow">Selected peers</span><h3 id="analytics-comparison-title">Side-by-side comparison</h3></div></div>
          <div className="comparison-picker">{competitors.map((item) => <label key={item.id}><input type="checkbox" aria-label={`Compare ${item.name}`} checked={comparisonIds.has(item.id)} onChange={() => toggleComparison(item.id)} /> {item.name}</label>)}</div>
          <button className="secondary-button" disabled={comparisonIds.size < 2 || comparisonLoading} onClick={() => { void compare() }}>{comparisonLoading ? 'Comparing…' : 'Compare selected'}</button>
          {comparisonError && <div className="analytics-state error" role="alert">{comparisonError}</div>}
          {comparison && <div className="analytics-table-wrap"><table className="analytics-table comparison-table"><thead><tr><th>Metric</th>{comparison.items.map((item) => <th key={item.competitor.id}>{item.competitor.name}</th>)}</tr></thead><tbody><tr><th scope="row">Latest snapshot</th>{comparison.items.map((item) => <td key={item.competitor.id}>{item.latest ? <><strong>{item.latest.scaleScore} score</strong><small>{item.latest.activeAdCount} active · {item.latest.newAdsLast7d} new/7d</small>{item.trend7d && <small>{signedNumber(item.trend7d.activeAdCountChange)} active over 7d</small>}</> : 'No snapshot'}</td>)}</tr></tbody></table></div>}
        </section>
      </div>
    </section>
  )
}

function CoverageCell({ cell, onCreateGap }: { cell: IterationCell & { covered: boolean }; onCreateGap: (dimensions: BriefDimensions) => void }) {
  const [expanded, setExpanded] = useState(false)
  const label = `${cell.dimensions.audience}, ${cell.dimensions.market}, ${cell.dimensions.angle}, ${cell.dimensions.format}`
  if (!cell.covered) return <article className="coverage-cell gap"><span>Gap</span><strong>{cell.dimensions.angle}</strong><p>{cell.dimensions.audience} · {cell.dimensions.market} · {cell.dimensions.format}</p><button type="button" className="text-button" aria-label={`Create brief for ${label}`} onClick={() => onCreateGap(cell.dimensions)}>Create brief</button></article>
  return <article className="coverage-cell covered">
    <span>{cell.briefCount} brief{cell.briefCount === 1 ? '' : 's'}</span><strong>{cell.dimensions.angle}</strong><p>{cell.dimensions.audience} · {cell.dimensions.market} · {cell.dimensions.format}</p>
    <button type="button" className="text-button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide evidence' : `View evidence: ${cell.briefs.map(({ title }) => title).join(', ')}`}</button>
    {expanded && <ul className="cell-evidence">{cell.briefs.map((brief) => <li key={brief.id}><strong>{brief.title}</strong><span className={`status-pill ${brief.status}`}>{brief.status}</span></li>)}{cell.hasMoreBriefs && <li className="bounded-note">Showing the first {cell.briefs.length} briefs in deterministic creation order.</li>}</ul>}
  </article>
}

function SurfaceHeading({ eyebrow, title, action, onAction }: { eyebrow: string; title: string; action?: string; onAction?: () => void }) {
  return <div className="surface-heading"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action && onAction && <button className="primary-button" onClick={onAction}>{action}</button>}</div>
}

function EmptyWorkspace({ onAdd }: { onAdd: () => void }) {
  return <section className="empty-workspace"><span>01</span><h2>Start with the product.</h2><p>The workspace becomes useful once its market, audience, and promise are explicit.</p><button className="primary-button" onClick={onAdd}>Create first product</button></section>
}

function EmptyPanel({ title, copy, action, onAction }: { title: string; copy: string; action?: string; onAction?: () => void }) {
  return <div className="empty-panel"><h3>{title}</h3><p>{copy}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</div>
}

function ProductDialog({ product, onClose, onSubmit }: {
  product?: Product
  onClose: () => void
  onSubmit: (draft: { name: string; markets: string[]; platforms: Platform[]; targetAudiences: string[]; uniqueSellingPoints: string[] }) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setSubmitError('')
    const data = new FormData(event.currentTarget)
    try {
      await onSubmit({
        name: textValue(data, 'name'), markets: lines(textValue(data, 'markets')),
        platforms: data.getAll('platforms').filter((value): value is Platform => typeof value === 'string' && ['ios', 'android', 'web'].includes(value)),
        targetAudiences: lines(textValue(data, 'audiences')), uniqueSellingPoints: lines(textValue(data, 'sellingPoints')),
      })
    } catch (reason) { setSubmitError(message(reason)) } finally { setBusy(false) }
  }
  return <Dialog title={product ? 'Edit product' : 'Create product'} onClose={onClose} closeDisabled={busy}><form className="form-stack" onSubmit={submit}>
    <FormError message={submitError} />
    <label>Product name<input name="name" maxLength={300} defaultValue={product?.name ?? ''} required data-autofocus /></label>
    <label>Markets<textarea name="markets" defaultValue={product?.markets.join('\n') ?? ''} placeholder={'US\nWashington, D.C.'} /></label>
    <fieldset><legend>Platforms</legend><label><input type="checkbox" name="platforms" value="ios" defaultChecked={product?.platforms.includes('ios')} /> iOS</label><label><input type="checkbox" name="platforms" value="android" defaultChecked={product?.platforms.includes('android')} /> Android</label><label><input type="checkbox" name="platforms" value="web" defaultChecked={product?.platforms.includes('web')} /> Web</label></fieldset>
    <label>Target audiences<textarea name="audiences" defaultValue={product?.targetAudiences.join('\n') ?? ''} placeholder={'Founders\nMarketing teams'} /></label>
    <label>Unique selling points<textarea name="sellingPoints" defaultValue={product?.uniqueSellingPoints.join('\n') ?? ''} placeholder={'One idea per line\nCommas stay intact'} /></label>
    <FormActions onClose={onClose} busy={busy} submit={product ? 'Save product' : 'Create product'} />
  </form></Dialog>
}

function CompetitorDialog({ onClose, onSubmit }: {
  onClose: () => void; onSubmit: (draft: { name: string; metaPageUrl?: string | null }) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setSubmitError(''); const data = new FormData(event.currentTarget); const url = textValue(data, 'url')
    try { await onSubmit({ name: textValue(data, 'name'), ...(url ? { metaPageUrl: url } : {}) }) }
    catch (reason) { setSubmitError(message(reason)) } finally { setBusy(false) }
  }
  return <Dialog title="Add competitor" onClose={onClose} closeDisabled={busy}><form className="form-stack" onSubmit={submit}>
    <FormError message={submitError} />
    <label>Competitor name<input name="name" maxLength={300} required data-autofocus /></label>
    <label>Meta page URL<input name="url" type="url" placeholder="https://www.facebook.com/..." /></label>
    <FormActions onClose={onClose} busy={busy} submit="Add competitor" />
  </form></Dialog>
}

function EditBriefDialog({ brief, loadVersions, onClose, onSubmit }: {
  brief: CreativeBrief
  loadVersions: (briefId: string) => Promise<CreativeBriefVersion[]>
  onClose: () => void
  onSubmit: (briefId: string, input: { expectedVersion: number; title: string; status: BriefStatus; hook: string; callToAction: string | null; dimensions: BriefDimensions }) => Promise<void>
}) {
  const [versions, setVersions] = useState<CreativeBriefVersion[]>([])
  const [historyError, setHistoryError] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')
  useEffect(() => {
    let active = true
    loadVersions(brief.id).then((items) => { if (active) setVersions(items) }).catch((reason) => { if (active) setHistoryError(message(reason)) })
    return () => { active = false }
  }, [brief.id, loadVersions])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setSubmitError(''); const data = new FormData(event.currentTarget)
    try {
      await onSubmit(brief.id, {
        expectedVersion: brief.version,
        title: textValue(data, 'title'), status: textValue(data, 'status') as BriefStatus,
        hook: textValue(data, 'hook'), callToAction: textValue(data, 'cta') || null,
        dimensions: { audience: textValue(data, 'audience'), market: textValue(data, 'market'), angle: textValue(data, 'angle'), format: textValue(data, 'format') },
      })
    } catch (reason) { setSubmitError(message(reason)) } finally { setBusy(false) }
  }
  return <Dialog title="Edit creative brief" onClose={onClose} closeDisabled={busy} wide><div className="brief-editor-layout">
    <form className="form-stack" onSubmit={submit}>
      <FormError message={submitError} />
      <label>Brief title<input aria-label="Brief title" name="title" maxLength={500} defaultValue={brief.title} required data-autofocus /></label>
      <label>Brief status<select aria-label="Brief status" name="status" defaultValue={brief.status}>{briefStatusOptions(brief.status).map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
      <label>Hook<textarea aria-label="Hook" name="hook" maxLength={20_000} defaultValue={brief.hook} /></label>
      <label>Call to action<input name="cta" maxLength={100} defaultValue={brief.callToAction ?? ''} /></label>
      <div className="field-grid">
        <label>Audience<input name="audience" maxLength={100} defaultValue={brief.dimensions.audience} required /></label>
        <label>Market<input name="market" maxLength={100} defaultValue={brief.dimensions.market} required /></label>
        <label>Angle<input name="angle" maxLength={100} defaultValue={brief.dimensions.angle} required /></label>
        <label>Format<input name="format" maxLength={100} defaultValue={brief.dimensions.format} required /></label>
      </div>
      <FormActions onClose={onClose} busy={busy} submit="Save changes" />
    </form>
    <aside className="brief-history" aria-label="Version history"><span className="eyebrow">Version history</span>
      {historyError && <div className="form-error" role="alert">{historyError}</div>}
      {!historyError && versions.length === 0 && <p>Loading history…</p>}
      {versions.map((version) => <article key={version.version}><strong>Version {version.version} by {version.changedBy}</strong><span>{formatDateTime(version.changedAt)} · {version.status}</span><p>{version.title}</p></article>)}
    </aside>
  </div></Dialog>
}

function briefStatusOptions(status: BriefStatus): readonly BriefStatus[] {
  return BRIEF_STATUS_TRANSITIONS[status]
}

function BriefDialog({ product, seed, onClose, onSubmit }: {
  product: Product | undefined; onClose: () => void
  seed?: BriefDimensions | null
  onSubmit: (draft: { title: string; hook: string; callToAction?: string; dimensions: BriefDimensions }) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setSubmitError(''); const data = new FormData(event.currentTarget); const cta = textValue(data, 'cta')
    try {
      await onSubmit({
        title: textValue(data, 'title'), hook: textValue(data, 'hook'), ...(cta ? { callToAction: cta } : {}),
        dimensions: { audience: textValue(data, 'audience'), market: textValue(data, 'market'), angle: textValue(data, 'angle'), format: textValue(data, 'format') },
      })
    } catch (reason) { setSubmitError(message(reason)) } finally { setBusy(false) }
  }
  return <Dialog title="New creative brief" onClose={onClose} closeDisabled={busy}><form className="form-stack" onSubmit={submit}>
    <FormError message={submitError} />
    <label>Brief title<input aria-label="Brief title" name="title" maxLength={500} required data-autofocus /></label>
    <label>Hook<textarea aria-label="Hook" name="hook" maxLength={20_000} required /></label>
    <label>Call to action<input name="cta" maxLength={100} /></label>
    <div className="field-grid">
      <label>Audience<input aria-label="Audience" name="audience" maxLength={100} defaultValue={seed?.audience ?? product?.targetAudiences[0] ?? ''} required /></label>
      <label>Market<input aria-label="Market" name="market" maxLength={100} defaultValue={seed?.market ?? product?.markets[0] ?? ''} required /></label>
      <label>Angle<input aria-label="Angle" name="angle" maxLength={100} defaultValue={seed?.angle ?? ''} required /></label>
      <label>Format<input aria-label="Format" name="format" maxLength={100} defaultValue={seed?.format ?? ''} required /></label>
    </div>
    <FormActions onClose={onClose} busy={busy} submit="Save brief" />
  </form></Dialog>
}

function Dialog({ title, onClose, closeDisabled = false, wide = false, children }: { title: string; onClose: () => void; closeDisabled?: boolean; wide?: boolean; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)
  const restoreFocusTimer = useRef<number | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  onCloseRef.current = onClose
  closeDisabledRef.current = closeDisabled
  useLayoutEffect(() => {
    if (restoreFocusTimer.current !== null) {
      window.clearTimeout(restoreFocusTimer.current)
      restoreFocusTimer.current = null
    }
    if (openerRef.current === null && document.activeElement instanceof HTMLElement) openerRef.current = document.activeElement
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')]
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!closeDisabledRef.current) onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (controls.length === 0) { event.preventDefault(); dialog.focus(); return }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      restoreFocusTimer.current = window.setTimeout(() => openerRef.current?.focus(), 0)
    }
  }, [])
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className={wide ? 'dialog wide-dialog' : 'dialog'} role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1}><div className="dialog-heading"><span className="eyebrow">Workspace action</span><h2 id="dialog-title">{title}</h2><button type="button" aria-label="Close dialog" onClick={onClose} disabled={closeDisabled}>×</button></div>{children}</section></div>
}

function FormError({ message: errorMessage }: { message: string }) {
  const errorRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (errorMessage) errorRef.current?.focus() }, [errorMessage])
  return errorMessage ? <div ref={errorRef} className="form-error" role="alert" tabIndex={-1}>{errorMessage}</div> : null
}

function FormActions({ onClose, busy, submit }: { onClose: () => void; busy: boolean; submit: string }) {
  return <div className="form-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : submit}</button></div>
}

function message(reason: unknown): string {
  if (reason instanceof ApiError || reason instanceof Error) return reason.message
  return 'Something went wrong'
}
function csv(value: string): string[] { return unique(value.split(',').map((item) => item.trim()).filter(Boolean)) }
function lines(value: string): string[] { return unique(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) }
function unique(values: string[]): string[] { return [...new Set(values.map((item) => item.trim()).filter(Boolean))] }
function fallbackAxes(axes: IterationAxes): IterationAxes {
  return {
    audience: axes.audience.length ? axes.audience : ['Unspecified audience'],
    market: axes.market.length ? axes.market : ['Unspecified market'],
    angle: axes.angle.length ? axes.angle : ['New angle'],
    format: axes.format.length ? axes.format : ['Static'],
  }
}
function initials(value: string): string { return value.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') }
function formatDate(value: string): string { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) }
function formatDateTime(value: string): string { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value)) }
function formatNumber(value: number): string { return new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value) }
function signedNumber(value: number): string { return `${value > 0 ? '+' : ''}${formatNumber(value)}` }
function dimensionKey(value: BriefDimensions): string { return `${value.audience}\u0000${value.market}\u0000${value.angle}\u0000${value.format}` }
function capitalize(value: string): string { return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` }
function textValue(data: FormData, key: string): string { const value = data.get(key); return typeof value === 'string' ? value.trim() : '' }

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { ApiError, type AdFilters, type CreativeIntelligenceApi } from './api.ts'
import type {
  BriefDimensions,
  BriefStatus,
  Competitor,
  CompetitorAd,
  CreativeAnalysis,
  CreativeBrief,
  CreativeBriefVersion,
  IterationAxes,
  IterationMap,
  Platform,
  Product,
  ScalingAnalytics,
} from './types.ts'

type Surface = 'overview' | 'competitors' | 'ads' | 'briefs' | 'map' | 'analytics'

interface WorkspaceProps {
  api: CreativeIntelligenceApi
  organizationLabel: string
  onDisconnect: () => void
}

const surfaces: Array<{ id: Surface; label: string; index: string }> = [
  { id: 'overview', label: 'Products', index: '01' },
  { id: 'competitors', label: 'Competitors', index: '02' },
  { id: 'ads', label: 'Ad Library', index: '03' },
  { id: 'briefs', label: 'Brief Builder', index: '04' },
  { id: 'map', label: 'Iteration Map', index: '05' },
  { id: 'analytics', label: 'Analytics', index: '06' },
]

export function Workspace({ api, organizationLabel, onDisconnect }: WorkspaceProps) {
  const [surface, setSurface] = useState<Surface>('overview')
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProductId, setSelectedProductId] = useState('')
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [ads, setAds] = useState<CompetitorAd[]>([])
  const [briefs, setBriefs] = useState<CreativeBrief[]>([])
  const [iterationMap, setIterationMap] = useState<IterationMap | null>(null)
  const [scalingAnalytics, setScalingAnalytics] = useState<ScalingAnalytics | null>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState('')
  const [pendingOperations, setPendingOperations] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showProductForm, setShowProductForm] = useState(false)
  const [showCompetitorForm, setShowCompetitorForm] = useState(false)
  const [showBriefForm, setShowBriefForm] = useState(false)
  const [selectedAd, setSelectedAd] = useState<CompetitorAd | null>(null)
  const [selectedBrief, setSelectedBrief] = useState<CreativeBrief | null>(null)
  const [adFilters, setAdFilters] = useState<AdFilters>({})
  const adFiltersRef = useRef<AdFilters>({})
  adFiltersRef.current = adFilters
  const [productLoadAttempt, setProductLoadAttempt] = useState(0)
  const [productsFailed, setProductsFailed] = useState(false)
  const [pendingBriefAdIds, setPendingBriefAdIds] = useState<Set<string>>(() => new Set())
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
  const dialogOpen = showProductForm || showCompetitorForm || showBriefForm || selectedAd !== null || selectedBrief !== null

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
    setAdFilters(selectedProduct ? { productId: selectedProduct.id } : {})
    setIterationMap(null)
    if (!selectedProduct) return
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
  }, [api, selectedProduct?.id])

  useEffect(() => {
    setScalingAnalytics(null)
    setAnalyticsError('')
    if (surface !== 'analytics' || !selectedProduct) return
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

  const createProduct = async (draft: {
    name: string; markets: string[]; platforms: Platform[]; targetAudiences: string[]; uniqueSellingPoints: string[]
  }) => {
    const created = await api.createProduct(draft)
    setProducts((current) => [created, ...current])
    setSelectedProductId(created.id)
    setShowProductForm(false)
    setNotice('Product added to the workspace.')
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

  const analyze = async (axes: IterationAxes) => {
    if (!selectedProduct) return
    const productId = selectedProduct.id
    const generation = detailRequest.current
    const requestId = ++analysisRequest.current
    setPendingOperations((count) => count + 1)
    setError('')
    try {
      const result = await api.analyzeIterationMap(productId, axes)
      if (requestId === analysisRequest.current && generation === detailRequest.current && selectedProductRef.current === productId) setIterationMap(result)
    } catch (reason) {
      if (requestId === analysisRequest.current && generation === detailRequest.current && selectedProductRef.current === productId) setError(message(reason))
    } finally {
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
            {surface === 'overview' && <ProductOverview product={selectedProduct} competitors={competitors} ads={ads} briefs={briefs} />}
            {surface === 'competitors' && (
              <CompetitorsSurface
                competitors={competitors}
                pendingSyncIds={pendingSyncCompetitorIds}
                onAdd={() => setShowCompetitorForm(true)}
                onSync={syncCompetitorAds}
              />
            )}
            {surface === 'ads' && (
              <AdsSurface
                ads={ads}
                competitors={competitors}
                filters={adFilters}
                productId={selectedProduct.id}
                pendingBriefAdIds={pendingBriefAdIds}
                onFilter={reloadAds}
                onCreateBrief={createBriefFromAd}
                onInspect={setSelectedAd}
              />
            )}
            {surface === 'briefs' && (
              <BriefsSurface briefs={briefs} onAdd={() => setShowBriefForm(true)} onEdit={setSelectedBrief} />
            )}
            {surface === 'map' && (
              <IterationMapSurface product={selectedProduct} briefs={briefs} result={iterationMap} onAnalyze={analyze} />
            )}
            {surface === 'analytics' && (
              <AnalyticsSurface result={scalingAnalytics} loading={analyticsLoading} error={analyticsError} />
            )}
          </>
        ) : null}
      </main>

    </div>
      {showProductForm && <ProductDialog onClose={() => setShowProductForm(false)} onSubmit={createProduct} />}
      {showCompetitorForm && <CompetitorDialog onClose={() => setShowCompetitorForm(false)} onSubmit={createCompetitor} />}
      {showBriefForm && <BriefDialog product={selectedProduct} onClose={() => setShowBriefForm(false)} onSubmit={createBrief} />}
      {selectedBrief && <EditBriefDialog brief={selectedBrief} loadVersions={api.listBriefVersions} onClose={() => setSelectedBrief(null)} onSubmit={updateBrief} />}
      {selectedAd && <CreativeDetailDialog ad={selectedAd} pending={pendingBriefAdIds.has(selectedAd.id)} onClose={() => setSelectedAd(null)} onCreateBrief={createBriefFromAd} onAnalyze={analyzeCreative} />}
    </>
  )
}

function ProductOverview({ product, competitors, ads, briefs }: {
  product: Product; competitors: Competitor[]; ads: CompetitorAd[]; briefs: CreativeBrief[]
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

function CompetitorsSurface({ competitors, pendingSyncIds, onAdd, onSync }: {
  competitors: Competitor[]
  pendingSyncIds: ReadonlySet<string>
  onAdd: () => void
  onSync: (competitor: Competitor) => Promise<void>
}) {
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
            {competitor.metaPageUrl && <a href={competitor.metaPageUrl} target="_blank" rel="noreferrer">Open source ↗</a>}
          </article>
        ))}
        {competitors.length === 0 && <EmptyPanel title="No competitors yet" copy="Add the first company you want to study." action="Add competitor" onAction={onAdd} />}
      </div>
    </section>
  )
}

function AdsSurface({ ads, competitors, filters, productId, pendingBriefAdIds, onFilter, onCreateBrief, onInspect }: {
  ads: CompetitorAd[]
  competitors: Competitor[]
  filters: AdFilters
  productId: string
  pendingBriefAdIds: ReadonlySet<string>
  onFilter: (filters: AdFilters) => Promise<void>
  onCreateBrief: (ad: CompetitorAd) => Promise<void>
  onInspect: (ad: CompetitorAd) => void
}) {
  const [query, setQuery] = useState('')
  const [mediaFormat, setMediaFormat] = useState<'all' | 'video' | 'image' | 'carousel' | 'text'>('all')
  const [startedAfter, setStartedAfter] = useState('')
  const visibleAds = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const minimumDate = startedAfter ? new Date(`${startedAfter}T00:00:00Z`).getTime() : null
    return ads.filter((ad) => {
      const searchable = `${ad.advertiserName}\n${ad.body}\n${ad.callToAction ?? ''}`.toLocaleLowerCase()
      if (needle && !searchable.includes(needle)) return false
      if (mediaFormat !== 'all' && creativeMediaFormat(ad) !== mediaFormat) return false
      if (minimumDate !== null && new Date(ad.startedAt).getTime() < minimumDate) return false
      return true
    })
  }, [ads, mediaFormat, query, startedAfter])
  const resultLabel = `${visibleAds.length} ${visibleAds.length === 1 ? 'creative' : 'creatives'}`

  return (
    <section className="surface">
      <SurfaceHeading eyebrow="Competitive evidence" title="Ad Library" />
      <div className="filter-bar">
        <label>Search creatives<input aria-label="Search creatives" type="search" value={query} maxLength={200} placeholder="Copy, CTA, advertiser" onChange={(event) => setQuery(event.target.value)} /></label>
        <label>Competitor<select value={filters.competitorId ?? ''} onChange={(event) => {
          const next: AdFilters = { ...filters, productId }
          if (event.target.value) next.competitorId = event.target.value
          else delete next.competitorId
          void onFilter(next)
        }}>
          <option value="">All competitors</option>{competitors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Status<select value={filters.isActive === undefined ? '' : String(filters.isActive)} onChange={(event) => {
          const next: AdFilters = { ...filters, productId }
          if (event.target.value === '') delete next.isActive
          else next.isActive = event.target.value === 'true'
          void onFilter(next)
        }}>
          <option value="">Any status</option><option value="true">Active</option><option value="false">Inactive</option>
        </select></label>
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
            <div className="ad-visual">
              <AdCreative ad={ad} />
            </div>
            <div className="ad-copy"><p>{ad.body || 'Visual creative without body copy.'}</p></div>
            <div className="ad-meta"><span>{formatDate(ad.startedAt)}</span><span>{ad.callToAction ?? 'No CTA'}</span></div>
            <div className="card-actions"><a href={ad.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a><button aria-label={`View creative details for ${ad.advertiserName}`} onClick={() => onInspect(ad)}>View</button><button disabled={pendingBriefAdIds.has(ad.id)} onClick={() => onCreateBrief(ad)}>{pendingBriefAdIds.has(ad.id) ? 'Creating…' : 'Create brief'}</button></div>
          </article>
        ))}
        {visibleAds.length === 0 && <EmptyPanel title="No ads match this view" copy="Adjust the filters or import source records through the API." />}
      </div>
    </section>
  )
}

function creativeMediaFormat(ad: CompetitorAd): 'video' | 'image' | 'carousel' | 'text' {
  if (ad.adType) return ad.adType
  if (ad.mediaUrls.some(isVideoUrl)) return 'video'
  return ad.mediaUrls.length > 0 ? 'image' : 'text'
}

const noReferrerMediaProps = { referrerPolicy: 'no-referrer' } as Record<string, string>

function AdCreative({ ad }: { ad: CompetitorAd }) {
  const structured = [...(ad.media ?? [])]
    .filter((media) => isApprovedMediaUrl(media.sourceUrl))
    .sort((left, right) => left.order - right.order)
  if (ad.adType === 'carousel' && structured.length > 1) {
    return <div className="creative-carousel" role="region" aria-label={`${ad.advertiserName} carousel`}>
      {structured.map((media, index) => <div className="creative-carousel-card" key={`${media.order}:${media.cardIndex ?? 'root'}:${media.sourceUrl}`}>
        {media.kind === 'video'
          ? <video controls playsInline preload="metadata" {...noReferrerMediaProps} poster={media.posterUrl && isApprovedMediaUrl(media.posterUrl) ? media.posterUrl : undefined} aria-label={`${ad.advertiserName} ad creative card ${index + 1}`}><source src={media.sourceUrl} /></video>
          : <img src={media.sourceUrl} alt={`${ad.advertiserName} ad creative card ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" />}
      </div>)}
    </div>
  }
  const trustedLegacy = ad.mediaUrls.filter(isApprovedMediaUrl)
  const structuredVideo = structured.find((media) => media.kind === 'video')
  const structuredImage = structured.find((media) => media.kind === 'image')
  const videoUrl = structuredVideo?.sourceUrl ?? trustedLegacy.find(isVideoUrl)
  const mediaUrl = videoUrl ?? structuredImage?.sourceUrl ?? trustedLegacy[0]
  if (!mediaUrl) {
    const hadExternalMedia = (ad.media?.length ?? 0) > 0 || ad.mediaUrls.length > 0
    return <span>{hadExternalMedia ? 'External media is not on an approved host.' : initials(ad.advertiserName)}</span>
  }
  if (videoUrl) {
    const structuredPoster = structuredVideo?.posterUrl && isApprovedMediaUrl(structuredVideo.posterUrl) ? structuredVideo.posterUrl : undefined
    const poster = structuredPoster ?? structuredImage?.sourceUrl ?? trustedLegacy.find((url) => !isVideoUrl(url))
    return <video controls playsInline preload="metadata" {...noReferrerMediaProps} poster={poster} aria-label={`${ad.advertiserName} ad creative`}><source src={videoUrl} /></video>
  }
  return <img src={mediaUrl} alt={`${ad.advertiserName} ad creative`} loading="lazy" referrerPolicy="no-referrer" />
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
            <div className="analysis-meta"><span>{analysis.modelProvider} · {analysis.modelName}</span><span>{analysis.analysisVersion} · prompt {analysis.promptVersion}</span><span>{analysis.tags.confidence === undefined ? 'Confidence not supplied' : `${Math.round(analysis.tags.confidence * 100)}% confidence`}</span></div>
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

function BriefsSurface({ briefs, onAdd, onEdit }: { briefs: CreativeBrief[]; onAdd: () => void; onEdit: (brief: CreativeBrief) => void }) {
  return (
    <section className="surface">
      <SurfaceHeading eyebrow="From evidence to action" title="Brief Builder" action="New brief" onAction={onAdd} />
      <div className="brief-board">
        {briefs.map((brief) => (
          <article className="brief-card" key={brief.id}>
            <div className="brief-number">{brief.sourceAdId ? '↗' : '✦'}</div>
            <div className="brief-content"><span className="status-pill">{brief.status}</span><h3>{brief.title}</h3><p>{brief.hook || 'No hook written yet.'}</p></div>
            <div className="dimension-grid">
              {Object.entries(brief.dimensions).map(([key, value]) => <div key={key}><span>{key}</span><strong>{value}</strong></div>)}
            </div>
            <button type="button" className="text-button" aria-label={`Edit ${brief.title}`} onClick={() => onEdit(brief)}>Edit · v{brief.version}</button>
          </article>
        ))}
        {briefs.length === 0 && <EmptyPanel title="The brief board is empty" copy="Start manually or turn an ad into a grounded creative response." action="New brief" onAction={onAdd} />}
      </div>
    </section>
  )
}

function IterationMapSurface({ product, briefs, result, onAnalyze }: {
  product: Product; briefs: CreativeBrief[]; result: IterationMap | null; onAnalyze: (axes: IterationAxes) => Promise<void>
}) {
  const defaults = useMemo<IterationAxes>(() => ({
    audience: unique([...product.targetAudiences, ...briefs.map((brief) => brief.dimensions.audience)]),
    market: unique([...product.markets, ...briefs.map((brief) => brief.dimensions.market)]),
    angle: unique(briefs.map((brief) => brief.dimensions.angle)),
    format: unique(briefs.map((brief) => brief.dimensions.format)),
  }), [product, briefs])
  const [axes, setAxes] = useState<IterationAxes>(() => fallbackAxes(defaults))

  useEffect(() => setAxes(fallbackAxes(defaults)), [defaults])

  return (
    <section className="surface">
      <SurfaceHeading eyebrow="Coverage, not guesswork" title="Iteration Map" />
      <div className="map-layout">
        <form className="axis-panel paper-panel" onSubmit={(event) => { event.preventDefault(); void onAnalyze(axes) }}>
          <div className="panel-heading"><span>Analysis axes</span><small>comma separated</small></div>
          {(Object.keys(axes) as Array<keyof IterationAxes>).map((key) => (
            <label key={key}>{capitalize(key)}<input value={axes[key].join(', ')} onChange={(event) => setAxes((current) => ({ ...current, [key]: csv(event.target.value) }))} required /></label>
          ))}
          <button className="primary-button" type="submit">Analyze coverage</button>
        </form>
        <div className="map-results">
          {result ? (
            <>
              <div className="coverage-summary"><strong>{result.covered.length}<span>/{result.totalCombinations}</span></strong><p>combinations covered</p></div>
              <div className="coverage-grid" aria-label="Iteration coverage cells">
                {result.covered.map((cell) => <CoverageCell key={dimensionKey(cell.dimensions)} covered dimensions={cell.dimensions} count={cell.briefIds.length} />)}
                {result.missing.map((cell) => <CoverageCell key={dimensionKey(cell.dimensions)} dimensions={cell.dimensions} count={0} />)}
              </div>
            </>
          ) : (
            <div className="map-placeholder"><span>4D</span><h3>Map the white space.</h3><p>Set the axes, then compare existing briefs with every intended creative combination.</p></div>
          )}
        </div>
      </div>
    </section>
  )
}

function AnalyticsSurface({ result, loading, error }: { result: ScalingAnalytics | null; loading: boolean; error: string }) {
  return (
    <section className="surface analytics-surface">
      <SurfaceHeading eyebrow="Competitive momentum" title={result?.label ?? 'Scaling signals'} />
      <aside className="proxy-note" aria-label="Metric methodology">
        <strong>Directional proxies</strong>
        <span>Scores infer creative scaling from observed ad activity. They are not verified spend or revenue.</span>
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
    </section>
  )
}

function CoverageCell({ dimensions, count, covered = false }: { dimensions: BriefDimensions; count: number; covered?: boolean }) {
  return <article className={covered ? 'coverage-cell covered' : 'coverage-cell'}><span>{covered ? `${count} brief${count === 1 ? '' : 's'}` : 'Gap'}</span><strong>{dimensions.angle}</strong><p>{dimensions.audience} · {dimensions.market} · {dimensions.format}</p></article>
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

function ProductDialog({ onClose, onSubmit }: {
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
        name: textValue(data, 'name'), markets: csv(textValue(data, 'markets')),
        platforms: data.getAll('platforms').filter((value): value is Platform => typeof value === 'string' && ['ios', 'android', 'web'].includes(value)),
        targetAudiences: csv(textValue(data, 'audiences')), uniqueSellingPoints: csv(textValue(data, 'sellingPoints')),
      })
    } catch (reason) { setSubmitError(message(reason)) } finally { setBusy(false) }
  }
  return <Dialog title="Create product" onClose={onClose} closeDisabled={busy}><form className="form-stack" onSubmit={submit}>
    <FormError message={submitError} />
    <label>Product name<input name="name" maxLength={300} required data-autofocus /></label>
    <label>Markets<input name="markets" placeholder="US, UK" /></label>
    <fieldset><legend>Platforms</legend><label><input type="checkbox" name="platforms" value="ios" /> iOS</label><label><input type="checkbox" name="platforms" value="android" /> Android</label><label><input type="checkbox" name="platforms" value="web" /> Web</label></fieldset>
    <label>Target audiences<input name="audiences" placeholder="Founders, Marketing teams" /></label>
    <label>Unique selling points<textarea name="sellingPoints" placeholder="One idea, another idea" /></label>
    <FormActions onClose={onClose} busy={busy} submit="Create product" />
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

function briefStatusOptions(status: BriefStatus): BriefStatus[] {
  const next: Record<BriefStatus, BriefStatus[]> = {
    draft: ['draft', 'triage', 'archived'], triage: ['triage', 'draft', 'approved', 'archived'],
    approved: ['approved', 'triage', 'production', 'archived'], production: ['production', 'approved', 'review', 'archived'],
    review: ['review', 'production', 'completed', 'archived'], completed: ['completed', 'review', 'archived'], archived: ['archived', 'draft'],
  }
  return next[status]
}

function BriefDialog({ product, onClose, onSubmit }: {
  product: Product | undefined; onClose: () => void
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
      <label>Audience<input aria-label="Audience" name="audience" maxLength={100} defaultValue={product?.targetAudiences[0] ?? ''} required /></label>
      <label>Market<input aria-label="Market" name="market" maxLength={100} defaultValue={product?.markets[0] ?? ''} required /></label>
      <label>Angle<input aria-label="Angle" name="angle" maxLength={100} required /></label>
      <label>Format<input aria-label="Format" name="format" maxLength={100} required /></label>
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

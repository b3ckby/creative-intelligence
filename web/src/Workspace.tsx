import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'

import { ApiError, type AdFilters, type CreativeIntelligenceApi } from './api.ts'
import type {
  BriefDimensions,
  Competitor,
  CompetitorAd,
  CreativeBrief,
  IterationAxes,
  IterationMap,
  Platform,
  Product,
} from './types.ts'

type Surface = 'overview' | 'competitors' | 'ads' | 'briefs' | 'map'

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
]

export function Workspace({ api, organizationLabel, onDisconnect }: WorkspaceProps) {
  const [surface, setSurface] = useState<Surface>('overview')
  const [products, setProducts] = useState<Product[]>([])
  const [selectedProductId, setSelectedProductId] = useState('')
  const [competitors, setCompetitors] = useState<Competitor[]>([])
  const [ads, setAds] = useState<CompetitorAd[]>([])
  const [briefs, setBriefs] = useState<CreativeBrief[]>([])
  const [iterationMap, setIterationMap] = useState<IterationMap | null>(null)
  const [pendingOperations, setPendingOperations] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showProductForm, setShowProductForm] = useState(false)
  const [showCompetitorForm, setShowCompetitorForm] = useState(false)
  const [showBriefForm, setShowBriefForm] = useState(false)
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
  const dialogOpen = showProductForm || showCompetitorForm || showBriefForm

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
              />
            )}
            {surface === 'briefs' && (
              <BriefsSurface briefs={briefs} onAdd={() => setShowBriefForm(true)} />
            )}
            {surface === 'map' && (
              <IterationMapSurface product={selectedProduct} briefs={briefs} result={iterationMap} onAnalyze={analyze} />
            )}
          </>
        ) : null}
      </main>

    </div>
      {showProductForm && <ProductDialog onClose={() => setShowProductForm(false)} onSubmit={createProduct} />}
      {showCompetitorForm && <CompetitorDialog onClose={() => setShowCompetitorForm(false)} onSubmit={createCompetitor} />}
      {showBriefForm && <BriefDialog product={selectedProduct} onClose={() => setShowBriefForm(false)} onSubmit={createBrief} />}
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
            <div><h3>{competitor.name}</h3><p>{competitor.metaPageUrl ? new URL(competitor.metaPageUrl).hostname : 'Meta page not linked'}</p></div>
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

function AdsSurface({ ads, competitors, filters, productId, pendingBriefAdIds, onFilter, onCreateBrief }: {
  ads: CompetitorAd[]
  competitors: Competitor[]
  filters: AdFilters
  productId: string
  pendingBriefAdIds: ReadonlySet<string>
  onFilter: (filters: AdFilters) => Promise<void>
  onCreateBrief: (ad: CompetitorAd) => Promise<void>
}) {
  return (
    <section className="surface">
      <SurfaceHeading eyebrow="Competitive evidence" title="Ad Library" />
      <div className="filter-bar">
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
        <span className="result-count">{ads.length} creatives</span>
      </div>
      <div className="ad-grid">
        {ads.map((ad) => (
          <article className="ad-card" key={ad.id}>
            <div className="ad-card-top"><span>{ad.advertiserName}</span><span className={ad.isActive ? 'live-dot' : 'live-dot off'}>{ad.isActive ? 'Live' : 'Inactive'}</span></div>
            <div className="ad-visual">
              <AdCreative ad={ad} />
            </div>
            <div className="ad-copy"><p>{ad.body || 'Visual creative without body copy.'}</p></div>
            <div className="ad-meta"><span>{formatDate(ad.startedAt)}</span><span>{ad.callToAction ?? 'No CTA'}</span></div>
            <div className="card-actions"><a href={ad.sourceUrl} target="_blank" rel="noreferrer">Source ↗</a><button disabled={pendingBriefAdIds.has(ad.id)} onClick={() => onCreateBrief(ad)}>{pendingBriefAdIds.has(ad.id) ? 'Creating…' : 'Create brief'}</button></div>
          </article>
        ))}
        {ads.length === 0 && <EmptyPanel title="No ads match this view" copy="Adjust the filters or import source records through the API." />}
      </div>
    </section>
  )
}

function AdCreative({ ad }: { ad: CompetitorAd }) {
  const [loaded, setLoaded] = useState(false)
  const mediaUrl = ad.mediaUrls[0]
  if (!mediaUrl) return <span>{initials(ad.advertiserName)}</span>
  if (!loaded) {
    return <button className="media-consent" type="button" aria-label={`Load creative from ${ad.advertiserName}`} onClick={() => setLoaded(true)}><strong>External media</strong><span>Load creative</span></button>
  }
  return <img src={mediaUrl} alt={`${ad.advertiserName} ad creative`} loading="lazy" referrerPolicy="no-referrer" />
}

function BriefsSurface({ briefs, onAdd }: { briefs: CreativeBrief[]; onAdd: () => void }) {
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

function Dialog({ title, onClose, closeDisabled = false, children }: { title: string; onClose: () => void; closeDisabled?: boolean; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeDisabledRef = useRef(closeDisabled)
  closeDisabledRef.current = closeDisabled
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')]
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0])?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!closeDisabledRef.current) onClose(); return }
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
      window.setTimeout(() => previousFocus?.focus(), 0)
    }
  }, [onClose])
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (!closeDisabled && event.target === event.currentTarget) onClose() }}><section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1}><div className="dialog-heading"><span className="eyebrow">Workspace action</span><h2 id="dialog-title">{title}</h2><button type="button" aria-label="Close dialog" onClick={onClose} disabled={closeDisabled}>×</button></div>{children}</section></div>
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
function dimensionKey(value: BriefDimensions): string { return `${value.audience}\u0000${value.market}\u0000${value.angle}\u0000${value.format}` }
function capitalize(value: string): string { return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` }
function textValue(data: FormData, key: string): string { const value = data.get(key); return typeof value === 'string' ? value.trim() : '' }

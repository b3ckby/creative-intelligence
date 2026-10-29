import type {
  AnalyticsHistoryWindow,
  AnalyticsSnapshotMetrics,
  AnalyticsTrend7d,
  BriefDimensions,
  BriefUpdateDraft,
  Competitor,
  CompetitorAd,
  CompetitorAnalyticsComparison,
  CompetitorAnalyticsHistory,
  CompetitorDraft,
  CreativeAnalysis,
  CreativeTagCorrections,
  CreativeTagReview,
  CreativeTagReviewItem,
  CreativeTagReviewStatus,
  CreativeTagReviewSubmission,
  CreativeStrategySummary,
  CreativeBrief,
  CreativeBriefDetails,
  CreativeBriefVersion,
  IterationAxes,
  IterationCell,
  IterationMap,
  InspirationBoard,
  InspirationFilters,
  InspirationItem,
  InspirationMetadataDraft,
  InspirationUpdateDraft,
  ManualBriefDraft,
  Page,
  Platform,
  Product,
  ProductDraft,
  ScalingAnalytics,
  WinningAd,
  WinningAdFilters,
  WinningAdMetadataDraft,
  WinningAdUpdateDraft,
} from './types.ts'

export interface ApiConnection {
  apiBaseUrl: string
  accessToken: string
  organizationId: string
}

export interface AdFilters {
  productId?: string | undefined
  competitorId?: string | undefined
  isActive?: boolean | undefined
  provider?: string | undefined
  search?: string | undefined
  hookCategory?: string | undefined
  angle?: string | undefined
  creativeFormat?: string | undefined
  bookmarked?: boolean | undefined
  sort?: 'first_seen_asc' | 'first_seen_desc' | 'last_seen_asc' | 'last_seen_desc' | 'lifespan_desc' | 'impressions_desc' | undefined
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface CreativeIntelligenceApi {
  listProducts(): Promise<Page<Product>>
  createProduct(draft: ProductDraft): Promise<Product>
  updateProduct(productId: string, draft: ProductDraft): Promise<Product>
  archiveProduct(productId: string): Promise<Product>
  restoreProduct(productId: string): Promise<Product>
  listCompetitors(productId: string): Promise<Page<Competitor>>
  createCompetitor(productId: string, draft: CompetitorDraft): Promise<Competitor>
  syncApifyMetaAds(productId: string, competitorId: string): Promise<{ inserted: number; duplicates: number }>
  listAds(filters?: AdFilters): Promise<Page<CompetitorAd>>
  setAdBookmark(adId: string, bookmarked: boolean): Promise<{ bookmarked: boolean }>
  listWinningAds(filters?: WinningAdFilters): Promise<Page<WinningAd>>
  getWinningAd(winningAdId: string, includeArchived?: boolean): Promise<WinningAd>
  saveWinningAd(sourceAdId: string, draft: WinningAdMetadataDraft): Promise<WinningAd>
  updateWinningAd(winningAdId: string, draft: WinningAdUpdateDraft): Promise<WinningAd>
  archiveWinningAd(winningAdId: string): Promise<WinningAd>
  removeWinningAd(winningAdId: string): Promise<void>
  listInspirationBoards(): Promise<Page<InspirationBoard>>
  createInspirationBoard(draft: { name: string; description: string }): Promise<InspirationBoard>
  listInspirationItems(filters?: InspirationFilters): Promise<Page<InspirationItem>>
  getInspirationItem(itemId: string, includeArchived?: boolean): Promise<InspirationItem>
  createInspirationItem(boardId: string, sourceKind: 'competitor_ad' | 'winning_ad', sourceId: string, draft: InspirationMetadataDraft): Promise<InspirationItem>
  updateInspirationItem(itemId: string, draft: InspirationUpdateDraft): Promise<InspirationItem>
  archiveInspirationItem(itemId: string): Promise<InspirationItem>
  removeInspirationItem(itemId: string): Promise<void>
  listBriefs(productId: string): Promise<Page<CreativeBrief>>
  createManualBrief(productId: string, draft: ManualBriefDraft): Promise<CreativeBrief>
  createBriefFromAd(productId: string, input: { adId: string; title: string; dimensions: BriefDimensions }): Promise<CreativeBrief>
  createAiBriefFromAd(productId: string, input: { adId: string; title: string }): Promise<CreativeBrief>
  getBriefHandoff(briefId: string): Promise<{ briefId: string; version: number; filename: string; markdown: string }>
  updateBrief(briefId: string, input: BriefUpdateDraft): Promise<CreativeBrief>
  listBriefVersions(briefId: string): Promise<CreativeBriefVersion[]>
  analyzeIterationMap(productId: string, axes: IterationAxes): Promise<IterationMap>
  getCompetitorAnalyticsHistory(productId: string, competitorId: string, windowDays: AnalyticsHistoryWindow): Promise<CompetitorAnalyticsHistory>
  compareCompetitorAnalytics(productId: string, competitorIds: string[]): Promise<CompetitorAnalyticsComparison>
  getScalingAnalytics(productId: string): Promise<ScalingAnalytics>
  analyzeCreative(productId: string, adId: string): Promise<CreativeAnalysis>
  listCreativeTagReviews(filters?: { productId?: string; status?: CreativeTagReviewStatus }): Promise<CreativeTagReviewItem[]>
  getCreativeTagReview(adId: string, analysisVersion: string, inputFingerprint: string): Promise<CreativeTagReviewItem>
  listCreativeTagReviewHistory(adId: string, analysisVersion: string, inputFingerprint: string): Promise<CreativeTagReview[]>
  submitCreativeTagReview(adId: string, input: CreativeTagReviewSubmission): Promise<CreativeTagReview>
  getCreativeStrategy(productId: string, competitorId: string): Promise<CreativeStrategySummary>
}

const PAGE_LIMIT = 100
const MAX_PAGES = 100

export function createApiClient(connection: ApiConnection): CreativeIntelligenceApi {
  const baseUrl = normalizeApiBaseUrl(connection.apiBaseUrl)
  const accessToken = required(connection.accessToken, 'Access token')
  const organizationId = required(connection.organizationId, 'Organization ID')
  const organizationPath = `/organizations/${encodeURIComponent(organizationId)}`

  const request = async <T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, parse: (value: unknown) => T, body?: unknown): Promise<T> => {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new ApiError(0, 'Unable to reach the API')
    }

    if (response.ok && response.status === 204) return parse(undefined)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') throw invalidResponse(response.ok ? 502 : response.status)

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw invalidResponse(response.ok ? 502 : response.status)
    }

    if (!response.ok) throw new ApiError(response.status, publicError(payload))
    try {
      return parse(payload)
    } catch (reason) {
      if (reason instanceof ApiError) throw reason
      throw invalidResponse()
    }
  }

  const requestAll = async <T>(path: string, parseItem: (value: unknown) => T): Promise<Page<T>> => {
    const items: T[] = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const page: Page<T> = await request<Page<T>>('GET', withCursor(path, cursor), (value) => parsePage(value, parseItem))
      items.push(...page.items)
      if (page.nextCursor === null) return { items, nextCursor: null }
      if (seenCursors.has(page.nextCursor)) throw invalidResponse()
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    throw new ApiError(413, 'The collection is too large to display safely')
  }

  return {
    listProducts: () => requestAll(`${organizationPath}/products?limit=${PAGE_LIMIT}&includeArchived=true`, parseProduct),
    createProduct: (draft) => request('POST', `${organizationPath}/products`, parseProduct, draft),
    updateProduct: async (productId, draft) => request('PATCH', `${organizationPath}/products/${segment(productId)}`, parseProduct, draft),
    archiveProduct: async (productId) => request('POST', `${organizationPath}/products/${segment(productId)}/archive`, parseProduct),
    restoreProduct: async (productId) => request('POST', `${organizationPath}/products/${segment(productId)}/restore`, parseProduct),
    listCompetitors: (productId) => requestAll(`${organizationPath}/products/${segment(productId)}/competitors?limit=${PAGE_LIMIT}`, parseCompetitor),
    createCompetitor: (productId, draft) => request('POST', `${organizationPath}/products/${segment(productId)}/competitors`, parseCompetitor, draft),
    syncApifyMetaAds: (productId, competitorId) => request('POST', `${organizationPath}/products/${segment(productId)}/competitors/${segment(competitorId)}/ads/apify-meta/sync`, parseImportResult),
    listAds: (filters = {}) => {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (filters.productId) query.set('productId', filters.productId)
      if (filters.competitorId) query.set('competitorId', filters.competitorId)
      if (filters.isActive !== undefined) query.set('isActive', String(filters.isActive))
      if (filters.provider) query.set('provider', filters.provider)
      if (filters.search) query.set('search', filters.search)
      if (filters.hookCategory) query.set('hookCategory', filters.hookCategory)
      if (filters.angle) query.set('angle', filters.angle)
      if (filters.creativeFormat) query.set('creativeFormat', filters.creativeFormat)
      if (filters.bookmarked !== undefined) query.set('bookmarked', String(filters.bookmarked))
      if (filters.sort) query.set('sort', filters.sort)
      return requestAll(`${organizationPath}/ads?${query.toString()}`, parseAd)
    },
    setAdBookmark: (adId, bookmarked) => request('POST', `${organizationPath}/ads/${segment(adId)}/bookmark`, parseBookmarkState, { bookmarked }),
    listWinningAds: (filters = {}) => {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (filters.search) query.set('search', filters.search)
      if (filters.category) query.set('category', filters.category)
      if (filters.active !== undefined) query.set('active', String(filters.active))
      if (filters.includeArchived !== undefined) query.set('includeArchived', String(filters.includeArchived))
      return requestAll(`${organizationPath}/winning-ads?${query.toString()}`, parseWinningAd)
    },
    getWinningAd: (winningAdId, includeArchived = false) => request('GET', `${organizationPath}/winning-ads/${segment(winningAdId)}?includeArchived=${includeArchived}`, parseWinningAd),
    saveWinningAd: (sourceAdId, draft) => request('POST', `${organizationPath}/winning-ads`, parseWinningAd, { sourceAdId, ...draft }),
    updateWinningAd: (winningAdId, draft) => request('PATCH', `${organizationPath}/winning-ads/${segment(winningAdId)}`, parseWinningAd, draft),
    archiveWinningAd: (winningAdId) => request('POST', `${organizationPath}/winning-ads/${segment(winningAdId)}/archive`, parseWinningAd),
    removeWinningAd: (winningAdId) => request('DELETE', `${organizationPath}/winning-ads/${segment(winningAdId)}`, parseVoid),
    listInspirationBoards: () => requestAll(`${organizationPath}/inspiration/boards?limit=${PAGE_LIMIT}`, parseInspirationBoard),
    createInspirationBoard: (draft) => request('POST', `${organizationPath}/inspiration/boards`, parseInspirationBoard, draft),
    listInspirationItems: (filters = {}) => {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (filters.boardId) query.set('boardId', filters.boardId)
      if (filters.search) query.set('search', filters.search)
      if (filters.tag) query.set('tag', filters.tag)
      if (filters.sourceKind) query.set('sourceKind', filters.sourceKind)
      if (filters.sort) query.set('sort', filters.sort)
      if (filters.includeArchived !== undefined) query.set('includeArchived', String(filters.includeArchived))
      return requestAll(`${organizationPath}/inspiration/items?${query.toString()}`, parseInspirationItem)
    },
    getInspirationItem: (itemId, includeArchived = false) => request('GET', `${organizationPath}/inspiration/items/${segment(itemId)}?includeArchived=${includeArchived}`, parseInspirationItem),
    createInspirationItem: (boardId, sourceKind, sourceId, draft) => request('POST', `${organizationPath}/inspiration/boards/${segment(boardId)}/items`, parseInspirationItem, { sourceKind, sourceId, ...draft }),
    updateInspirationItem: (itemId, draft) => request('PATCH', `${organizationPath}/inspiration/items/${segment(itemId)}`, parseInspirationItem, draft),
    archiveInspirationItem: (itemId) => request('POST', `${organizationPath}/inspiration/items/${segment(itemId)}/archive`, parseInspirationItem),
    removeInspirationItem: (itemId) => request('DELETE', `${organizationPath}/inspiration/items/${segment(itemId)}`, parseVoid),
    listBriefs: (productId) => requestAll(`${organizationPath}/products/${segment(productId)}/briefs?limit=${PAGE_LIMIT}`, parseBrief),
    createManualBrief: (productId, draft) => request('POST', `${organizationPath}/products/${segment(productId)}/briefs`, parseBrief, draft),
    createBriefFromAd: (productId, input) => request('POST', `${organizationPath}/products/${segment(productId)}/briefs/from-ad`, parseBrief, input),
    createAiBriefFromAd: (productId, input) => request('POST', `${organizationPath}/products/${segment(productId)}/briefs/from-ad/ai`, parseBrief, input),
    getBriefHandoff: (briefId) => request('GET', `${organizationPath}/briefs/${segment(briefId)}/handoff`, parseBriefHandoff),
    updateBrief: (briefId, input) => request('PATCH', `${organizationPath}/briefs/${segment(briefId)}`, parseBrief, input),
    listBriefVersions: (briefId) => request('GET', `${organizationPath}/briefs/${segment(briefId)}/versions?limit=${PAGE_LIMIT}`, parseBriefVersions),
    analyzeIterationMap: (productId, axes) => request('POST', `${organizationPath}/products/${segment(productId)}/iteration-map/analyze`, parseIterationMap, { axes }),
    getCompetitorAnalyticsHistory: (productId, competitorId, windowDays) => request('GET', `${organizationPath}/products/${segment(productId)}/competitors/${segment(competitorId)}/analytics/history?window=${windowDays}`, parseCompetitorAnalyticsHistory),
    compareCompetitorAnalytics: (productId, competitorIds) => request('POST', `${organizationPath}/products/${segment(productId)}/analytics/comparison`, parseCompetitorAnalyticsComparison, { competitorIds }),
    getScalingAnalytics: (productId) => request('GET', `${organizationPath}/products/${segment(productId)}/analytics/scaling`, parseScalingAnalytics),
    analyzeCreative: (productId, adId) => request('POST', `${organizationPath}/products/${segment(productId)}/ads/${segment(adId)}/creative-analysis`, parseCreativeAnalysis),
    listCreativeTagReviews: (filters = {}) => {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (filters.productId) query.set('productId', filters.productId)
      if (filters.status) query.set('status', filters.status)
      return request('GET', `${organizationPath}/creative-tag-reviews?${query.toString()}`, parseCreativeTagReviewItems)
    },
    getCreativeTagReview: (adId, analysisVersion, inputFingerprint) => request('GET', `${organizationPath}/ads/${segment(adId)}/creative-tag-review?${reviewIdentityQuery(analysisVersion, inputFingerprint)}`, parseCreativeTagReviewItem),
    listCreativeTagReviewHistory: (adId, analysisVersion, inputFingerprint) => request('GET', `${organizationPath}/ads/${segment(adId)}/creative-tag-review/history?${reviewIdentityQuery(analysisVersion, inputFingerprint)}&limit=${PAGE_LIMIT}`, parseCreativeTagReviewHistory),
    submitCreativeTagReview: (adId, input) => request('POST', `${organizationPath}/ads/${segment(adId)}/creative-tag-review`, parseCreativeTagReview, input),
    getCreativeStrategy: (productId, competitorId) => request('GET', `${organizationPath}/products/${segment(productId)}/competitors/${segment(competitorId)}/creative-strategy`, parseCreativeStrategy),
  }
}

export interface StagingSession {
  accessToken: string
  organizationId: string
}

export async function exchangeStagingPassword(apiBaseUrl: string, password: string): Promise<StagingSession> {
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl)
  if (typeof password !== 'string' || password.length < 1 || password.length > 1_024) throw new ApiError(400, 'Password is required')
  let response: Response
  try {
    response = await fetch(`${baseUrl}/auth/staging-login`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
  } catch {
    throw new ApiError(0, 'Unable to reach the API')
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw invalidResponse(response.ok ? 502 : response.status)
  let payload: unknown
  try { payload = await response.json() } catch { throw invalidResponse(response.ok ? 502 : response.status) }
  if (!response.ok) throw new ApiError(response.status, publicError(payload))
  const record = exactObject(payload, ['accessToken', 'organizationId'])
  if (!isBoundedString(record.accessToken, 1, 8_192) || !isBoundedString(record.organizationId, 1, 256)) throw invalidResponse()
  return { accessToken: record.accessToken, organizationId: record.organizationId }
}

export function normalizeApiBaseUrl(value: string): string {
  const candidate = value.trim()
  if (!candidate) {
    if (typeof window !== 'undefined' && window.location.protocol === 'http:' && !isLoopbackHost(window.location.hostname)) throw new ApiError(0, 'API URL must use HTTPS')
    return ''
  }
  let parsed: URL
  try { parsed = new URL(candidate) } catch { throw new ApiError(0, 'API URL is invalid') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new ApiError(0, 'API URL is invalid')
  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) throw new ApiError(0, 'API URL must use HTTPS')
  return parsed.href.replace(/\/$/, '')
}

function withCursor(path: string, cursor: string | null): string {
  return cursor === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`
}

function parsePage<T>(value: unknown, parseItem: (value: unknown) => T): Page<T> {
  const record = exactObject(value, ['items', 'nextCursor'])
  if (!Array.isArray(record.items) || record.items.length > PAGE_LIMIT) throw invalidResponse()
  const nextCursor = record.nextCursor
  if (nextCursor !== null && !isBoundedString(nextCursor, 1, 8_192)) throw invalidResponse()
  return { items: record.items.map(parseItem), nextCursor }
}

function parseProduct(value: unknown): Product {
  const record = exactObject(value, ['id', 'organizationId', 'name', 'markets', 'platforms', 'targetAudiences', 'uniqueSellingPoints', 'archivedAt', 'createdAt'])
  const platforms = stringArray(record.platforms, 100)
  if (!platforms.every((platform): platform is Platform => platform === 'ios' || platform === 'android' || platform === 'web')) throw invalidResponse()
  return {
    id: identifier(record.id), organizationId: identifier(record.organizationId), name: text(record.name, 300),
    markets: textArray(record.markets, 100, 500), platforms,
    targetAudiences: textArray(record.targetAudiences, 100, 500), uniqueSellingPoints: textArray(record.uniqueSellingPoints, 100, 500),
    archivedAt: nullableTimestamp(record.archivedAt), createdAt: timestamp(record.createdAt),
  }
}

function parseCompetitor(value: unknown): Competitor {
  const record = exactObject(value, ['id', 'organizationId', 'productId', 'name', 'metaPageUrl', 'archivedAt', 'createdAt'])
  return {
    id: identifier(record.id), organizationId: identifier(record.organizationId), productId: identifier(record.productId), name: text(record.name, 300),
    metaPageUrl: record.metaPageUrl === null ? null : httpsUrl(record.metaPageUrl), archivedAt: nullableTimestamp(record.archivedAt), createdAt: timestamp(record.createdAt),
  }
}

function parseAd(value: unknown): CompetitorAd {
  const adKeys = [
    'id', 'organizationId', 'productId', 'competitorId', 'providerName', 'platform', 'externalId', 'pageId', 'advertiserName', 'body',
    'headline', 'description', 'callToAction', 'displayFormat', 'adType', 'startedAt', 'endedAt', 'isActive', 'publisherPlatforms',
    'impressionsLowerBound', 'impressionsUpperBound', 'spendLowerBound', 'spendUpperBound', 'currency', 'media',
    'mediaUrls', 'sourceUrl', 'firstSeenAt', 'lastSeenAt',
  ]
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'mirroredMediaUrls')) adKeys.push('mirroredMediaUrls')
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, 'bookmarked')) adKeys.push('bookmarked')
  const record = exactObject(value, adKeys)
  if (record.platform !== 'meta' || typeof record.isActive !== 'boolean') throw invalidResponse()
  const providerName = text(record.providerName, 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerName)) throw invalidResponse()
  const result: CompetitorAd = {
    id: identifier(record.id), organizationId: identifier(record.organizationId), productId: identifier(record.productId), competitorId: identifier(record.competitorId),
    providerName, platform: 'meta', externalId: identifier(record.externalId), pageId: nullableText(record.pageId, 256), advertiserName: text(record.advertiserName, 500),
    body: text(record.body, 20_000, true), headline: nullableText(record.headline, 500), description: nullableText(record.description, 2_000),
    callToAction: nullableText(record.callToAction, 100), displayFormat: nullableText(record.displayFormat, 100), adType: nullableAdType(record.adType),
    startedAt: timestamp(record.startedAt), endedAt: nullableTimestamp(record.endedAt), isActive: record.isActive,
    publisherPlatforms: record.publisherPlatforms === null ? null : textArray(record.publisherPlatforms, 20, 100),
    impressionsLowerBound: nullableNonNegativeNumber(record.impressionsLowerBound), impressionsUpperBound: nullableNonNegativeNumber(record.impressionsUpperBound),
    spendLowerBound: nullableNonNegativeNumber(record.spendLowerBound), spendUpperBound: nullableNonNegativeNumber(record.spendUpperBound),
    currency: nullableCurrency(record.currency), media: parseNullableMedia(record.media),
    mediaUrls: urlArray(record.mediaUrls, 50), sourceUrl: httpsUrl(record.sourceUrl),
    firstSeenAt: timestamp(record.firstSeenAt), lastSeenAt: timestamp(record.lastSeenAt),
  }
  if (Object.hasOwn(record, 'bookmarked')) {
    if (typeof record.bookmarked !== 'boolean') throw invalidResponse()
    result.bookmarked = record.bookmarked
  }
  if (Object.hasOwn(record, 'mirroredMediaUrls')) {
    if (!Array.isArray(record.mirroredMediaUrls) || record.mirroredMediaUrls.length !== result.mediaUrls.length) throw invalidResponse()
    result.mirroredMediaUrls = record.mirroredMediaUrls.map((reference) => reference === null ? null : mirroredReference(reference))
  }
  return result
}

function parseVoid(value: unknown): void {
  if (value !== undefined) throw invalidResponse()
}

function parseWinningAd(value: unknown): WinningAd {
  const record = exactObject(value, ['id', 'organizationId', 'sourceAdId', 'title', 'category', 'notes', 'source', 'copy', 'media', 'analysis', 'version', 'archivedAt', 'createdAt', 'updatedAt'])
  const category = enumText(record.category, ['classic', 'modern', 'minimal', 'bold', 'lifestyle', 'product'] as const)
  const source = exactObject(record.source, ['provider', 'platform', 'externalId', 'url', 'advertiserName', 'isActive'])
  const provider = text(source.provider, 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider) || source.platform !== 'meta' || typeof source.isActive !== 'boolean') throw invalidResponse()
  const copy = exactObject(record.copy, ['body', 'headline', 'description', 'callToAction'])
  if (!Array.isArray(record.media) || record.media.length < 1 || record.media.length > 50) throw invalidResponse()
  const media = record.media.map((value, index) => {
    const item = exactObject(value, ['position', 'kind', 'mediaType', 'checksum', 'url'])
    if (item.position !== index || (item.kind !== 'image' && item.kind !== 'video' && item.kind !== 'unknown')) throw invalidResponse()
    const kind = item.kind as 'image' | 'video' | 'unknown'
    const mediaType = enumText(item.mediaType, ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'] as const)
    if (typeof item.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(item.checksum)) throw invalidResponse()
    const url = mirroredReference(item.url)
    if (url !== `/media/sha256/${item.checksum}`) throw invalidResponse()
    return { position: index, kind, mediaType, checksum: item.checksum, url }
  })
  let analysis: WinningAd['analysis'] = null
  if (record.analysis !== null) {
    const item = exactObject(record.analysis, ['tags', 'provenance', 'version', 'analyzedAt'])
    analysis = { tags: parseCreativeAnalysisTags(item.tags), provenance: enumText(item.provenance, ['manual', 'automatic'] as const), version: text(item.version, 128), analyzedAt: timestamp(item.analyzedAt) }
  }
  const version = boundedInteger(record.version, 1, Number.MAX_SAFE_INTEGER)
  return {
    id: identifier(record.id), organizationId: identifier(record.organizationId), sourceAdId: identifier(record.sourceAdId), title: text(record.title, 300), category, notes: text(record.notes, 2_000, true),
    source: { provider, platform: 'meta', externalId: identifier(source.externalId), url: httpsUrl(source.url), advertiserName: text(source.advertiserName, 500), isActive: source.isActive },
    copy: { body: text(copy.body, 20_000, true), headline: nullableText(copy.headline, 500), description: nullableText(copy.description, 2_000), callToAction: nullableText(copy.callToAction, 100) },
    media, analysis, version, archivedAt: nullableTimestamp(record.archivedAt), createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt),
  }
}

function parseInspirationBoard(value: unknown): InspirationBoard {
  const record = exactObject(value, ['id', 'organizationId', 'name', 'description', 'version', 'archivedAt', 'createdAt', 'updatedAt'])
  return { id: identifier(record.id), organizationId: identifier(record.organizationId), name: text(record.name, 200), description: text(record.description, 1_000, true), version: boundedInteger(record.version, 1, Number.MAX_SAFE_INTEGER), archivedAt: nullableTimestamp(record.archivedAt), createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt) }
}

function parseInspirationItem(value: unknown): InspirationItem {
  const record = exactObject(value, ['id', 'organizationId', 'boardId', 'sourceKind', 'sourceId', 'title', 'notes', 'tags', 'source', 'copy', 'media', 'version', 'archivedAt', 'createdAt', 'updatedAt'])
  const sourceKind = enumText(record.sourceKind, ['competitor_ad', 'winning_ad'] as const)
  const source = exactObject(record.source, ['provider', 'platform', 'externalId', 'url', 'advertiserName'])
  const provider = text(source.provider, 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(provider) || source.platform !== 'meta') throw invalidResponse()
  const copy = exactObject(record.copy, ['body', 'headline'])
  if (!Array.isArray(record.media) || record.media.length < 1 || record.media.length > 50) throw invalidResponse()
  const media = record.media.map((value, index) => {
    const item = exactObject(value, ['position', 'kind', 'mediaType', 'checksum', 'url'])
    if (item.position !== index || (item.kind !== 'image' && item.kind !== 'video' && item.kind !== 'unknown')) throw invalidResponse()
    const kind = item.kind as 'image' | 'video' | 'unknown'
    const mediaType = enumText(item.mediaType, ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'] as const)
    if (typeof item.checksum !== 'string' || !/^[a-f0-9]{64}$/u.test(item.checksum)) throw invalidResponse()
    const url = mirroredReference(item.url); if (url !== `/media/sha256/${item.checksum}`) throw invalidResponse()
    return { position: index, kind, mediaType, checksum: item.checksum, url }
  })
  return {
    id: identifier(record.id), organizationId: identifier(record.organizationId), boardId: identifier(record.boardId), sourceKind, sourceId: identifier(record.sourceId),
    title: text(record.title, 300), notes: text(record.notes, 4_000, true), tags: textArray(record.tags, 20, 60),
    source: { provider, platform: 'meta', externalId: identifier(source.externalId), url: httpsUrl(source.url), advertiserName: text(source.advertiserName, 500) },
    copy: { body: text(copy.body, 20_000, true), headline: nullableText(copy.headline, 500) }, media,
    version: boundedInteger(record.version, 1, Number.MAX_SAFE_INTEGER), archivedAt: nullableTimestamp(record.archivedAt), createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt),
  }
}

function parseBookmarkState(value: unknown): { bookmarked: boolean } {
  const record = exactObject(value, ['bookmarked'])
  if (typeof record.bookmarked !== 'boolean') throw invalidResponse()
  return { bookmarked: record.bookmarked }
}

function parseImportResult(value: unknown): { inserted: number; duplicates: number } {
  const record = exactObject(value, ['inserted', 'duplicates'])
  if (!Number.isSafeInteger(record.inserted) || (record.inserted as number) < 0 || !Number.isSafeInteger(record.duplicates) || (record.duplicates as number) < 0) throw invalidResponse()
  return { inserted: record.inserted as number, duplicates: record.duplicates as number }
}

function parseBrief(value: unknown): CreativeBrief {
  const requiredKeys = ['id', 'organizationId', 'productId', 'title', 'status', 'sourceAdId', 'hook', 'callToAction', 'dimensions', 'version', 'createdAt', 'updatedAt']
  const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const keys = [...requiredKeys, ...(Object.hasOwn(source, 'details') ? ['details'] : [])]
  const record = exactObject(value, keys)
  const statuses = ['draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived'] as const
  if (!statuses.includes(record.status as typeof statuses[number])) throw invalidResponse()
  const version = integer(record.version)
  if (version < 1) throw invalidResponse()
  const result: CreativeBrief = {
    id: identifier(record.id), organizationId: identifier(record.organizationId), productId: identifier(record.productId), title: text(record.title, 500),
    status: record.status as CreativeBrief['status'], sourceAdId: record.sourceAdId === null ? null : identifier(record.sourceAdId),
    hook: text(record.hook, 20_000, true), callToAction: nullableText(record.callToAction, 100), dimensions: parseDimensions(record.dimensions),
    version, createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt),
  }
  if (Object.hasOwn(record, 'details')) result.details = record.details === null ? null : parseBriefDetails(record.details)
  return result
}

function parseBriefVersions(value: unknown): CreativeBriefVersion[] {
  const record = exactObject(value, ['items'])
  if (!Array.isArray(record.items) || record.items.length > 100) throw invalidResponse()
  return record.items.map((item) => {
    const source = typeof item === 'object' && item !== null && !Array.isArray(item) ? item : {}
    const versionKeys = ['id', 'organizationId', 'productId', 'title', 'status', 'sourceAdId', 'hook', 'callToAction', 'dimensions', 'version', 'createdAt', 'updatedAt', 'changedBy', 'changedAt']
    if (Object.hasOwn(source, 'details')) versionKeys.push('details')
    const version = exactObject(item, versionKeys)
    const brief = parseBrief(Object.fromEntries(Object.entries(version).filter(([key]) => key !== 'changedBy' && key !== 'changedAt')))
    return { ...brief, changedBy: identifier(version.changedBy), changedAt: timestamp(version.changedAt) }
  })
}

function parseBriefDetails(value: unknown): CreativeBriefDetails {
  const root = exactObject(value, ['strategy', 'artDirection', 'narrative', 'production'])
  const strategy = exactObject(root.strategy, ['targetAudience', 'objective', 'keyMessage', 'tension', 'proofPoints'])
  const art = exactObject(root.artDirection, ['format', 'visualStyle', 'setting', 'talent', 'audio', 'color', 'mandatoryElements'])
  const narrative = exactObject(root.narrative, ['storyArc', 'hooks', 'bodyScript', 'ctas'])
  const production = exactObject(root.production, ['aspectRatios', 'durationSeconds', 'deliverables', 'shotList', 'handoffNotes', 'sourceAnalysis'])
  const source = exactObject(production.sourceAnalysis, ['analysisVersion', 'confidence'])
  if (!Array.isArray(narrative.hooks) || narrative.hooks.length < 1 || narrative.hooks.length > 5) throw invalidResponse()
  if (!Array.isArray(production.shotList) || production.shotList.length < 1 || production.shotList.length > 50) throw invalidResponse()
  const durationSeconds = integer(production.durationSeconds)
  if (durationSeconds < 1 || durationSeconds > 300) throw invalidResponse()
  if (typeof source.confidence !== 'number' || !Number.isFinite(source.confidence) || source.confidence < 0 || source.confidence > 1) throw invalidResponse()
  return {
    strategy: { targetAudience: text(strategy.targetAudience, 100), objective: text(strategy.objective, 100), keyMessage: text(strategy.keyMessage, 600), tension: text(strategy.tension, 240), proofPoints: parseTextList(strategy.proofPoints, 8, 240) },
    artDirection: { format: text(art.format, 100), visualStyle: text(art.visualStyle, 160), setting: text(art.setting, 600), talent: text(art.talent, 100), audio: text(art.audio, 240), color: text(art.color, 240), mandatoryElements: parseTextList(art.mandatoryElements, 8, 240) },
    narrative: {
      storyArc: text(narrative.storyArc, 600), bodyScript: text(narrative.bodyScript, 20_000, true), ctas: parseTextList(narrative.ctas, 5, 120),
      hooks: narrative.hooks.map((item) => { const hook = exactObject(item, ['visual', 'spoken', 'onScreenText']); return { visual: text(hook.visual, 600), spoken: text(hook.spoken, 600), onScreenText: text(hook.onScreenText, 240) } }),
    },
    production: {
      aspectRatios: parseTextList(production.aspectRatios, 5, 20), durationSeconds, deliverables: parseTextList(production.deliverables, 20, 240),
      shotList: production.shotList.map((item) => { const shot = exactObject(item, ['sequence', 'description', 'audio', 'onScreenText']); const sequence = integer(shot.sequence); if (sequence < 1 || sequence > 50) throw invalidResponse(); return { sequence, description: text(shot.description, 600), audio: text(shot.audio, 20_000, true), onScreenText: text(shot.onScreenText, 240) } }),
      handoffNotes: text(production.handoffNotes, 2_000, true), sourceAnalysis: { analysisVersion: text(source.analysisVersion, 100), confidence: source.confidence },
    },
  }
}

function parseTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw invalidResponse()
  return value.map((item) => text(item, maxLength))
}

function parseBriefHandoff(value: unknown): { briefId: string; version: number; filename: string; markdown: string } {
  const record = exactObject(value, ['briefId', 'version', 'filename', 'markdown'])
  const version = integer(record.version)
  if (version < 1) throw invalidResponse()
  return { briefId: identifier(record.briefId), version, filename: text(record.filename, 600), markdown: text(record.markdown, 100_000, true) }
}

function parseDimensions(value: unknown): BriefDimensions {
  const record = exactObject(value, ['audience', 'market', 'angle', 'format'])
  return { audience: text(record.audience, 100), market: text(record.market, 100), angle: text(record.angle, 100), format: text(record.format, 100) }
}

function parseIterationCell(value: unknown): IterationCell {
  const record = exactObject(value, ['dimensions', 'briefIds', 'briefs', 'briefCount', 'hasMoreBriefs'])
  if (!Array.isArray(record.briefIds) || record.briefIds.length > 10_000 || !Array.isArray(record.briefs) || record.briefs.length > 25) throw invalidResponse()
  const briefIds = record.briefIds.map(identifier)
  const briefs = record.briefs.map((value) => {
    const evidence = exactObject(value, ['id', 'title', 'status'])
    const statuses = ['draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived'] as const
    if (!statuses.includes(evidence.status as typeof statuses[number])) throw invalidResponse()
    return { id: identifier(evidence.id), title: text(evidence.title, 500), status: evidence.status as CreativeBrief['status'] }
  })
  const briefCount = integer(record.briefCount)
  if (typeof record.hasMoreBriefs !== 'boolean' || briefCount !== briefIds.length || briefs.some((brief, index) => brief.id !== briefIds[index]) || record.hasMoreBriefs !== (briefCount > briefs.length)) throw invalidResponse()
  return { dimensions: parseDimensions(record.dimensions), briefIds, briefs, briefCount, hasMoreBriefs: record.hasMoreBriefs }
}

function parseIterationMap(value: unknown): IterationMap {
  const record = exactObject(value, ['totalCombinations', 'covered', 'missing'])
  if (!Number.isInteger(record.totalCombinations) || (record.totalCombinations as number) < 1 || (record.totalCombinations as number) > 10_000) throw invalidResponse()
  if (!Array.isArray(record.covered) || record.covered.length > 10_000 || !Array.isArray(record.missing) || record.missing.length > 10_000) throw invalidResponse()
  const covered = record.covered.map(parseIterationCell)
  const missing = record.missing.map(parseIterationCell)
  if (covered.length + missing.length !== record.totalCombinations || covered.some(({ briefCount }) => briefCount === 0) || missing.some(({ briefCount }) => briefCount !== 0)) throw invalidResponse()
  return { totalCombinations: record.totalCombinations as number, covered, missing }
}

function parseCompetitorAnalyticsHistory(value: unknown): CompetitorAnalyticsHistory {
  const record = exactObject(value, ['label', 'competitor', 'windowDays', 'trend7d', 'items'])
  if (record.label !== 'Public Ad Library momentum proxy' || (record.windowDays !== 7 && record.windowDays !== 30 && record.windowDays !== 90)) throw invalidResponse()
  if (!Array.isArray(record.items) || record.items.length > record.windowDays) throw invalidResponse()
  const items = record.items.map(parseAnalyticsSnapshot)
  if (items.some((item, index) => index > 0 && item.snapshotDate >= items[index-1]!.snapshotDate)) throw invalidResponse()
  return {
    label: record.label, competitor: parseCompetitorIdentity(record.competitor), windowDays: record.windowDays,
    trend7d: record.trend7d === null ? null : parseAnalyticsTrend(record.trend7d), items,
  }
}

function parseCompetitorAnalyticsComparison(value: unknown): CompetitorAnalyticsComparison {
  const record = exactObject(value, ['label', 'items'])
  if (record.label !== 'Public Ad Library momentum proxy' || !Array.isArray(record.items) || record.items.length < 2 || record.items.length > 10) throw invalidResponse()
  const seen = new Set<string>()
  const items = record.items.map((item) => {
    const entry = exactObject(item, ['competitor', 'latest', 'trend7d'])
    const competitor = parseCompetitorIdentity(entry.competitor)
    if (seen.has(competitor.id)) throw invalidResponse()
    seen.add(competitor.id)
    return {
      competitor,
      latest: entry.latest === null ? null : parseAnalyticsSnapshot(entry.latest),
      trend7d: entry.trend7d === null ? null : parseAnalyticsTrend(entry.trend7d),
    }
  })
  return { label: record.label, items }
}

function parseCompetitorIdentity(value: unknown): { id: string; name: string } {
  const record = exactObject(value, ['id', 'name'])
  return { id: identifier(record.id), name: text(record.name, 300) }
}

function parseAnalyticsSnapshot(value: unknown): AnalyticsSnapshotMetrics {
  const requiredKeys = ['snapshotDate', 'capturedAt', 'activeAdCount', 'newAdsLast7d', 'launchVelocityDelta', 'avgDaysActive', 'longRunnerCount', 'formatMix', 'scaleScore', 'newlyTracked']
  const source = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const record = exactObject(value, [...requiredKeys, ...(Object.hasOwn(source, 'impressionWeight') ? ['impressionWeight'] : [])])
  const mix = exactObject(record.formatMix, ['image', 'video', 'carousel', 'text'])
  if (typeof record.newlyTracked !== 'boolean') throw invalidResponse()
  const result: AnalyticsSnapshotMetrics = {
    snapshotDate: snapshotDate(record.snapshotDate), capturedAt: timestamp(record.capturedAt),
    activeAdCount: nonNegativeInteger(record.activeAdCount), newAdsLast7d: nonNegativeInteger(record.newAdsLast7d),
    launchVelocityDelta: integer(record.launchVelocityDelta), avgDaysActive: nonNegativeNumber(record.avgDaysActive),
    longRunnerCount: nonNegativeInteger(record.longRunnerCount),
    formatMix: { image: nonNegativeInteger(mix.image), video: nonNegativeInteger(mix.video), carousel: nonNegativeInteger(mix.carousel), text: nonNegativeInteger(mix.text) },
    scaleScore: boundedInteger(record.scaleScore, 0, 100), newlyTracked: record.newlyTracked,
  }
  if (Object.hasOwn(record, 'impressionWeight')) result.impressionWeight = nonNegativeNumber(record.impressionWeight)
  return result
}

function parseAnalyticsTrend(value: unknown): AnalyticsTrend7d {
  const record = exactObject(value, ['activeAdCountChange', 'activeAdCountChangePercent', 'scaleScoreChange', 'direction'])
  const scaleScoreChange = boundedInteger(record.scaleScoreChange, -100, 100)
  const direction = enumText(record.direction, ['up', 'down', 'flat'] as const)
  return {
    activeAdCountChange: integer(record.activeAdCountChange),
    activeAdCountChangePercent: record.activeAdCountChangePercent === null ? null : integer(record.activeAdCountChangePercent),
    scaleScoreChange, direction,
  }
}

function snapshotDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw invalidResponse()
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw invalidResponse()
  return value
}

function parseScalingAnalytics(value: unknown): ScalingAnalytics {
  const record = exactObject(value, ['label', 'generatedAt', 'items'])
  if (!Array.isArray(record.items) || record.items.length > 10_000) throw invalidResponse()
  return { label: text(record.label, 200), generatedAt: timestamp(record.generatedAt), items: record.items.map(parseScalingAnalyticsItem) }
}

function parseScalingAnalyticsItem(value: unknown): ScalingAnalytics['items'][number] {
  const requiredKeys = ['competitorId', 'competitorName', 'activeAdCount', 'newAdsLast7d', 'newAdsPrev7d', 'launchVelocityDelta', 'avgDaysActive', 'longRunnerCount', 'formatMix', 'scaleScore', 'newlyTracked']
  const source = value as Record<string, unknown>
  const keys = typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(source, 'impressionWeight')
    ? [...requiredKeys, 'impressionWeight'] : requiredKeys
  const record = exactObject(value, keys)
  const mix = exactObject(record.formatMix, ['image', 'video', 'carousel', 'text'])
  if (typeof record.newlyTracked !== 'boolean') throw invalidResponse()
  const result: ScalingAnalytics['items'][number] = {
    competitorId: identifier(record.competitorId), competitorName: text(record.competitorName, 300),
    activeAdCount: nonNegativeInteger(record.activeAdCount), newAdsLast7d: nonNegativeInteger(record.newAdsLast7d),
    newAdsPrev7d: nonNegativeInteger(record.newAdsPrev7d), launchVelocityDelta: integer(record.launchVelocityDelta),
    avgDaysActive: nonNegativeNumber(record.avgDaysActive), longRunnerCount: nonNegativeInteger(record.longRunnerCount),
    formatMix: { image: nonNegativeInteger(mix.image), video: nonNegativeInteger(mix.video), carousel: nonNegativeInteger(mix.carousel), text: nonNegativeInteger(mix.text) },
    scaleScore: boundedInteger(record.scaleScore, 0, 100), newlyTracked: record.newlyTracked,
  }
  if (Object.hasOwn(record, 'impressionWeight')) result.impressionWeight = nonNegativeNumber(record.impressionWeight)
  return result
}

function parseCreativeStrategy(value: unknown): CreativeStrategySummary {
  const record = exactObject(value, ['organizationId', 'productId', 'competitorId', 'totalAds', 'analyzedAds', 'dimensions'])
  const totalAds = nonNegativeInteger(record.totalAds)
  const analyzedAds = nonNegativeInteger(record.analyzedAds)
  if (analyzedAds > totalAds) throw invalidResponse()
  const dimensions = exactObject(record.dimensions, ['hooks', 'angles', 'formats', 'emotions', 'personas', 'offers', 'funnelStages'])
  const parseDimension = (input: unknown): CreativeStrategySummary['dimensions']['hooks'] => {
    if (!Array.isArray(input) || input.length > 5) throw invalidResponse()
    const seen = new Set<string>()
    return input.map((item) => {
      const frequency = exactObject(item, ['value', 'count', 'percentage'])
      const result = { value: text(frequency.value, 120), count: boundedInteger(frequency.count, 1, analyzedAds), percentage: boundedInteger(frequency.percentage, 0, 100) }
      if (seen.has(result.value)) throw invalidResponse()
      seen.add(result.value)
      return result
    })
  }
  return {
    organizationId: identifier(record.organizationId), productId: identifier(record.productId), competitorId: identifier(record.competitorId),
    totalAds, analyzedAds,
    dimensions: {
      hooks: parseDimension(dimensions.hooks), angles: parseDimension(dimensions.angles), formats: parseDimension(dimensions.formats),
      emotions: parseDimension(dimensions.emotions), personas: parseDimension(dimensions.personas), offers: parseDimension(dimensions.offers),
      funnelStages: parseDimension(dimensions.funnelStages),
    },
  }
}

function parseCreativeAnalysis(value: unknown): CreativeAnalysis {
  const record = exactObject(value, ['organizationId', 'productId', 'competitorAdId', 'analysisVersion', 'modelProvider', 'modelName', 'promptVersion', 'inputFingerprint', 'tags', 'analyzedAt', 'provenance', 'analysisMode', 'mediaCount'])
  if (typeof record.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.inputFingerprint)) throw invalidResponse()
  return {
    organizationId: identifier(record.organizationId), productId: identifier(record.productId), competitorAdId: identifier(record.competitorAdId),
    analysisVersion: text(record.analysisVersion, 128), modelProvider: text(record.modelProvider, 64), modelName: text(record.modelName, 200),
    promptVersion: text(record.promptVersion, 128), inputFingerprint: record.inputFingerprint, tags: parseCreativeAnalysisTags(record.tags),
    analyzedAt: timestamp(record.analyzedAt),
    provenance: enumText(record.provenance, ['manual', 'automatic'] as const),
    analysisMode: enumText(record.analysisMode, ['media', 'copy_only'] as const),
    mediaCount: boundedInteger(record.mediaCount, 0, 16),
  }
}

function parseCreativeAnalysisTags(value: unknown): CreativeAnalysis['tags'] {
  const requiredKeys = ['hookCategory', 'angle', 'emotion', 'persona', 'format', 'offerFrame', 'cta', 'visualSummary', 'funnelStage', 'confidence']
  const optionalKeys = ['onScreenText']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  const source = value as Record<string, unknown>
  const record = exactObject(value, [...requiredKeys, ...optionalKeys.filter((key) => Object.hasOwn(source, key))])
  const result: CreativeAnalysis['tags'] = {
    hookCategory: enumText(record.hookCategory, ['pain_point', 'results', 'pattern_interrupt', 'pov_hook', 'listicle_hook', 'curiosity', 'data', 'social_proof'] as const),
    angle: enumText(record.angle, ['emotional', 'rational', 'identity', 'urgency', 'authority'] as const), emotion: text(record.emotion, 40),
    persona: text(record.persona, 120), format: enumText(record.format, ['ugc', 'asmr', 'podcast', 'pov', 'review', 'teaser', 'stream', 'tutorial', 'documentary', 'news_story', 'meme', 'action', 'drama', 'cartoon'] as const),
    offerFrame: enumText(record.offerFrame, ['discount', 'demo', 'free_tool', 'bundle', 'guarantee', 'social_proof', 'none'] as const), cta: text(record.cta, 120),
    visualSummary: text(record.visualSummary, 600), funnelStage: funnelStage(record.funnelStage), confidence: confidence(record.confidence),
  }
  if (Object.hasOwn(record, 'onScreenText')) result.onScreenText = text(record.onScreenText, 600)
  return result
}

function funnelStage(value: unknown): 'awareness' | 'consideration' | 'conversion' | 'retention' {
  if (value !== 'awareness' && value !== 'consideration' && value !== 'conversion' && value !== 'retention') throw invalidResponse()
  return value
}

function reviewIdentityQuery(analysisVersion: string, inputFingerprint: string): string {
  const version = required(analysisVersion, 'Analysis version')
  if ([...version].length > 128 || !/^[a-f0-9]{64}$/u.test(inputFingerprint)) throw new ApiError(0, 'Analysis identity is invalid')
  return new URLSearchParams({ analysisVersion: version, inputFingerprint }).toString()
}

function parseCreativeTagReviewItems(value: unknown): CreativeTagReviewItem[] {
  const record = exactObject(value, ['items'])
  if (!Array.isArray(record.items) || record.items.length > 100) throw invalidResponse()
  return record.items.map(parseCreativeTagReviewItem)
}
function parseCreativeTagReviewHistory(value: unknown): CreativeTagReview[] {
  const record = exactObject(value, ['items'])
  if (!Array.isArray(record.items) || record.items.length > 100) throw invalidResponse()
  return record.items.map(parseCreativeTagReview)
}
function parseCreativeTagReviewItem(value: unknown): CreativeTagReviewItem {
  const record = exactObject(value, ['advertiserName', 'analysis', 'status', 'review', 'originalTags', 'effectiveTags', 'stale'])
  const analysis = parseCreativeAnalysis(record.analysis)
  const status = enumText(record.status, ['pending', 'approved', 'rejected', 'corrected'] as const)
  const review = record.review === null ? null : parseCreativeTagReview(record.review)
  const originalTags = parseCreativeAnalysisTags(record.originalTags)
  const effectiveTags = record.effectiveTags === null ? null : parseCreativeAnalysisTags(record.effectiveTags)
  if (typeof record.stale !== 'boolean') throw invalidResponse()
  if (JSON.stringify(originalTags) !== JSON.stringify(analysis.tags)
    || status !== (review?.decision ?? 'pending')
    || (review !== null && (review.analysisVersion !== analysis.analysisVersion || review.inputFingerprint !== analysis.inputFingerprint))
    || (status === 'rejected' ? effectiveTags !== null : effectiveTags === null)) throw invalidResponse()
  const expected = review?.decision === 'corrected' ? { ...originalTags, ...review.corrections } : originalTags
  if (effectiveTags !== null && JSON.stringify(effectiveTags) !== JSON.stringify(expected)) throw invalidResponse()
  return { advertiserName: text(record.advertiserName, 500), analysis, status, review, originalTags, effectiveTags, stale: record.stale }
}
function parseCreativeTagReview(value: unknown): CreativeTagReview {
  const record = exactObject(value, ['organizationId', 'productId', 'competitorAdId', 'analysisVersion', 'inputFingerprint', 'reviewVersion', 'decision', 'corrections', 'reason', 'reviewerUserId', 'reviewedAt'])
  if (typeof record.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.inputFingerprint)) throw invalidResponse()
  const decision = enumText(record.decision, ['approved', 'rejected', 'corrected'] as const)
  const corrections = record.corrections === null ? null : parseCreativeTagCorrections(record.corrections)
  if ((decision === 'corrected') !== (corrections !== null)) throw invalidResponse()
  return { organizationId: identifier(record.organizationId), productId: identifier(record.productId), competitorAdId: identifier(record.competitorAdId), analysisVersion: text(record.analysisVersion, 128), inputFingerprint: record.inputFingerprint, reviewVersion: boundedInteger(record.reviewVersion, 1, Number.MAX_SAFE_INTEGER), decision, corrections, reason: text(record.reason, 1_000), reviewerUserId: identifier(record.reviewerUserId), reviewedAt: timestamp(record.reviewedAt) }
}
function parseCreativeTagCorrections(value: unknown): CreativeTagCorrections {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  const source = value as Record<string, unknown>; const allowed = ['hookCategory', 'angle', 'format', 'offerFrame', 'funnelStage']
  const keys = Object.keys(source); if (keys.length < 1 || keys.length > 5 || keys.some((key) => !allowed.includes(key))) throw invalidResponse()
  const result: CreativeTagCorrections = {}
  if (source.hookCategory !== undefined) result.hookCategory = enumText(source.hookCategory, ['pain_point', 'results', 'pattern_interrupt', 'pov_hook', 'listicle_hook', 'curiosity', 'data', 'social_proof'] as const)
  if (source.angle !== undefined) result.angle = enumText(source.angle, ['emotional', 'rational', 'identity', 'urgency', 'authority'] as const)
  if (source.format !== undefined) result.format = enumText(source.format, ['ugc', 'asmr', 'podcast', 'pov', 'review', 'teaser', 'stream', 'tutorial', 'documentary', 'news_story', 'meme', 'action', 'drama', 'cartoon'] as const)
  if (source.offerFrame !== undefined) result.offerFrame = enumText(source.offerFrame, ['discount', 'demo', 'free_tool', 'bundle', 'guarantee', 'social_proof', 'none'] as const)
  if (source.funnelStage !== undefined) result.funnelStage = funnelStage(source.funnelStage)
  return result
}
function confidence(value: unknown): number {
  const parsed = nonNegativeNumber(value)
  if (parsed > 1) throw invalidResponse()
  return parsed
}


function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidResponse()
  const record = value as Record<string, unknown>
  const actual = Object.keys(record)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw invalidResponse()
  return record
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidResponse()
  return value
}

function integer(value: unknown): number {
  const result = finiteNumber(value)
  if (!Number.isSafeInteger(result)) throw invalidResponse()
  return result
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  const result = integer(value)
  if (result < minimum || result > maximum) throw invalidResponse()
  return result
}

function enumText<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalidResponse()
  return value as T[number]
}

function nonNegativeNumber(value: unknown): number {
  const result = finiteNumber(value)
  if (result < 0) throw invalidResponse()
  return result
}

function nonNegativeInteger(value: unknown): number {
  const result = nonNegativeNumber(value)
  if (!Number.isSafeInteger(result)) throw invalidResponse()
  return result
}

function identifier(value: unknown): string {
  const result = text(value, 256)
  if (/^\s|\s$|[\u0000-\u001F\u007F-\u009F]/u.test(result)) throw invalidResponse()
  return result
}

function text(value: unknown, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || [...value].length > maxLength || (!allowEmpty && value.length === 0)) throw invalidResponse()
  if ((value.length > 0 && (/^\s|\s$/u.test(value))) || /[\u0000-\u001F\u007F-\u009F]/u.test(value)) throw invalidResponse()
  return value
}

function nullableText(value: unknown, maxLength: number): string | null { return value === null ? null : text(value, maxLength) }
function nullableNonNegativeNumber(value: unknown): number | null { return value === null ? null : nonNegativeNumber(value) }
function nullableCurrency(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[A-Z]{3}$/u.test(value)) throw invalidResponse()
  return value
}
function nullableAdType(value: unknown): 'image' | 'video' | 'carousel' | 'text' | null {
  if (value === null) return null
  if (value !== 'image' && value !== 'video' && value !== 'carousel' && value !== 'text') throw invalidResponse()
  return value
}
function parseNullableMedia(value: unknown): NonNullable<CompetitorAd['media']> | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length > 50) throw invalidResponse()
  return value.map((item, index) => {
    const mediaKeys = ['kind', 'sourceUrl', 'posterUrl', 'cardIndex', 'order']
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      if (Object.hasOwn(item, 'mirroredUrl')) mediaKeys.push('mirroredUrl')
      if (Object.hasOwn(item, 'mirroredPosterUrl')) mediaKeys.push('mirroredPosterUrl')
    }
    const record = exactObject(item, mediaKeys)
    if (record.kind !== 'image' && record.kind !== 'video') throw invalidResponse()
    const cardIndex = record.cardIndex === null ? null : boundedInteger(record.cardIndex, 0, 49)
    const order = boundedInteger(record.order, 0, 49)
    if (order !== index) throw invalidResponse()
    return {
      kind: record.kind, sourceUrl: httpsUrl(record.sourceUrl),
      ...(Object.hasOwn(record, 'mirroredUrl') ? { mirroredUrl: mirroredReference(record.mirroredUrl) } : {}),
      posterUrl: record.posterUrl === null ? null : httpsUrl(record.posterUrl),
      ...(Object.hasOwn(record, 'mirroredPosterUrl') ? { mirroredPosterUrl: mirroredReference(record.mirroredPosterUrl) } : {}),
      cardIndex, order,
    }
  })
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === 'string')) throw invalidResponse()
  if (new Set(value).size !== value.length) throw invalidResponse()
  return value as string[]
}

function textArray(value: unknown, maxItems: number, maxLength: number): string[] { return stringArray(value, maxItems).map((item) => text(item, maxLength)) }
function urlArray(value: unknown, maxItems: number): string[] { return stringArray(value, maxItems).map(httpsUrl) }

function mirroredReference(value: unknown): string {
  if (typeof value !== 'string' || !/^\/media\/sha256\/[a-f0-9]{64}$/u.test(value)) throw invalidResponse()
  return value
}

function httpsUrl(value: unknown): string {
  if (!isBoundedString(value, 1, 2_048) || /[\u0000-\u0020\u007F-\u009F]/u.test(value)) throw invalidResponse()
  let parsed: URL
  try { parsed = new URL(value) } catch { throw invalidResponse() }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) throw invalidResponse()
  return value
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw invalidResponse()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw invalidResponse()
  return value
}

function nullableTimestamp(value: unknown): string | null { return value === null ? null : timestamp(value) }
function isBoundedString(value: unknown, minimum: number, maximum: number): value is string { return typeof value === 'string' && [...value].length >= minimum && [...value].length <= maximum }
function isLoopbackHost(hostname: string): boolean { return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' }

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new ApiError(0, `${label} is required`)
  return normalized
}

function segment(value: string): string {
  const result = required(value, 'Resource ID')
  if ([...result].length > 256 || /[\u0000-\u001F\u007F-\u009F]/u.test(result)) throw new ApiError(0, 'Resource ID is invalid')
  return encodeURIComponent(result)
}

function publicError(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error
    if (typeof error === 'string' && error.length > 0 && error.length <= 500) return error
  }
  return 'Request failed'
}

function invalidResponse(status = 502): ApiError { return new ApiError(status, 'The API returned an invalid response') }

import type {
  BriefDimensions,
  BriefUpdateDraft,
  Competitor,
  CompetitorAd,
  CompetitorDraft,
  CreativeAnalysis,
  CreativeBrief,
  CreativeBriefVersion,
  IterationAxes,
  IterationCell,
  IterationMap,
  ManualBriefDraft,
  Page,
  Platform,
  Product,
  ProductDraft,
  ScalingAnalytics,
} from './types.ts'

export interface ApiConnection {
  apiBaseUrl: string
  accessToken: string
  organizationId: string
}

export interface AdFilters {
  productId?: string
  competitorId?: string
  isActive?: boolean
  provider?: string
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
  listCompetitors(productId: string): Promise<Page<Competitor>>
  createCompetitor(productId: string, draft: CompetitorDraft): Promise<Competitor>
  syncApifyMetaAds(productId: string, competitorId: string): Promise<{ inserted: number; duplicates: number }>
  listAds(filters?: AdFilters): Promise<Page<CompetitorAd>>
  listBriefs(productId: string): Promise<Page<CreativeBrief>>
  createManualBrief(productId: string, draft: ManualBriefDraft): Promise<CreativeBrief>
  createBriefFromAd(productId: string, input: { adId: string; title: string; dimensions: BriefDimensions }): Promise<CreativeBrief>
  updateBrief(briefId: string, input: BriefUpdateDraft): Promise<CreativeBrief>
  listBriefVersions(briefId: string): Promise<CreativeBriefVersion[]>
  analyzeIterationMap(productId: string, axes: IterationAxes): Promise<IterationMap>
  getScalingAnalytics(productId: string): Promise<ScalingAnalytics>
  analyzeCreative(productId: string, adId: string): Promise<CreativeAnalysis>
}

const PAGE_LIMIT = 100
const MAX_PAGES = 100

export function createApiClient(connection: ApiConnection): CreativeIntelligenceApi {
  const baseUrl = normalizeApiBaseUrl(connection.apiBaseUrl)
  const accessToken = required(connection.accessToken, 'Access token')
  const organizationId = required(connection.organizationId, 'Organization ID')
  const organizationPath = `/organizations/${encodeURIComponent(organizationId)}`

  const request = async <T>(method: 'GET' | 'POST' | 'PATCH', path: string, parse: (value: unknown) => T, body?: unknown): Promise<T> => {
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
    listProducts: () => requestAll(`${organizationPath}/products?limit=${PAGE_LIMIT}`, parseProduct),
    createProduct: (draft) => request('POST', `${organizationPath}/products`, parseProduct, draft),
    listCompetitors: (productId) => requestAll(`${organizationPath}/products/${segment(productId)}/competitors?limit=${PAGE_LIMIT}`, parseCompetitor),
    createCompetitor: (productId, draft) => request('POST', `${organizationPath}/products/${segment(productId)}/competitors`, parseCompetitor, draft),
    syncApifyMetaAds: (productId, competitorId) => request('POST', `${organizationPath}/products/${segment(productId)}/competitors/${segment(competitorId)}/ads/apify-meta/sync`, parseImportResult),
    listAds: (filters = {}) => {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
      if (filters.productId) query.set('productId', filters.productId)
      if (filters.competitorId) query.set('competitorId', filters.competitorId)
      if (filters.isActive !== undefined) query.set('isActive', String(filters.isActive))
      if (filters.provider) query.set('provider', filters.provider)
      return requestAll(`${organizationPath}/ads?${query.toString()}`, parseAd)
    },
    listBriefs: (productId) => requestAll(`${organizationPath}/products/${segment(productId)}/briefs?limit=${PAGE_LIMIT}`, parseBrief),
    createManualBrief: (productId, draft) => request('POST', `${organizationPath}/products/${segment(productId)}/briefs`, parseBrief, draft),
    createBriefFromAd: (productId, input) => request('POST', `${organizationPath}/products/${segment(productId)}/briefs/from-ad`, parseBrief, input),
    updateBrief: (briefId, input) => request('PATCH', `${organizationPath}/briefs/${segment(briefId)}`, parseBrief, input),
    listBriefVersions: (briefId) => request('GET', `${organizationPath}/briefs/${segment(briefId)}/versions?limit=${PAGE_LIMIT}`, parseBriefVersions),
    analyzeIterationMap: (productId, axes) => request('POST', `${organizationPath}/products/${segment(productId)}/iteration-map/analyze`, parseIterationMap, { axes }),
    getScalingAnalytics: (productId) => request('GET', `${organizationPath}/products/${segment(productId)}/analytics/scaling`, parseScalingAnalytics),
    analyzeCreative: (productId, adId) => request('POST', `${organizationPath}/products/${segment(productId)}/ads/${segment(adId)}/creative-analysis`, parseCreativeAnalysis),
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
  const record = exactObject(value, [
    'id', 'organizationId', 'productId', 'competitorId', 'providerName', 'platform', 'externalId', 'pageId', 'advertiserName', 'body',
    'headline', 'description', 'callToAction', 'displayFormat', 'adType', 'startedAt', 'endedAt', 'isActive', 'publisherPlatforms',
    'impressionsLowerBound', 'impressionsUpperBound', 'spendLowerBound', 'spendUpperBound', 'currency', 'media',
    'mediaUrls', 'sourceUrl', 'firstSeenAt', 'lastSeenAt',
  ])
  if (record.platform !== 'meta' || typeof record.isActive !== 'boolean') throw invalidResponse()
  const providerName = text(record.providerName, 64)
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerName)) throw invalidResponse()
  return {
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
}

function parseImportResult(value: unknown): { inserted: number; duplicates: number } {
  const record = exactObject(value, ['inserted', 'duplicates'])
  if (!Number.isSafeInteger(record.inserted) || (record.inserted as number) < 0 || !Number.isSafeInteger(record.duplicates) || (record.duplicates as number) < 0) throw invalidResponse()
  return { inserted: record.inserted as number, duplicates: record.duplicates as number }
}

function parseBrief(value: unknown): CreativeBrief {
  const record = exactObject(value, ['id', 'organizationId', 'productId', 'title', 'status', 'sourceAdId', 'hook', 'callToAction', 'dimensions', 'version', 'createdAt', 'updatedAt'])
  const statuses = ['draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived'] as const
  if (!statuses.includes(record.status as typeof statuses[number])) throw invalidResponse()
  const version = integer(record.version)
  if (version < 1) throw invalidResponse()
  return {
    id: identifier(record.id), organizationId: identifier(record.organizationId), productId: identifier(record.productId), title: text(record.title, 500),
    status: record.status as CreativeBrief['status'], sourceAdId: record.sourceAdId === null ? null : identifier(record.sourceAdId),
    hook: text(record.hook, 20_000, true), callToAction: nullableText(record.callToAction, 100), dimensions: parseDimensions(record.dimensions),
    version, createdAt: timestamp(record.createdAt), updatedAt: timestamp(record.updatedAt),
  }
}

function parseBriefVersions(value: unknown): CreativeBriefVersion[] {
  const record = exactObject(value, ['items'])
  if (!Array.isArray(record.items) || record.items.length > 100) throw invalidResponse()
  return record.items.map((item) => {
    const version = exactObject(item, ['id', 'organizationId', 'productId', 'title', 'status', 'sourceAdId', 'hook', 'callToAction', 'dimensions', 'version', 'createdAt', 'updatedAt', 'changedBy', 'changedAt'])
    const brief = parseBrief(Object.fromEntries(Object.entries(version).filter(([key]) => key !== 'changedBy' && key !== 'changedAt')))
    return { ...brief, changedBy: identifier(version.changedBy), changedAt: timestamp(version.changedAt) }
  })
}

function parseDimensions(value: unknown): BriefDimensions {
  const record = exactObject(value, ['audience', 'market', 'angle', 'format'])
  return { audience: text(record.audience, 100), market: text(record.market, 100), angle: text(record.angle, 100), format: text(record.format, 100) }
}

function parseIterationCell(value: unknown): IterationCell {
  const record = exactObject(value, ['dimensions', 'briefIds'])
  if (!Array.isArray(record.briefIds) || record.briefIds.length > 10_000) throw invalidResponse()
  return { dimensions: parseDimensions(record.dimensions), briefIds: record.briefIds.map(identifier) }
}

function parseIterationMap(value: unknown): IterationMap {
  const record = exactObject(value, ['totalCombinations', 'covered', 'missing'])
  if (!Number.isInteger(record.totalCombinations) || (record.totalCombinations as number) < 1 || (record.totalCombinations as number) > 10_000) throw invalidResponse()
  if (!Array.isArray(record.covered) || record.covered.length > 10_000 || !Array.isArray(record.missing) || record.missing.length > 10_000) throw invalidResponse()
  return { totalCombinations: record.totalCombinations as number, covered: record.covered.map(parseIterationCell), missing: record.missing.map(parseIterationCell) }
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

function parseCreativeAnalysis(value: unknown): CreativeAnalysis {
  const record = exactObject(value, ['organizationId', 'productId', 'competitorAdId', 'analysisVersion', 'modelProvider', 'modelName', 'promptVersion', 'inputFingerprint', 'tags', 'analyzedAt'])
  if (typeof record.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.inputFingerprint)) throw invalidResponse()
  return {
    organizationId: identifier(record.organizationId), productId: identifier(record.productId), competitorAdId: identifier(record.competitorAdId),
    analysisVersion: text(record.analysisVersion, 128), modelProvider: text(record.modelProvider, 64), modelName: text(record.modelName, 200),
    promptVersion: text(record.promptVersion, 128), inputFingerprint: record.inputFingerprint, tags: parseCreativeAnalysisTags(record.tags),
    analyzedAt: timestamp(record.analyzedAt),
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
    const record = exactObject(item, ['kind', 'sourceUrl', 'posterUrl', 'cardIndex', 'order'])
    if (record.kind !== 'image' && record.kind !== 'video') throw invalidResponse()
    const cardIndex = record.cardIndex === null ? null : boundedInteger(record.cardIndex, 0, 49)
    const order = boundedInteger(record.order, 0, 49)
    if (order !== index) throw invalidResponse()
    return { kind: record.kind, sourceUrl: httpsUrl(record.sourceUrl), posterUrl: record.posterUrl === null ? null : httpsUrl(record.posterUrl), cardIndex, order }
  })
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => typeof item === 'string')) throw invalidResponse()
  if (new Set(value).size !== value.length) throw invalidResponse()
  return value as string[]
}

function textArray(value: unknown, maxItems: number, maxLength: number): string[] { return stringArray(value, maxItems).map((item) => text(item, maxLength)) }
function urlArray(value: unknown, maxItems: number): string[] { return stringArray(value, maxItems).map(httpsUrl) }

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

function segment(value: string): string { return encodeURIComponent(required(value, 'Resource ID')) }

function publicError(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const error = (payload as Record<string, unknown>).error
    if (typeof error === 'string' && error.length > 0 && error.length <= 500) return error
  }
  return 'Request failed'
}

function invalidResponse(status = 502): ApiError { return new ApiError(status, 'The API returned an invalid response') }

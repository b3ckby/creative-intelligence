import { randomUUID } from 'node:crypto'

import { AdLibraryService, type AdRepository } from './ads/ad-library-service.ts'
import type { AdSourceProvider } from './ad-ingestion/ad-source-provider.ts'
import { BriefService, type BriefRepository } from './briefs/brief-service.ts'
import { CompetitorService, type CompetitorRepository } from './competitors/competitor-service.ts'
import type { Competitor, CompetitorAd, CreativeBrief, Product } from './domain/types.ts'
import { validatePageLimit } from './domain/page-limit.ts'
import { ProductService, type ProductRepository } from './products/product-service.ts'
import { ITERATION_MAP_OVERFLOW_PROBE_LIMIT, IterationMapService } from './iteration-map/iteration-map-service.ts'

class InMemoryProductRepository implements ProductRepository {
  private readonly items = new Map<string, Product>()
  save(product: Product): void {
    if (this.items.has(product.id)) throw new Error('Product ID collision')
    this.items.set(product.id, structuredClone(product))
  }
  findById(id: string): Product | undefined { const item = this.items.get(id); return item && structuredClone(item) }
}

class InMemoryCompetitorRepository implements CompetitorRepository {
  private readonly items = new Map<string, Competitor>()
  save(competitor: Competitor): void {
    if (this.items.has(competitor.id)) throw new Error('Competitor ID collision')
    this.items.set(competitor.id, structuredClone(competitor))
  }
  findById(id: string): Competitor | undefined { const item = this.items.get(id); return item && structuredClone(item) }
}

export class InMemoryAdRepository implements AdRepository {
  private items = new Map<string, CompetitorAd>()

  saveBatch(ads: readonly CompetitorAd[]): void {
    const next = new Map(this.items)
    const batchIds = new Set<string>()
    const batchKeys: CompetitorAd[] = []

    for (const ad of ads) {
      if (batchIds.has(ad.id)) throw new Error('Duplicate ad record ID in batch')
      batchIds.add(ad.id)
      const currentById = next.get(ad.id)
      if (currentById && !sameProviderKey(currentById, ad)) {
        throw new Error('Ad record ID collision')
      }
      if (batchKeys.some((item) => sameProviderKey(item, ad))) throw new Error('Duplicate provider ad key in batch')
      batchKeys.push(ad)
      const currentByKey = [...next.values()].find((item) => sameProviderKey(item, ad))
      if (currentByKey && currentByKey.id !== ad.id) throw new Error('Provider ad key collision')
      next.set(ad.id, structuredClone(ad))
    }

    this.items = next
  }
  findByProviderKey(organizationId: string, providerName: string, platform: string, externalId: string): CompetitorAd | undefined {
    const item = [...this.items.values()].find((ad) =>
      ad.organizationId === organizationId
      && ad.providerName === providerName
      && ad.platform === platform
      && ad.externalId === externalId,
    )
    return item && structuredClone(item)
  }
  listForCompetitor(organizationId: string, competitorId: string, limitInput: number): CompetitorAd[] {
    const limit = validatePageLimit(limitInput)
    const result: CompetitorAd[] = []
    for (const ad of this.items.values()) {
      if (ad.organizationId !== organizationId || ad.competitorId !== competitorId) continue
      result.push(structuredClone(ad))
      if (result.length === limit) break
    }
    return result
  }
  findById(organizationId: string, id: string): CompetitorAd | undefined {
    const item = this.items.get(id)
    return item?.organizationId === organizationId ? structuredClone(item) : undefined
  }
}

function sameProviderKey(left: CompetitorAd, right: CompetitorAd): boolean {
  return left.organizationId === right.organizationId
    && left.providerName === right.providerName
    && left.platform === right.platform
    && left.externalId === right.externalId
}

export class InMemoryBriefRepository implements BriefRepository {
  private readonly items = new Map<string, CreativeBrief>()
  save(brief: CreativeBrief): void {
    if (this.items.has(brief.id)) throw new Error('Brief ID collision')
    this.items.set(brief.id, structuredClone(brief))
  }
  listForProduct(organizationId: string, productId: string, limitInput: number): CreativeBrief[] {
    const limit = validatePageLimit(limitInput)
    return collectBriefsBounded(this.items.values(), organizationId, productId, limit, false)
  }
  listActiveForIterationMapOverflowProbe(organizationId: string, productId: string): CreativeBrief[] {
    return collectBriefsBounded(this.items.values(), organizationId, productId, ITERATION_MAP_OVERFLOW_PROBE_LIMIT, true)
  }
}

function collectBriefsBounded(
  source: Iterable<CreativeBrief>,
  organizationId: string,
  productId: string,
  limit: number,
  activeOnly: boolean,
): CreativeBrief[] {
  const result: CreativeBrief[] = []
  const compare = (left: CreativeBrief, right: CreativeBrief) =>
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  for (const brief of source) {
    if (brief.organizationId !== organizationId || brief.productId !== productId || (activeOnly && brief.status === 'archived')) continue
    const insertionIndex = result.findIndex((item) => compare(brief, item) < 0)
    if (insertionIndex === -1) result.push(brief)
    else result.splice(insertionIndex, 0, brief)
    if (result.length > limit) result.pop()
  }
  return result.map((brief) => structuredClone(brief))
}

export class CreativeIntelligence {
  private constructor(
    readonly products: ProductService,
    readonly competitors: CompetitorService,
    readonly ads: AdLibraryService,
    readonly briefs: BriefService,
    readonly iterationMap: IterationMapService,
  ) {}

  static inMemory(options: {
    now?: () => Date
    createId?: () => string
    providers?: ReadonlyMap<string, AdSourceProvider>
  } = {}): CreativeIntelligence {
    const now = options.now ?? (() => new Date())
    const createId = options.createId ?? randomUUID
    const products = new InMemoryProductRepository()
    const competitors = new InMemoryCompetitorRepository()
    const ads = new InMemoryAdRepository()
    const briefs = new InMemoryBriefRepository()

    const productService = new ProductService(products, now, createId)
    const competitorService = new CompetitorService(competitors, products, now, createId)
    const providerRegistry = new Map(options.providers ?? [])
    const adService = new AdLibraryService(ads, products, competitors, now, createId, providerRegistry)
    const briefService = new BriefService(briefs, products, adService, now, createId)
    const iterationMapService = new IterationMapService(products, briefService)

    return new CreativeIntelligence(productService, competitorService, adService, briefService, iterationMapService)
  }
}

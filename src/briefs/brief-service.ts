import type { BriefDimensions, CompetitorAd, CreativeBrief, Product } from '../domain/types.ts'
import { ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { validatePageLimit } from '../domain/page-limit.ts'
import { normalizeCanonicalText, validateCanonicalText } from '../domain/validation.ts'
import type { IterationMapBriefOverflowProbe } from '../iteration-map/iteration-map-service.ts'
import { normalizeBriefDimensions } from './brief-dimensions.ts'

export interface CreateBriefFromAdInput {
  organizationId: string
  productId: string
  adId: string
  title: string
  dimensions: BriefDimensions
}

export interface CreateManualBriefInput {
  organizationId: string
  productId: string
  title: string
  hook: string
  callToAction?: string
  dimensions: BriefDimensions
}

export interface BriefRepository extends IterationMapBriefOverflowProbe {
  save(brief: CreativeBrief): void
  listForProduct(organizationId: string, productId: string, limit: number): CreativeBrief[]
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('Brief payload is invalid')
  return value as Record<string, unknown>
}

function normalizeBriefTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError('Brief title is required')
  if (value.trim().length > 500) throw new ValidationError('Brief title is too long')
  return normalizeCanonicalText(value, 'Brief title', { maxLength: 500 })
}

function normalizeBriefHook(value: unknown): string {
  return normalizeCanonicalText(value, 'Brief hook', { maxLength: 20_000, allowEmpty: true })
}

function normalizeBriefCallToAction(value: unknown): string {
  return normalizeCanonicalText(value, 'Brief call to action', { maxLength: 100 })
}

export function normalizeManualBriefInput(input: unknown): CreateManualBriefInput {
  const record = inputRecord(input)
  const callToAction = record.callToAction === undefined
    ? undefined
    : normalizeBriefCallToAction(record.callToAction)
  return {
    organizationId: validateIdentifier(record.organizationId, 'Organization ID'),
    productId: validateIdentifier(record.productId, 'Product ID'),
    title: normalizeBriefTitle(record.title),
    hook: normalizeBriefHook(record.hook),
    ...(callToAction === undefined ? {} : { callToAction }),
    dimensions: normalizeBriefDimensions(record.dimensions as BriefDimensions),
  }
}

export function normalizeBriefFromAdInput(input: unknown): CreateBriefFromAdInput {
  const record = inputRecord(input)
  return {
    organizationId: validateIdentifier(record.organizationId, 'Organization ID'),
    productId: validateIdentifier(record.productId, 'Product ID'),
    adId: validateIdentifier(record.adId, 'Ad ID'),
    title: normalizeBriefTitle(record.title),
    dimensions: normalizeBriefDimensions(record.dimensions as BriefDimensions),
  }
}

export function buildBriefFromAd(
  input: CreateBriefFromAdInput,
  product: Product,
  ad: CompetitorAd,
  createdAt: Date,
  id: string,
): CreativeBrief {
  return {
    id: validateIdentifier(id, 'Generated ID'),
    organizationId: input.organizationId,
    productId: product.id,
    title: input.title,
    status: 'draft',
    sourceAdId: ad.id,
    hook: validateCanonicalText(ad.body, 'Brief hook', { maxLength: 20_000, allowEmpty: true }),
    callToAction: ad.callToAction === null
      ? null
      : validateCanonicalText(ad.callToAction, 'Brief call to action', { maxLength: 100 }),
    dimensions: input.dimensions,
    createdAt: createdAt.toISOString(),
  }
}

export function buildManualBrief(
  input: CreateManualBriefInput,
  product: Product,
  createdAt: Date,
  id: string,
): CreativeBrief {
  return {
    id: validateIdentifier(id, 'Generated ID'),
    organizationId: input.organizationId,
    productId: product.id,
    title: input.title,
    status: 'draft',
    sourceAdId: null,
    hook: input.hook,
    callToAction: input.callToAction || null,
    dimensions: input.dimensions,
    createdAt: createdAt.toISOString(),
  }
}

interface ProductLookup {
  findById(id: string): Product | undefined
}

interface AdLookup {
  findById(organizationId: string, id: string): CompetitorAd | undefined
}

export class BriefService {
  constructor(
    private readonly repository: BriefRepository,
    private readonly products: ProductLookup,
    private readonly ads: AdLookup,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}

  createFromAd(input: CreateBriefFromAdInput): CreativeBrief {
    const normalized = normalizeBriefFromAdInput(input)
    const product = this.requireOwnedProduct(normalized.organizationId, normalized.productId)
    const ad = this.ads.findById(normalized.organizationId, normalized.adId)
    if (!ad || ad.organizationId !== normalized.organizationId || ad.productId !== product.id) {
      throw new ValidationError('Ad does not belong to product')
    }
    const brief = buildBriefFromAd(normalized, product, ad, this.now(), this.createId())
    this.repository.save(brief)
    return brief
  }

  createManual(input: CreateManualBriefInput): CreativeBrief {
    const normalized = normalizeManualBriefInput(input)
    const product = this.requireOwnedProduct(normalized.organizationId, normalized.productId)
    const brief = buildManualBrief(normalized, product, this.now(), this.createId())
    this.repository.save(brief)
    return brief
  }

  listForProduct(organizationIdInput: string, productIdInput: string, limitInput: number): CreativeBrief[] {
    const limit = validatePageLimit(limitInput)
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    const product = this.requireOwnedProduct(organizationId, productId)
    return this.repository.listForProduct(organizationId, product.id, limit)
  }

  listActiveForIterationMapOverflowProbe(organizationIdInput: string, productIdInput: string): CreativeBrief[] {
    const organizationId = validateIdentifier(organizationIdInput, 'Organization ID')
    const productId = validateIdentifier(productIdInput, 'Product ID')
    const product = this.requireOwnedProduct(organizationId, productId)
    return this.repository.listActiveForIterationMapOverflowProbe(organizationId, product.id)
  }

  private requireOwnedProduct(organizationId: string, productId: string): Product {
    const product = this.products.findById(productId)
    if (!product || product.organizationId !== organizationId) throw new ValidationError('Product does not belong to organization')
    return product
  }
}

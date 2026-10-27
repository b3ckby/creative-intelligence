import type { Competitor, Product } from '../domain/types.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { normalizeCanonicalText, validateCanonicalHttpsUrl } from '../domain/validation.ts'

export interface CreateCompetitorInput {
  organizationId: string
  productId: string
  name: string
  metaPageUrl?: string
}

export interface CompetitorRepository {
  save(competitor: Competitor): void
  findById(id: string): Competitor | undefined
}

export interface ProductLookup {
  findById(id: string): Product | undefined
}

export class CompetitorService {
  constructor(
    private readonly repository: CompetitorRepository,
    private readonly products: ProductLookup,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}

  create(input: CreateCompetitorInput): Competitor {
    const organizationId = validateIdentifier(input.organizationId, 'Organization ID')
    const productId = validateIdentifier(input.productId, 'Product ID')
    const product = this.products.findById(productId)
    if (!product || product.organizationId !== organizationId) {
      throw new Error('Product does not belong to organization')
    }
    const name = normalizeCanonicalText(input.name, 'Competitor name', { maxLength: 300 })
    const metaPageUrl = input.metaPageUrl === undefined
      ? null
      : validateCanonicalHttpsUrl(input.metaPageUrl, 'Competitor Meta page URL')

    const competitor: Competitor = {
      id: validateIdentifier(this.createId(), 'Generated ID'),
      organizationId,
      productId: product.id,
      name,
      metaPageUrl,
      archivedAt: null,
      createdAt: this.now().toISOString(),
    }
    this.repository.save(competitor)
    return competitor
  }
}

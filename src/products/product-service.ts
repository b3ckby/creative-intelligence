import { normalizeIdentifier, validateIdentifier } from '../domain/identifiers.ts'
import { normalizeCanonicalText, normalizeCanonicalTextArray } from '../domain/validation.ts'
import { ValidationError } from '../domain/errors.ts'

export interface CreateProductInput {
  organizationId: string
  name: string
  markets: string[]
  platforms: Array<'ios' | 'android' | 'web'>
  targetAudiences: string[]
  uniqueSellingPoints: string[]
}

export interface ProductRepository {
  save(product: import('../domain/types.ts').Product): void
  findById(id: string): import('../domain/types.ts').Product | undefined
}

export class ProductService {
  constructor(
    private readonly repository: ProductRepository,
    private readonly now: () => Date,
    private readonly createId: () => string,
  ) {}

  create(input: CreateProductInput): import('../domain/types.ts').Product {
    const name = normalizeCanonicalText(input.name, 'Product name', { maxLength: 300 })
    const organizationId = normalizeIdentifier(input.organizationId, 'Organization')
    const markets = normalizeCanonicalTextArray(input.markets, 'Product markets', { maxItems: 100, maxLength: 500 })
    const platformValues = normalizeCanonicalTextArray(input.platforms, 'Product platforms', { maxItems: 100, maxLength: 500 })
    if (platformValues.some((item) => item !== 'ios' && item !== 'android' && item !== 'web')) {
      throw new ValidationError('Product platforms are invalid')
    }
    const targetAudiences = normalizeCanonicalTextArray(input.targetAudiences, 'Product target audiences', { maxItems: 100, maxLength: 500 })
    const uniqueSellingPoints = normalizeCanonicalTextArray(input.uniqueSellingPoints, 'Product unique selling points', { maxItems: 100, maxLength: 500 })

    const product: import('../domain/types.ts').Product = {
      id: validateIdentifier(this.createId(), 'Generated ID'),
      organizationId,
      name,
      markets,
      platforms: platformValues as import('../domain/types.ts').Product['platforms'],
      targetAudiences,
      uniqueSellingPoints,
      archivedAt: null,
      createdAt: this.now().toISOString(),
    }
    this.repository.save(product)
    return product
  }
}

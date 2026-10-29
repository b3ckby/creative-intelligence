import type { BriefDimensions, CreativeBrief, Product } from '../domain/types.ts'
import { ValidationError } from '../domain/errors.ts'
import { validateIdentifier } from '../domain/identifiers.ts'
import { normalizeDimensionValue } from '../briefs/brief-dimensions.ts'

const MAX_AXIS_VALUES = 50
const MAX_COMBINATIONS = 10_000
export const MAX_ACTIVE_BRIEFS = 10_000
export const ITERATION_MAP_OVERFLOW_PROBE_LIMIT = MAX_ACTIVE_BRIEFS + 1
export const MAX_CELL_BRIEF_EVIDENCE = 25
const AXIS_NAMES = ['audience', 'market', 'angle', 'format'] as const

export interface IterationAxes {
  audience: string[]
  market: string[]
  angle: string[]
  format: string[]
}

export interface AnalyzeIterationMapInput {
  organizationId: string
  productId: string
  axes: IterationAxes
}

export interface IterationCell {
  dimensions: BriefDimensions
  briefIds: string[]
  briefs: Array<Pick<CreativeBrief, 'id' | 'title' | 'status'>>
  briefCount: number
  hasMoreBriefs: boolean
}

export interface IterationMapResult {
  totalCombinations: number
  covered: IterationCell[]
  missing: IterationCell[]
}

interface ProductLookup {
  findById(id: string): Product | undefined
}

export interface IterationMapBriefOverflowProbe {
  listActiveForIterationMapOverflowProbe(organizationId: string, productId: string): CreativeBrief[]
}

function keyOf(dimensions: BriefDimensions): string {
  return [dimensions.audience, dimensions.market, dimensions.angle, dimensions.format].join('\u0000')
}

function uniqueValues(values: unknown, axis: string): string[] {
  if (!Array.isArray(values)) throw new ValidationError(`Iteration axis ${axis} is invalid`)
  if (values.length > MAX_AXIS_VALUES) throw new ValidationError(`Iteration axis ${axis} has too many values`)
  const normalized = Array.from(values, (value) => normalizeDimensionValue(value, axis))
  const unique = [...new Set(normalized)]
  if (unique.length === 0) throw new ValidationError(`Iteration axis ${axis} must have at least one value`)
  return unique
}

export function normalizeIterationAxes(axes: unknown): IterationAxes {
  if (typeof axes !== 'object' || axes === null || Array.isArray(axes)) {
    throw new ValidationError('Iteration axes are invalid')
  }
  const record = axes as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== AXIS_NAMES.length || keys.some((key) => !AXIS_NAMES.includes(key as typeof AXIS_NAMES[number]))) {
    throw new ValidationError('Iteration axes are invalid')
  }
  const normalized = {
    audience: uniqueValues(record.audience, 'audience'),
    market: uniqueValues(record.market, 'market'),
    angle: uniqueValues(record.angle, 'angle'),
    format: uniqueValues(record.format, 'format'),
  }
  const totalCombinations = normalized.audience.length * normalized.market.length * normalized.angle.length * normalized.format.length
  if (totalCombinations > MAX_COMBINATIONS) {
    throw new ValidationError(`Iteration Map has too many combinations; maximum is ${MAX_COMBINATIONS}`)
  }
  return normalized
}

export function normalizeIterationMapInput(input: unknown): AnalyzeIterationMapInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('Iteration Map payload is invalid')
  }
  const record = input as Record<string, unknown>
  return {
    organizationId: validateIdentifier(record.organizationId, 'Organization ID'),
    productId: validateIdentifier(record.productId, 'Product ID'),
    axes: normalizeIterationAxes(record.axes),
  }
}

function activeBriefsWithinLimit(briefs: readonly CreativeBrief[]): CreativeBrief[] {
  const active = briefs.filter(({ status }) => status !== 'archived')
  if (active.length > MAX_ACTIVE_BRIEFS) {
    throw new ValidationError(`Iteration Map has too many active briefs; maximum is ${MAX_ACTIVE_BRIEFS}`)
  }
  return active
}

export function analyzeIterationMap(
  input: AnalyzeIterationMapInput,
  product: Pick<Product, 'id' | 'organizationId'>,
  briefs: readonly CreativeBrief[],
): IterationMapResult {
  const normalizedInput = normalizeIterationMapInput(input)
  return analyzeNormalizedIterationMap(normalizedInput, product, activeBriefsWithinLimit(briefs))
}

export function analyzeNormalizedIterationMap(
  input: AnalyzeIterationMapInput,
  product: Pick<Product, 'id' | 'organizationId'>,
  briefs: readonly Pick<CreativeBrief, 'id' | 'title' | 'status' | 'dimensions'>[],
): IterationMapResult {
  if (product.organizationId !== input.organizationId || product.id !== input.productId) {
    throw new ValidationError('Product does not belong to organization')
  }

  const { audience: audiences, market: markets, angle: angles, format: formats } = input.axes
  const briefsByCombination = new Map<string, Array<Pick<CreativeBrief, 'id' | 'title' | 'status'>>>()

  for (const brief of briefs) {
    const key = keyOf(brief.dimensions)
    const ids = briefsByCombination.get(key) ?? []
    ids.push({ id: brief.id, title: brief.title, status: brief.status })
    briefsByCombination.set(key, ids)
  }

  const covered: IterationCell[] = []
  const missing: IterationCell[] = []
  for (const audience of audiences) {
    for (const market of markets) {
      for (const angle of angles) {
        for (const format of formats) {
          const dimensions = { audience, market, angle, format }
          const matchingBriefs = briefsByCombination.get(keyOf(dimensions)) ?? []
          const cell = {
            dimensions,
            briefIds: matchingBriefs.map(({ id }) => id),
            briefs: matchingBriefs.slice(0, MAX_CELL_BRIEF_EVIDENCE),
            briefCount: matchingBriefs.length,
            hasMoreBriefs: matchingBriefs.length > MAX_CELL_BRIEF_EVIDENCE,
          }
          if (matchingBriefs.length > 0) covered.push(cell)
          else missing.push(cell)
        }
      }
    }
  }

  return {
    totalCombinations: covered.length + missing.length,
    covered,
    missing,
  }
}

export class IterationMapService {
  constructor(
    private readonly products: ProductLookup,
    private readonly briefs: IterationMapBriefOverflowProbe,
  ) {}

  analyze(input: AnalyzeIterationMapInput): IterationMapResult {
    const normalizedInput = normalizeIterationMapInput(input)
    const product = this.products.findById(normalizedInput.productId)
    if (!product || product.organizationId !== normalizedInput.organizationId) throw new ValidationError('Product does not belong to organization')
    const briefs = this.briefs.listActiveForIterationMapOverflowProbe(normalizedInput.organizationId, product.id)
    return analyzeNormalizedIterationMap(normalizedInput, product, activeBriefsWithinLimit(briefs))
  }
}

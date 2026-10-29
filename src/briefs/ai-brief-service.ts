import type { CreativeAnalysisRecord } from '../creative-analysis/creative-analysis-service.ts'
import { renderProductionHandoff } from './ai-brief.ts'
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../domain/errors.ts'
import type { CreativeBrief } from '../domain/types.ts'

export interface AiBriefAnalysisService {
  analyze(actorUserId: string, organizationId: string, productId: string, adId: string): Promise<CreativeAnalysisRecord>
}

export interface AiBriefRepository {
  createAiFromAd(actorUserId: string, input: { organizationId: string; productId: string; adId: string; title: string; tags: CreativeAnalysisRecord['tags'] }): Promise<CreativeBrief>
  findById(actorUserId: string, organizationId: string, briefId: string): Promise<CreativeBrief | undefined>
}

export class AiBriefService {
  constructor(private readonly analysis: AiBriefAnalysisService | undefined, private readonly briefs: AiBriefRepository) {}

  async generate(actorUserId: string, organizationId: string, productId: string, adId: string, title: string): Promise<CreativeBrief> {
    if (!this.analysis) throw new ServiceUnavailableError()
    const analysis = await this.analysis.analyze(actorUserId, organizationId, productId, adId)
    return this.briefs.createAiFromAd(actorUserId, { organizationId, productId, adId, title, tags: analysis.tags })
  }

  async handoff(actorUserId: string, organizationId: string, briefId: string): Promise<{ briefId: string; version: number; filename: string; markdown: string }> {
    const brief = await this.briefs.findById(actorUserId, organizationId, briefId)
    if (!brief) throw new NotFoundError()
    if (!brief.details) throw new ValidationError('Brief does not contain a production handoff')
    const safeTitle = brief.title.replaceAll(/[^a-zA-Z0-9_-]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 80) || 'creative-brief'
    return { briefId: brief.id, version: brief.version, filename: `${safeTitle}-v${brief.version}.md`, markdown: renderProductionHandoff(brief) }
  }
}

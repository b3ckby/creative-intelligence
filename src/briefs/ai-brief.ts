import { CREATIVE_ANALYSIS_VERSION, type CreativeTags } from '../creative-analysis/creative-analysis-service.ts'
import { DataIntegrityError } from '../domain/errors.ts'
import { validateCanonicalText } from '../domain/validation.ts'
import type { BriefDimensions, CompetitorAd, CreativeBrief, CreativeBriefDetails, Product } from '../domain/types.ts'

export interface AiBriefDraft {
  hook: string
  callToAction: string | null
  dimensions: BriefDimensions
  details: CreativeBriefDetails
}

export function buildAiBriefDraft(product: Product, ad: CompetitorAd, tags: CreativeTags): AiBriefDraft {
  const audience = bounded(tags.persona || product.targetAudiences[0] || 'General audience', 100)
  const market = bounded(product.markets[0] || 'Global', 100)
  const keyMessage = bounded(tags.visualSummary || ad.headline || ad.body || product.name, 600)
  const hook = bounded(ad.body || tags.onScreenText || keyMessage, 20_000, true)
  const callToAction = bounded(tags.cta || ad.callToAction || 'Learn more', 100)
  const proofPoints = unique(product.uniqueSellingPoints.map((value) => bounded(value, 240))).slice(0, 8)
  const onScreenText = bounded(tags.onScreenText || ad.headline || keyMessage, 240)
  const visual = bounded(tags.visualSummary || `Show ${product.name} in use.`, 600)
  const spoken = bounded(firstSentence(hook) || keyMessage, 600)
  const cta = callToAction || 'Learn more'
  const details: CreativeBriefDetails = {
    strategy: {
      targetAudience: audience,
      objective: tags.funnelStage,
      keyMessage,
      tension: bounded(`${label(tags.hookCategory)} framed with ${tags.emotion}.`, 240),
      proofPoints,
    },
    artDirection: {
      format: tags.format,
      visualStyle: bounded(`${label(tags.angle)} ${label(tags.format)} creative`, 160),
      setting: visual,
      talent: audience,
      audio: tags.format === 'asmr' ? 'Natural sound-forward mix' : 'Clear voiceover with platform-native music',
      color: 'Use the product brand system with high-contrast captions.',
      mandatoryElements: unique([product.name, ...proofPoints.slice(0, 3), cta]).map((value) => bounded(value, 240)),
    },
    narrative: {
      storyArc: bounded(`Open on the ${label(tags.hookCategory)} tension, demonstrate the ${label(tags.offerFrame)} resolution, then close with a direct ${tags.funnelStage} CTA.`, 600),
      hooks: [{ visual, spoken, onScreenText }],
      bodyScript: hook,
      ctas: [cta],
    },
    production: {
      aspectRatios: ['9:16', '1:1'],
      durationSeconds: 30,
      deliverables: ['1 primary cut', '1 hook variation', '1 caption-safe cutdown'],
      shotList: [
        { sequence: 1, description: visual, audio: spoken, onScreenText },
        { sequence: 2, description: bounded(`Demonstrate ${proofPoints[0] || product.name} with product evidence.`, 600), audio: hook, onScreenText: bounded(proofPoints[0] || keyMessage, 240) },
        { sequence: 3, description: bounded(`End on ${product.name} and the conversion action.`, 600), audio: cta, onScreenText: cta },
      ],
      handoffNotes: 'Keep text inside platform-safe areas. Preserve claim accuracy and source-ad provenance during production.',
      sourceAnalysis: { analysisVersion: CREATIVE_ANALYSIS_VERSION, confidence: tags.confidence },
    },
  }
  return { hook, callToAction, dimensions: { audience, market, angle: tags.angle, format: tags.format }, details }
}

export function renderProductionHandoff(brief: CreativeBrief): string {
  const details = brief.details
  if (!details) return `# ${brief.title}\n\nNo structured production handoff is available.\n`
  const lines = [
    `# ${brief.title}`, '', `Status: **${brief.status}** · Version **${brief.version}**`, '',
    '## Strategic core', '', `- Audience: ${details.strategy.targetAudience}`, `- Objective: ${details.strategy.objective}`,
    `- Key message: ${details.strategy.keyMessage}`, `- Tension: ${details.strategy.tension}`,
    ...details.strategy.proofPoints.map((point) => `- Proof: ${point}`), '',
    '## Art direction', '', `- Format: ${details.artDirection.format}`, `- Visual style: ${details.artDirection.visualStyle}`,
    `- Setting: ${details.artDirection.setting}`, `- Talent: ${details.artDirection.talent}`, `- Audio: ${details.artDirection.audio}`,
    `- Color: ${details.artDirection.color}`, ...details.artDirection.mandatoryElements.map((item) => `- Mandatory: ${item}`), '',
    '## Narrative', '', details.narrative.storyArc, '', `Body script: ${details.narrative.bodyScript}`,
    ...details.narrative.ctas.map((cta) => `- CTA: ${cta}`), '',
    '## Shot list', '', '| # | Visual | Audio | On-screen text |', '|---:|---|---|---|',
    ...details.production.shotList.map((shot) => `| ${shot.sequence} | ${cell(shot.description)} | ${cell(shot.audio)} | ${cell(shot.onScreenText)} |`), '',
    '## Delivery', '', `- Duration: ${details.production.durationSeconds}s`, `- Aspect ratios: ${details.production.aspectRatios.join(', ')}`,
    ...details.production.deliverables.map((item) => `- Deliverable: ${item}`), `- Notes: ${details.production.handoffNotes}`, '',
    `Source ad: \`${brief.sourceAdId ?? 'none'}\``,
    `Analysis: \`${details.production.sourceAnalysis.analysisVersion}\` (confidence ${Math.round(details.production.sourceAnalysis.confidence * 100)}%)`, '',
  ]
  return `${lines.join('\n')}\n`
}

function bounded(value: string, maximum: number, allowEmpty = false): string {
  const normalized = value.normalize('NFC').trim()
  const chars = [...normalized]
  if (!allowEmpty && chars.length === 0) return 'Not specified'
  return chars.slice(0, maximum).join('')
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s/u, 1)[0] ?? value
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function label(value: string): string {
  return value.replaceAll('_', ' ')
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>')
}

export function decodeCreativeBriefDetails(value: unknown): CreativeBriefDetails {
  try {
    const root = exact(value, ['strategy', 'artDirection', 'narrative', 'production'])
    const strategy = exact(root.strategy, ['targetAudience', 'objective', 'keyMessage', 'tension', 'proofPoints'])
    const art = exact(root.artDirection, ['format', 'visualStyle', 'setting', 'talent', 'audio', 'color', 'mandatoryElements'])
    const narrative = exact(root.narrative, ['storyArc', 'hooks', 'bodyScript', 'ctas'])
    const production = exact(root.production, ['aspectRatios', 'durationSeconds', 'deliverables', 'shotList', 'handoffNotes', 'sourceAnalysis'])
    const source = exact(production.sourceAnalysis, ['analysisVersion', 'confidence'])
    return {
      strategy: {
        targetAudience: text(strategy.targetAudience, 'targetAudience', 100), objective: text(strategy.objective, 'objective', 100),
        keyMessage: text(strategy.keyMessage, 'keyMessage', 600), tension: text(strategy.tension, 'tension', 240), proofPoints: texts(strategy.proofPoints, 'proofPoints', 8, 240),
      },
      artDirection: {
        format: text(art.format, 'format', 100), visualStyle: text(art.visualStyle, 'visualStyle', 160), setting: text(art.setting, 'setting', 600),
        talent: text(art.talent, 'talent', 100), audio: text(art.audio, 'audio', 240), color: text(art.color, 'color', 240), mandatoryElements: texts(art.mandatoryElements, 'mandatoryElements', 8, 240),
      },
      narrative: {
        storyArc: text(narrative.storyArc, 'storyArc', 600), hooks: records(narrative.hooks, 'hooks', 5).map((item) => {
          const hook = exact(item, ['visual', 'spoken', 'onScreenText'])
          return { visual: text(hook.visual, 'visual', 600), spoken: text(hook.spoken, 'spoken', 600), onScreenText: text(hook.onScreenText, 'onScreenText', 240) }
        }), bodyScript: text(narrative.bodyScript, 'bodyScript', 20_000, true), ctas: texts(narrative.ctas, 'ctas', 5, 120),
      },
      production: {
        aspectRatios: texts(production.aspectRatios, 'aspectRatios', 5, 20), durationSeconds: integer(production.durationSeconds, 1, 300),
        deliverables: texts(production.deliverables, 'deliverables', 20, 240), shotList: records(production.shotList, 'shotList', 50).map((item) => {
          const shot = exact(item, ['sequence', 'description', 'audio', 'onScreenText'])
          return { sequence: integer(shot.sequence, 1, 50), description: text(shot.description, 'description', 600), audio: text(shot.audio, 'audio', 20_000, true), onScreenText: text(shot.onScreenText, 'onScreenText', 240) }
        }), handoffNotes: text(production.handoffNotes, 'handoffNotes', 2_000, true),
        sourceAnalysis: { analysisVersion: text(source.analysisVersion, 'analysisVersion', 100), confidence: finite(source.confidence, 0, 1) },
      },
    }
  } catch (error) {
    if (error instanceof DataIntegrityError) throw error
    throw new DataIntegrityError('Stored brief.details failed data-integrity validation')
  }
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some((key) => !(key in record))) throw new Error('keys')
  return record
}
function text(value: unknown, field: string, maxLength: number, allowEmpty = false): string { return validateCanonicalText(value, `brief.details.${field}`, { maxLength, allowEmpty }) }
function texts(value: unknown, field: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(field)
  return value.map((item) => text(item, field, maxLength))
}
function records(value: unknown, field: string, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) throw new Error(field)
  return value
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('integer')
  return value
}
function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error('number')
  return value
}

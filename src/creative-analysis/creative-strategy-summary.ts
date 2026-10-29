export interface CreativeStrategyFrequency {
  value: string
  count: number
  percentage: number
}

export interface CreativeStrategySummary {
  organizationId: string
  productId: string
  competitorId: string
  totalAds: number
  analyzedAds: number
  dimensions: {
    hooks: CreativeStrategyFrequency[]
    angles: CreativeStrategyFrequency[]
    formats: CreativeStrategyFrequency[]
    emotions: CreativeStrategyFrequency[]
    personas: CreativeStrategyFrequency[]
    offers: CreativeStrategyFrequency[]
    funnelStages: CreativeStrategyFrequency[]
  }
}

export interface CreativeStrategySummaryService {
  get(actorUserId: string, organizationId: string, productId: string, competitorId: string): Promise<CreativeStrategySummary>
}

import type { BriefStatus } from './types.ts'

export const BRIEF_STATUS_TRANSITIONS: Readonly<Record<BriefStatus, readonly BriefStatus[]>> = {
  draft: ['draft', 'triage', 'archived'],
  triage: ['triage', 'draft', 'approved', 'archived'],
  approved: ['approved', 'triage', 'production', 'archived'],
  production: ['production', 'review', 'archived'],
  review: ['review', 'production', 'completed', 'archived'],
  completed: ['completed', 'archived'],
  archived: ['archived', 'draft'],
}

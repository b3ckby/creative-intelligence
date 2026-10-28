import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBriefUpdate, requireBriefStatusTransition } from '../src/briefs/brief-workflow.ts'
import { BRIEF_STATUS_TRANSITIONS } from '../src/domain/brief-status-transitions.ts'
import type { BriefStatus } from '../src/domain/types.ts'

const dimensions = { audience: ' Founders ', market: ' US ', angle: ' Speed ', format: ' Video ' }

test('brief updates normalize a complete replacement and require a positive expected version', () => {
  assert.deepEqual(normalizeBriefUpdate({
    expectedVersion: 2,
    title: ' Revised concept ',
    status: 'triage',
    hook: ' New hook ',
    callToAction: null,
    dimensions,
  }), {
    expectedVersion: 2,
    title: 'Revised concept',
    status: 'triage',
    hook: 'New hook',
    callToAction: null,
    dimensions: { audience: 'Founders', market: 'US', angle: 'Speed', format: 'Video' },
  })
  for (const expectedVersion of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => normalizeBriefUpdate({ expectedVersion, title: 'Brief', status: 'draft', hook: '', callToAction: null, dimensions }), /version/i)
  }
})

test('brief transition policy matches the explicit matrix for every status pair', () => {
  const statuses: BriefStatus[] = ['draft', 'triage', 'approved', 'production', 'review', 'completed', 'archived']
  const expected: Record<BriefStatus, readonly BriefStatus[]> = {
    draft: ['draft', 'triage', 'archived'],
    triage: ['triage', 'draft', 'approved', 'archived'],
    approved: ['approved', 'triage', 'production', 'archived'],
    production: ['production', 'review', 'archived'],
    review: ['review', 'production', 'completed', 'archived'],
    completed: ['completed', 'archived'],
    archived: ['archived', 'draft'],
  }

  assert.deepEqual(BRIEF_STATUS_TRANSITIONS, expected)
  for (const from of statuses) {
    for (const to of statuses) {
      if (expected[from].includes(to)) {
        assert.doesNotThrow(() => requireBriefStatusTransition(from, to), `${from} -> ${to}`)
      } else {
        assert.throws(() => requireBriefStatusTransition(from, to), /transition/i, `${from} -> ${to}`)
      }
    }
  }
})

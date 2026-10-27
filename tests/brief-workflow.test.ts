import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeBriefUpdate, requireBriefStatusTransition } from '../src/briefs/brief-workflow.ts'

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

test('brief workflow permits only adjacent progress, correction, archive, and restore transitions', () => {
  const allowed = [
    ['draft', 'triage'], ['triage', 'draft'], ['triage', 'approved'], ['approved', 'triage'],
    ['approved', 'production'], ['production', 'review'], ['review', 'production'],
    ['review', 'completed'], ['archived', 'draft'], ['draft', 'archived'], ['completed', 'archived'],
  ] as const
  for (const [from, to] of allowed) assert.doesNotThrow(() => requireBriefStatusTransition(from, to))
  assert.doesNotThrow(() => requireBriefStatusTransition('approved', 'approved'))
  for (const [from, to] of [['draft', 'approved'], ['production', 'draft'], ['completed', 'review'], ['archived', 'completed']] as const) {
    assert.throws(() => requireBriefStatusTransition(from, to), /transition/i)
  }
})

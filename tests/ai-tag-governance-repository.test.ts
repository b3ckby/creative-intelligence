import assert from 'node:assert/strict'
import test from 'node:test'

import { ConflictError, ValidationError } from '../src/domain/errors.ts'
import { validateCreativeTagReviewSubmission } from '../src/creative-analysis/creative-tag-review.ts'
import { PostgresCreativeTagReviewRepository } from '../src/persistence/postgres-creative-tag-review-repository.ts'
import type { SqlConnection, SqlPool } from '../src/persistence/postgres-organization-repository.ts'

class FakePool implements SqlPool, SqlConnection {
  queries: Array<{ text: string; values?: readonly unknown[] }> = []
  reviewVersion = 0
  async connect() { return this }
  release() {}
  async query<Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) })
    if (text.includes('FROM creative_ad_analyses ca') && text.includes('FOR SHARE')) return { rows: [{ product_id: 'product-1' }] as unknown as Row[], rowCount: 1 }
    if (text.includes('max(review_version)')) return { rows: [{ review_version: this.reviewVersion }] as unknown as Row[], rowCount: 1 }
    if (text.includes('INSERT INTO creative_analysis_reviews')) {
      this.reviewVersion += 1
      return { rows: [{
        organization_id: 'org-1', product_id: 'product-1', competitor_ad_id: 'ad-1', analysis_version: 'v1',
        input_fingerprint: 'a'.repeat(64), review_version: this.reviewVersion, decision: values?.[6], corrections: values?.[7] ? JSON.parse(values[7] as string) : null,
        reason: values?.[8], reviewer_user_id: 'member-1', reviewed_at: '2026-10-29T10:00:00.000Z',
      }] as unknown as Row[], rowCount: 1 }
    }
    return { rows: [] as unknown as Row[], rowCount: 0 }
  }
}

test('review submission accepts only bounded corrections from the existing categorical taxonomy', () => {
  assert.deepEqual(validateCreativeTagReviewSubmission({
    expectedReviewVersion: 0, decision: 'corrected', reason: 'Human verified the visual format.',
    corrections: { hookCategory: 'results', format: 'tutorial' },
  }), {
    expectedReviewVersion: 0, decision: 'corrected', reason: 'Human verified the visual format.',
    corrections: { hookCategory: 'results', format: 'tutorial' },
  })
  assert.throws(() => validateCreativeTagReviewSubmission({ expectedReviewVersion: 0, decision: 'corrected', reason: 'Reason', corrections: { hookCategory: 'invented' } }), ValidationError)
  assert.throws(() => validateCreativeTagReviewSubmission({ expectedReviewVersion: 0, decision: 'approved', reason: 'Reason', corrections: { angle: 'rational' } }), ValidationError)
  assert.throws(() => validateCreativeTagReviewSubmission({ expectedReviewVersion: 0, decision: 'corrected', reason: 'Reason', corrections: {} }), ValidationError)
})

test('review repository appends a reviewer-attributed version against one exact immutable analysis identity', async () => {
  const pool = new FakePool()
  const repository = new PostgresCreativeTagReviewRepository(pool)
  const review = await repository.submit('member-1', 'org-1', 'ad-1', 'v1', 'a'.repeat(64), {
    expectedReviewVersion: 0, decision: 'corrected', reason: 'Human verified the visual format.', corrections: { format: 'tutorial' },
  })
  assert.equal(review.reviewVersion, 1)
  assert.equal(review.reviewerUserId, 'member-1')
  assert.deepEqual(review.corrections, { format: 'tutorial' })
  const insert = pool.queries.find(({ text }) => text.includes('INSERT INTO creative_analysis_reviews'))
  assert.match(insert?.text ?? '', /reviewer_user_id[\s\S]*app_verified_user_id\(\)/u)
  assert.match(pool.queries.map(({ text }) => text).join('\n'), /pg_advisory_xact_lock/u)
})

test('review repository rejects stale optimistic versions without overwriting history', async () => {
  const pool = new FakePool()
  pool.reviewVersion = 2
  const repository = new PostgresCreativeTagReviewRepository(pool)
  await assert.rejects(repository.submit('member-1', 'org-1', 'ad-1', 'v1', 'a'.repeat(64), {
    expectedReviewVersion: 1, decision: 'approved', reason: 'Checked against the source.', corrections: null,
  }), ConflictError)
  assert.equal(pool.queries.some(({ text }) => text.includes('INSERT INTO creative_analysis_reviews')), false)
})

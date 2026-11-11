// 0.4.4: check must say when review verdicts and implementation evidence disagree.
import assert from 'node:assert/strict'
import test from 'node:test'

import { compareReviewAndEvidence } from '../lib/index.js'

const review = (over = {}) => ({ round: 3, reviewer: 'judge', ready: 9, clarify: 0, blocked: 0, blocking: 0, stale: false, staleField: '', ...over })
const evidence = (over = {}) => ({ pass: 49, fail: 0, skipped: 0, total: 49, generatedAt: '2026-11-11T01:00:00.000Z', stale: false, ...over })

test('agreement produces ok', () => {
  assert.deepEqual(compareReviewAndEvidence(review(), evidence()), { ok: true, reasons: [] })
})

test('blocking review next to evidence is called out', () => {
  const result = compareReviewAndEvidence(review({ blocked: 1, blocking: 2 }), evidence())
  assert.equal(result?.ok, false)
  assert.match(result?.reasons[0] ?? '', /round 3 has 1 blocked module\(s\), 2 blocking item\(s\)/)
})

test('stale review and stale evidence are both reported', () => {
  const result = compareReviewAndEvidence(review({ stale: true, staleField: 'spec' }), evidence({ stale: true }))
  assert.equal(result?.reasons.length, 2)
  assert.match(result?.reasons[0] ?? '', /older SPEC\.md/)
  assert.match(result?.reasons[1] ?? '', /older compose-plan\.json/)
})

test('failing evidence is reported even when the review passed', () => {
  const result = compareReviewAndEvidence(review(), evidence({ pass: 47, fail: 2 }))
  assert.match(result?.reasons[0] ?? '', /2 FAIL row\(s\)/)
})

test('a passing review with no evidence yet is not an error, just a note', () => {
  const result = compareReviewAndEvidence(review(), undefined)
  assert.equal(result?.ok, false)
  assert.match(result?.reasons[0] ?? '', /no implementation evidence has been recorded yet/)
})

test('nothing recorded means no consistency block', () => {
  assert.equal(compareReviewAndEvidence(undefined, undefined), undefined)
})
// 0.4.5: one verdict for "can I hand this document over?"
import assert from 'node:assert/strict'
import test from 'node:test'
import { distributionReadiness } from '../lib/index.js'

function payload(extra) {
  return {
    runId: 'run-x-y',
    graphRoot: 'root',
    passed: [],
    failed: [],
    notRun: [],
    evidence: [],
    graphIssues: [],
    graphExitCode: 0,
    ...extra,
  }
}

const review = { round: 2, reviewer: 'judge', ready: 9, clarify: 0, blocked: 0, blocking: 0 }
const evidence = { pass: 3, fail: 0, skipped: 0, total: 3, generatedAt: '2026-01-01T00:00:00.000Z', stale: false }

test('readiness: nothing recorded yet', () => {
  const verdict = distributionReadiness(payload({}))
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.reasons, [
    'no review round has been recorded',
    'no implementation evidence has been recorded',
  ])
})

test('readiness: review passed and evidence recorded', () => {
  const verdict = distributionReadiness(
    payload({ review, implementation: evidence, consistency: { ok: true, reasons: [] } }),
  )
  assert.deepEqual(verdict, { ok: true, reasons: [] })
})

test('readiness: consistency problems are carried through', () => {
  const verdict = distributionReadiness(
    payload({
      review: { ...review, blocked: 1, blocking: 2 },
      implementation: evidence,
      consistency: { ok: false, reasons: ['review round 2 has 1 blocked module(s), 2 blocking point(s)'] },
    }),
  )
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reasons.length, 1)
  assert.match(verdict.reasons[0], /1 blocked module/)
})

test('readiness: reasons are not duplicated', () => {
  const reason = 'implementation evidence has 1 FAIL row(s)'
  const verdict = distributionReadiness(
    payload({
      review,
      implementation: { ...evidence, fail: 1 },
      consistency: { ok: false, reasons: [reason, reason] },
    }),
  )
  assert.deepEqual(verdict.reasons, [reason])
})

test('readiness: partial coverage blocks hand-over', () => {
  const verdict = distributionReadiness(
    payload({
      review,
      implementation: { ...evidence, coverage: { declared: 3, recorded: 2, missing: ['AC-M1-1'] } },
      consistency: { ok: true, reasons: [] },
    }),
  )
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.reasons, ['implementation coverage 2/3 — missing AC-M1-1'])
})
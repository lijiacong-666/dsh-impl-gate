// Review staleness must follow BOTH the plan and the rendered SPEC: after a
// renderer upgrade the plan hash is unchanged while SPEC.md is not.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'

import { reviewSummary } from '../lib/index.js'

function fixture({ plan = 'p1', spec = 's1', storedPlan = 'p1', storedSpec = 's1' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-echo-'))
  fs.writeFileSync(path.join(dir, 'compose-plan.json'), plan, 'utf8')
  fs.writeFileSync(path.join(dir, 'SPEC.md'), spec, 'utf8')
  fs.mkdirSync(path.join(dir, '.impl-gate'), { recursive: true })
  const sha = (text) => createHash('sha256').update(text).digest('hex')
  fs.writeFileSync(
    path.join(dir, '.impl-gate', 'review.json'),
    JSON.stringify({
      schemaVersion: 1,
      rounds: [
        {
          round: 1,
          reviewer: 'judge',
          planSha256: sha(storedPlan),
          specSha256: sha(storedSpec),
          summary: { ready: 2, clarify: 0, blocked: 0, blocking: 0 },
        },
      ],
    }),
    'utf8',
  )
  return dir
}

test('review echo is fresh when both hashes match', () => {
  const summary = reviewSummary(fixture({}))
  assert.equal(summary?.stale, false)
  assert.equal(summary?.staleField, '')
})

test('review echo flags a changed plan first', () => {
  const summary = reviewSummary(fixture({ plan: 'p2' }))
  assert.equal(summary?.stale, true)
  assert.equal(summary?.staleField, 'plan')
})

test('review echo flags a regenerated SPEC when the plan is unchanged', () => {
  const summary = reviewSummary(fixture({ spec: 's2' }))
  assert.equal(summary?.stale, true)
  assert.equal(summary?.staleField, 'spec')
})

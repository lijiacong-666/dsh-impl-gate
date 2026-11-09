// review.json: one review round per call, append-only, blocking is the pass line.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { recordReview } from '../lib/index.js'

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'))
  const plan = {
    schemaVersion: 1,
    name: 'review-demo',
    title: 't',
    summary: 's',
    stack: 'node22',
    goals: ['g'],
    nonGoals: ['n'],
    boundaries: [{ dependency: 'd', purpose: 'p', fallback: 'f' }],
    globals: { conventions: [], forbidden: [] },
    data: [{ table: 't', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] }],
    types: [],
    errors: [],
    http: [],
    modules: [
      { id: 'M1', dir: 'a', title: 'a', responsibility: 'r', exposes: [{ kind: 'fn', signature: 'f(): Promise<void>' }], requires: [], constraints: ['c'], files: ['a/migrations/001.sql'], acceptance: [{ id: 'a1', assertion: 'x', test: 't' }] },
    ],
    openQuestions: [],
    deliverables: { tree: 't', files: [{ path: 'a', purpose: 'p' }] },
  }
  fs.writeFileSync(path.join(dir, 'compose-plan.json'), JSON.stringify(plan))
  return dir
}

test('records a round and appends the next one', () => {
  const dir = project()
  const first = recordReview(dir, { reviewer: 'r1', verdicts: [{ module: 'M1', status: 'ready' }] })
  assert.equal(first.ok, true)
  assert.equal(first.round, 1)
  assert.equal(first.ready, 1)
  const second = recordReview(dir, { reviewer: 'r2', verdicts: [{ module: 'M1', status: 'blocked', blocking: ['缺 X'] }] })
  assert.equal(second.ok, true)
  assert.equal(second.round, 2)
  assert.equal(second.blocking, 1)
  const stored = JSON.parse(fs.readFileSync(path.join(dir, '.impl-gate', 'review.json'), 'utf8'))
  assert.equal(stored.rounds.length, 2)
  assert.deepEqual(stored.rounds.map((entry) => entry.round), [1, 2])
})

test('rejects an unknown module and a duplicate round', () => {
  const dir = project()
  const bad = recordReview(dir, { reviewer: 'r', verdicts: [{ module: 'M9', status: 'ready' }] })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'REVIEW_MODULE_UNKNOWN')
  recordReview(dir, { reviewer: 'r', verdicts: [{ module: 'M1', status: 'ready' }] })
  const dup = recordReview(dir, { reviewer: 'r', round: 1, verdicts: [{ module: 'M1', status: 'ready' }] })
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'REVIEW_ROUND_EXISTS')
})

test('a missing plan is reported, not created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-empty-'))
  const result = recordReview(dir, { reviewer: 'r', verdicts: [{ module: 'M1', status: 'ready' }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PLAN_MISSING')
  assert.equal(fs.existsSync(path.join(dir, '.impl-gate', 'review.json')), false)
})

// Round numbering has to survive a gap: `.impl-gate/review.json` is append-only
// but humans delete entries. `length + 1` collided with the highest round.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { recordReview } from '../lib/index.js'

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-rounds-'))
  const plan = {
    schemaVersion: 1,
    name: 'rounds',
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
      {
        id: 'M1',
        dir: 'a',
        title: 'a',
        responsibility: 'r',
        exposes: [{ kind: 'fn', signature: 'f(): Promise<void>' }],
        requires: [],
        constraints: ['c'],
        files: ['a/migrations/001.sql'],
        acceptance: [{ id: 'a1', assertion: 'x', test: 't' }],
      },
    ],
    openQuestions: [],
    deliverables: { tree: 't', files: [{ path: 'a', purpose: 'p' }] },
  }
  fs.writeFileSync(path.join(dir, 'compose-plan.json'), JSON.stringify(plan))
  return dir
}

const ready = [{ module: 'M1', status: 'ready' }]

test('the first round has no blocking delta', () => {
  const dir = project()
  const first = recordReview(dir, { reviewer: 'r', verdicts: ready })
  assert.equal(first.round, 1)
  assert.equal(first.blockingDelta, undefined)
})

test('a gap in the stored rounds does not make the next number collide', () => {
  const dir = project()
  recordReview(dir, { reviewer: 'r', round: 1, verdicts: ready })
  recordReview(dir, { reviewer: 'r', round: 3, verdicts: ready })
  const next = recordReview(dir, { reviewer: 'r', verdicts: ready })
  assert.equal(next.ok, true)
  assert.equal(next.round, 4)
  assert.equal(next.blockingDelta, 0)
})

test('deleting review.json restarts at round 1', () => {
  const dir = project()
  recordReview(dir, { reviewer: 'r', verdicts: ready })
  fs.rmSync(path.join(dir, '.impl-gate', 'review.json'))
  const again = recordReview(dir, { reviewer: 'r', verdicts: ready })
  assert.equal(again.round, 1)
  assert.equal(again.blockingDelta, undefined)
})
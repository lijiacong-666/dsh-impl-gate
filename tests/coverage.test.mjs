// 0.4.6: coverage — "12/21 AC recorded" so a partial implementation cannot look complete.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { implementationEvidence } from '../lib/index.js'

function workspace(plan, evidence) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-cov-'))
  fs.writeFileSync(path.join(dir, 'compose-plan.json'), JSON.stringify(plan))
  fs.mkdirSync(path.join(dir, '.impl-gate'))
  fs.writeFileSync(path.join(dir, '.impl-gate', 'ac-evidence.json'), JSON.stringify(evidence))
  return dir
}

const plan = {
  modules: [
    { id: 'M1', acceptance: [{ id: 'core-migrate' }, { id: 'core-date' }] },
    { id: 'M2', acceptance: [{ id: 'catalog-create' }] },
  ],
}

test('coverage: every declared AC recorded by id', () => {
  const dir = workspace(plan, {
    summary: { pass: 3, fail: 0, skipped: 0, total: 3 },
    generatedAt: '2026-01-01T00:00:00.000Z',
    items: [{ id: 'core-migrate' }, { id: 'core-date' }, { id: 'catalog-create' }],
  })
  const found = implementationEvidence(dir)
  assert.deepEqual(found.coverage, { declared: 3, recorded: 3, missing: [] })
})

test('coverage: MATCH BY ref works when evidence ids differ', () => {
  const dir = workspace(plan, {
    summary: { pass: 2, fail: 0, skipped: 0, total: 2 },
    generatedAt: '2026-01-01T00:00:00.000Z',
    items: [
      { id: 'core-migrate', ref: 'AC-M1-1' },
      { id: 'core-date', ref: 'AC-M1-2' },
    ],
  })
  const found = implementationEvidence(dir)
  assert.equal(found.coverage.recorded, 2)
  assert.deepEqual(found.coverage.missing, ['catalog-create'])
})

test('coverage: empty evidence reports everything missing', () => {
  const dir = workspace(plan, { summary: {}, generatedAt: '', items: [] })
  const found = implementationEvidence(dir)
  assert.deepEqual(found.coverage, { declared: 3, recorded: 0, missing: ['core-migrate', 'core-date', 'catalog-create'] })
})
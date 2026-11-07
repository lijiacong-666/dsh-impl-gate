// A4 symmetric set rules, unit-tested without spawning specgraph.
import test from 'node:test'
import assert from 'node:assert/strict'
import { auditChecklist, parseChecklist } from '../lib/index.js'

const HEADER = ['| id | status | evidence | reason |', '|---|---|---|---|']

function table(rows) {
  return [...HEADER, ...rows].join('\n')
}

test('A4: NOT-RUN rows listed in the uncovered section are symmetric', () => {
  const list = parseChecklist(
    table([
      '| A1 | PASS | command: python -m specgraph check . --json; exit: 0 |  |',
      '| B1 | NOT-RUN | file: IMPL-GATE-执行清单-v1.txt:1 | NOT_IMPLEMENTED |',
    ]) + '\n\n## 未覆盖\n\nB1\n',
    'checklist.md',
  )
  const audit = auditChecklist(list)
  assert.equal(audit.notRun.size, 1)
  assert.equal(audit.sectionMissingButNeeded, false)
  assert.deepEqual(audit.onlyInReport, [])
  assert.deepEqual(audit.onlyInSection, [])
})

test('A4: NOT-RUN rows without the uncovered section fail', () => {
  const list = parseChecklist(
    table(['| B1 | NOT-RUN | file: IMPL-GATE-执行清单-v1.txt:1 | NOT_IMPLEMENTED |']),
    'checklist.md',
  )
  const audit = auditChecklist(list)
  assert.equal(audit.sectionMissingButNeeded, true)
  assert.deepEqual(audit.onlyInReport, ['B1'])
})

test('A4: a section listing a non-NOT-RUN id fails even when notRun is empty', () => {
  const list = parseChecklist(
    table(['| A1 | PASS | command: python -m specgraph check . --json; exit: 0 |  |']) +
      '\n\n## 未覆盖\n\nA1\n',
    'checklist.md',
  )
  const audit = auditChecklist(list)
  assert.equal(audit.notRun.size, 0)
  assert.equal(audit.sectionMissingButNeeded, false)
  assert.deepEqual(audit.onlyInSection, ['A1'])
})

test('A4: section missing one NOT-RUN id reports onlyInReport', () => {
  const list = parseChecklist(
    table([
      '| B1 | NOT-RUN | file: IMPL-GATE-执行清单-v1.txt:1 | NOT_IMPLEMENTED |',
      '| B2 | NOT-RUN | file: IMPL-GATE-执行清单-v1.txt:1 | NOT_IMPLEMENTED |',
    ]) + '\n\n## 未覆盖\n\nB1\n',
    'checklist.md',
  )
  const audit = auditChecklist(list)
  assert.deepEqual(audit.onlyInReport, ['B2'])
  assert.deepEqual(audit.onlyInSection, [])
})
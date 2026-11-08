// 1.1: re-materializing must not erase evidence. PASS/FAIL rows survive with
// their evidence, deleted ids are dropped, and 未覆盖 is recomputed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeChecklist, parseChecklist, loadChecks } from '../lib/index.js'

const items = loadChecks()

function rendered(rows) {
  return [
    '# 验收勾选表',
    '',
    '| id | status | evidence | reason |',
    '|----|--------|----------|--------|',
    ...rows,
    '',
    '## 未覆盖',
    '',
    'x',
    '',
  ].join('\n')
}

test('PASS rows keep their evidence and leave 未覆盖', () => {
  const previous = rendered([
    '| A1 | PASS | command:pnpm test | |',
    '| A2 | NOT-RUN | file:SPEC.md:1 | NOT_IMPLEMENTED |',
  ])
  const merged = mergeChecklist(previous, items, 'demo')
  assert.deepEqual(merged.preserved, ['A1'])
  const parsed = parseChecklist(merged.body, '.impl-gate/checklist.md')
  assert.equal(parsed.rows.get('A1').status, 'PASS')
  assert.equal(parsed.rows.get('A1').evidence, 'command:pnpm test')
  assert.ok(!merged.body.includes('A1、'), 'A1 must not be listed as uncovered')
})

test('FAIL rows are preserved too, unknown ids dropped', () => {
  const previous = rendered([
    '| A1 | FAIL | command:pnpm check | broken',
    '| ZZ9 | PASS | command:noop | |',
  ])
  const merged = mergeChecklist(previous, items, 'demo')
  assert.deepEqual(merged.preserved, ['A1'])
  assert.equal(parseChecklist(merged.body, 'x').rows.get('A1').status, 'FAIL')
  assert.ok(!merged.body.includes('ZZ9'))
})

test('empty previous yields the full NOT-RUN skeleton', () => {
  const merged = mergeChecklist(undefined, items, 'demo')
  assert.deepEqual(merged.preserved, [])
  const parsed = parseChecklist(merged.body, 'x')
  assert.equal(parsed.rows.size, items.length)
  for (const item of items) assert.equal(parsed.rows.get(item.id).status, 'NOT-RUN')
  assert.ok(merged.body.includes('（无）') === false)
})

test('every check still appears when everything was decided', () => {
  const all = items.map((item) => `| ${item.id} | PASS | file:SPEC.md:1 | |`)
  const merged = mergeChecklist(rendered(all), items, 'demo')
  assert.equal(merged.preserved.length, items.length)
  assert.ok(merged.body.includes('（无）'), 'uncovered section must say （无） when empty')
  assert.equal(parseChecklist(merged.body, 'x').rows.size, items.length)
})
// The report payload should carry something a reviewer can paste into a PR
// comment without reshaping it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { coverageStatement, reportMarkdown } from '../lib/index.js'

function rows(...statuses) {
  return statuses.map((status, index) => ({ id: `A${index + 1}`, status }))
}

test('markdown carries the three numbers, coverage and readiness', () => {
  const md = reportMarkdown({
    summary: 'PASS 10 / FAIL 0 / NOT-RUN 22',
    checklist: rows('PASS', 'FAIL', 'NOT-RUN'),
    uncovered: ['A3'],
    readiness: { ok: false, reasons: ['no review record'] },
  })
  assert.match(md, /^\| assertions \| PASS 10 \/ FAIL 0 \/ NOT-RUN 22 \|$/m)
  assert.match(md, /\| failed \| A2 \|/)
  assert.match(md, /\| coverage \| 未覆盖集合 ≡ NOT-RUN 集合（不等） \|/)
  assert.match(md, /\| readiness \| not ready \|/)
  assert.match(md, /\| reason \| no review record \|/)
})

test('a ready report has no failed or reason rows', () => {
  const md = reportMarkdown({
    summary: 'PASS 32 / FAIL 0 / NOT-RUN 0',
    checklist: rows(...Array.from({ length: 32 }, () => 'PASS')),
    uncovered: [],
    readiness: { ok: true, reasons: [] },
  })
  assert.doesNotMatch(md, /\| failed \|/)
  assert.doesNotMatch(md, /\| reason \|/)
  assert.match(md, /\| readiness \| ready to hand over \|/)
  assert.match(md, /\| coverage \| 未覆盖集合 ≡ NOT-RUN 集合（相等） \|/)
})

test('pipes inside a reason are escaped so the table survives', () => {
  const md = reportMarkdown({
    summary: 'PASS 0 / FAIL 1 / NOT-RUN 0',
    checklist: rows('FAIL'),
    uncovered: [],
    readiness: { ok: false, reasons: ['evidence | stale'] },
  })
  assert.match(md, /evidence \\\| stale/)
})

test('coverage statement only says 相等 when all 32 rows line up', () => {
  const shortRows = rows(...Array.from({ length: 30 }, () => 'PASS'), 'NOT-RUN')
  assert.match(coverageStatement(shortRows, ['A31']), /（不等）/)
  const full = rows(...Array.from({ length: 31 }, () => 'PASS'), 'NOT-RUN')
  assert.match(coverageStatement(full, ['A32']), /（相等）/)
})
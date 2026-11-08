// Materialize must hand implementers a parseable checklist: 32 rows in the
// id|status|evidence|reason shape, and the 「未覆盖」 section must mirror the
// NOT-RUN set, otherwise A4 fails on the file it just generated.
import assert from 'node:assert/strict'
import test from 'node:test'

import { auditChecklist, loadChecks, parseChecklist, renderChecklistTemplate } from '../lib/index.js'

const items = loadChecks()

test('the generated checklist parses with 32 rows', () => {
  const text = renderChecklistTemplate(items, 'demo')
  const parsed = parseChecklist(text)
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.rows.size, 32)
  for (const row of parsed.rows.values()) {
    assert.equal(row.status, 'NOT-RUN')
    assert.equal(row.reason, 'NOT_IMPLEMENTED')
  }
})

test('the uncovered section mirrors the NOT-RUN set (A4 symmetric)', () => {
  const text = renderChecklistTemplate(items, 'demo')
  const audit = auditChecklist(parseChecklist(text))
  assert.equal(audit.notRun.size, 32)
  assert.deepEqual(audit.onlyInReport, [])
  assert.deepEqual(audit.onlyInSection, [])
  assert.equal(audit.sectionMissingButNeeded, false)
  assert.equal(parseChecklist(text).hasUncoveredSection, true)
})
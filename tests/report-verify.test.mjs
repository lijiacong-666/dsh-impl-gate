// Step 4: report / verify_contract must reuse one cached run and never re-run checks.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { buildReport, buildVerifyContract, coverageStatement, rememberRun } from '../lib/index.js'

const checks = JSON.parse(
  readFileSync(new URL('../checks/impl-gate.checks.json', import.meta.url), 'utf8'),
)
const ids = checks.items.map((item) => item.id)

function payload(runId, passed, failed, notRun) {
  return {
    passed,
    failed,
    notRun,
    evidence: [],
    graphIssues: [],
    graphExitCode: 0,
    runId,
    startedAt: new Date().toISOString(),
    durationMs: 1,
  }
}

test('report summarises the cached run and lists the uncovered set', () => {
  const runId = 'run-test-pass'
  rememberRun(runId, payload(runId, ids, [], []), {}, 'D:/proj')
  const report = buildReport({ root: 'D:/proj', runId })
  assert.equal(report.error, undefined)
  assert.equal(report.summary, 'PASS 32 / FAIL 0 / NOT-RUN 0 (32)')
  assert.equal(report.checklist.length, 32)
  assert.deepEqual(report.uncovered, [])
  assert.equal(coverageStatement(report.checklist, report.uncovered), '未覆盖集合 ≡ NOT-RUN 集合（相等）')
})

test('report carries the reason for every NOT-RUN row', () => {
  const runId = 'run-test-notrun'
  const passed = ids.filter((id) => id.startsWith('A'))
  const notRun = ids.filter((id) => !id.startsWith('A'))
  const reasons = Object.fromEntries(notRun.map((id) => [id, 'NOT_IMPLEMENTED']))
  rememberRun(runId, payload(runId, passed, [], notRun), reasons, 'D:/proj')
  const report = buildReport({ root: 'D:/proj', runId })
  assert.equal(report.summary, `PASS ${passed.length} / FAIL 0 / NOT-RUN ${notRun.length} (32)`)
  assert.deepEqual(report.uncovered.sort(), notRun.sort())
  for (const row of report.checklist.filter((entry) => entry.status === 'NOT-RUN')) {
    assert.equal(row.reason, 'NOT_IMPLEMENTED')
  }
  assert.equal(coverageStatement(report.checklist, report.uncovered), '未覆盖集合 ≡ NOT-RUN 集合（相等）')
})

test('report refuses to reuse a run cached under another root', () => {
  const runId = 'run-test-root'
  rememberRun(runId, payload(runId, ids, [], []), {}, 'D:/proj')
  const report = buildReport({ root: 'D:/other', runId })
  assert.equal(report.error?.code, 'E_NO_PRIOR_RUN')
  assert.match(report.error.detail ?? '', /cached root/)
})

test('report without a previous run returns E_NO_PRIOR_RUN', () => {
  const report = buildReport({ root: 'D:/never-run' })
  assert.equal(report.error?.code, 'E_NO_PRIOR_RUN')
})

test('verify_contract is ok only when A1–A5 all passed', () => {
  const okRun = 'run-test-verify-ok'
  rememberRun(okRun, payload(okRun, ids, [], []), {}, 'D:/proj')
  const ok = buildVerifyContract({ root: 'D:/proj', runId: okRun })
  assert.equal(ok.ok, true)
  assert.equal(ok.details.length, 5)
  assert.deepEqual(
    ok.details.map((line) => line.split(' ')[0]),
    ['A1', 'A2', 'A3', 'A4', 'A5'],
  )

  const badRun = 'run-test-verify-bad'
  const notRun = ids.filter((id) => id !== 'A3')
  rememberRun(badRun, payload(badRun, ['A3'], [], notRun), { [ 'A1' ]: 'NOT_IMPLEMENTED' }, 'D:/proj')
  const bad = buildVerifyContract({ root: 'D:/proj', runId: badRun })
  assert.equal(bad.ok, false)
  const a3 = bad.details.find((line) => line.startsWith('A3 '))
  assert.match(a3, /A3 PASS/)
})

test('verify_contract refuses a run from another root', () => {
  const runId = 'run-test-verify-root'
  rememberRun(runId, payload(runId, ids, [], []), {}, 'D:/proj')
  const result = buildVerifyContract({ root: 'D:/other', runId })
  assert.equal(result.error?.code, 'E_NO_PRIOR_RUN')
})
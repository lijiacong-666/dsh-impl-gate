// A2 consumes parseChecklist.errors: unknown reason / illegal status /
// duplicate id / bad evidence prefix must all make A2 FAIL.
import assert from 'node:assert/strict'
import test from 'node:test'

import { checkA2, parseChecklist } from '../lib/index.js'

function context(text) {
  return {
    graphRoot: 'G',
    implRoot: 'I',
    slow: false,
    timeoutMs: 30000,
    checks: [{ id: 'A1' }],
    checklist: parseChecklist(text, 'checklist.md'),
    preGraphHashes: {},
    specgraphHome: '',
    allowCommandReplay: false,
    replayBudget: { remaining: 5 },
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runImpl: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    hashGraph: async () => ({}),
    newTempDir: async () => 'TMP',
  }
}

const header = '| id | status | evidence | reason |\n|---|---|---|---|\n'

test('A2 fails on an unknown reason code', async () => {
  const out = await checkA2(context(`${header}| A1 | NOT-RUN | command: python x.py; exit: 0 | BOGUS |`))
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /not a §5 code/)
})

test('A2 fails on an illegal status', async () => {
  const out = await checkA2(context(`${header}| A1 | DONE | command: python x.py; exit: 0 |  |`))
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /is not one of PASS\/FAIL\/NOT-RUN/)
})

test('A2 fails on a duplicate id', async () => {
  const out = await checkA2(
    context(`${header}| A1 | PASS | command: python x.py; exit: 0 |  |\n| A1 | PASS | command: python x.py; exit: 0 |  |`),
  )
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /duplicate ids/)
})

test('A2 fails when evidence lacks the command:/file: prefix', async () => {
  const out = await checkA2(context(`${header}| A1 | PASS | nope |  |`))
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /must start with "command:" or "file:"/)
})
// Step 5 replay gate, exercised offline by injecting runImpl (no config toggle,
// no plugin reload, no real child process).
import assert from 'node:assert/strict'
import test from 'node:test'

import { makeReplayCheck } from '../lib/index.js'

function context(rows, { remaining = 5, runImpl } = {}) {
  return {
    graphRoot: 'G',
    implRoot: 'I',
    slow: false,
    timeoutMs: 30000,
    checks: [],
    checklist: {
      path: 'checklist.md',
      provided: true,
      rows,
      duplicatedIds: [],
      uncovered: new Set(),
      hasUncoveredSection: true,
      errors: [],
    },
    preGraphHashes: {},
    specgraphHome: '',
    allowCommandReplay: true,
    replayBudget: { remaining },
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runArgv: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runImpl: runImpl ?? (async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    hashGraph: async () => ({}),
    newTempDir: async () => 'TMP',
  }
}

function row(id, evidence) {
  return { id, status: 'FAIL', evidence, reason: '' }
}

test('first token outside python/pnpm/node is NOT-RUN, never executed', async () => {
  let called = false
  const ctx = context(new Map([['M1', row('M1', 'command: rm -rf /; exit: 0')]]), {
    runImpl: async () => {
      called = true
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  const out = await makeReplayCheck('M1')(ctx)
  assert.equal(out.status, 'NOT-RUN')
  assert.equal(out.reason, 'EVIDENCE_TOKEN_UNSPECIFIED')
  assert.match(out.evidence, /first token not allowed/)
  assert.equal(called, false)
})

test('declared exit code different from the real one is FAIL', async () => {
  const ctx = context(new Map([['M2', row('M2', 'command: python -V; exit: 0')]]), {
    runImpl: async () => ({ exitCode: 3, stdout: '', stderr: 'boom' }),
  })
  const out = await makeReplayCheck('M2')(ctx)
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /run_again=3/)
})

test('timeout is FAIL with the timeout value in evidence', async () => {
  const ctx = context(new Map([['M3', row('M3', 'command: python slow.py; exit: 0')]]), {
    runImpl: async () => {
      const err = new Error('specgraph did not finish within 120000 ms')
      err.code = 'E_TIMEOUT'
      throw err
    },
  })
  const out = await makeReplayCheck('M3')(ctx)
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /timeout=120000ms/)
})

test('more than five replayable rows: first five run, the rest are marked skipped', async () => {
  const rows = new Map(
    Array.from({ length: 6 }, (_, index) => {
      const id = `Q${index + 5}`
      return [id, row(id, `command: python check.py ${index}; exit: 0`)]
    }),
  )
  let runs = 0
  const ctx = context(rows, {
    runImpl: async () => {
      runs += 1
      return { exitCode: 0, stdout: 'ok', stderr: '' }
    },
  })
  const statuses = []
  for (const id of rows.keys()) statuses.push(await makeReplayCheck(id)(ctx))
  assert.equal(runs, 5)
  assert.deepEqual(
    statuses.slice(0, 5).map((out) => out.status),
    ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
  )
  const last = statuses[5]
  assert.equal(last.status, 'NOT-RUN')
  assert.match(last.evidence, /skipped=replay_budget_exhausted limit=5/)
})
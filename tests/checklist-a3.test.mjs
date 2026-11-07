// A3 sampling: commands with <placeholders> must never be replayed.
import assert from 'node:assert/strict'
import test from 'node:test'

import { checkA3, parseChecklist } from '../lib/index.js'

function context(text, onRun) {
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
    runArgv: async (argv) => {
      onRun?.(argv)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    runImpl: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    hashGraph: async () => ({}),
    newTempDir: async () => 'TMP',
  }
}

const header = '| id | status | evidence | reason |\n|---|---|---|---|\n'

test('A3 skips commands that contain <placeholders>', async () => {
  let ran = 0
  const out = await checkA3(
    context(
      `${header}| A1 | PASS | command: python -m specgraph export 支付服务 --root <graphRoot> --out <tmp>; exit: 0 |  |`,
      () => {
        ran += 1
      },
    ),
  )
  assert.equal(out.status, 'PASS')
  assert.equal(ran, 0)
  assert.match(out.evidence, /placeholders_skipped=1/)
})

test('A3 still fails a command without exit: marker', async () => {
  const out = await checkA3(context(`${header}| A1 | PASS | command: python -m specgraph check . |  |`))
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /lacks exit: marker/)
})
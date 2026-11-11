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

test('A3 does not pass the exit: marker to the replayed command', async () => {
  let argv
  const out = await checkA3(
    context(`${header}| A1 | PASS | command: python -m specgraph check . exit:0 |  |`, (value) => {
      argv = value
    }),
  )
  assert.equal(out.status, 'PASS')
  assert.deepEqual(argv, ['python', '-m', 'specgraph', 'check', '.'])
})
test('A3 rejects file evidence past the end of an existing file', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'a3-file-'))
  writeFileSync(join(dir, 'SPEC.md'), '# a\n## b\n### c\n', 'utf8')
  const ctx = context(`${header}| A1 | PASS | file:SPEC.md:9 |  |`)
  ctx.implRoot = dir
  const out = await checkA3(ctx)
  assert.equal(out.status, 'FAIL')
  assert.match(out.evidence, /SPEC\.md:9 is past the end of the file \(3 lines\)/)
})

test('A3 accepts file evidence inside an existing file and skips missing files', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'a3-file-'))
  writeFileSync(join(dir, 'SPEC.md'), '# a\n## b\n### c\n', 'utf8')
  const inside = context(`${header}| A1 | PASS | file:SPEC.md:2 |  |`)
  inside.implRoot = dir
  assert.equal((await checkA3(inside)).status, 'PASS')
  const missing = context(`${header}| A1 | PASS | file:src/future.ts:10 |  |`)
  missing.implRoot = dir
  assert.equal((await checkA3(missing)).status, 'PASS')
})

// A typo in implRoot used to look like "nothing is implemented yet": the check
// silently dropped the implementation section. It has to be a root error.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runCheck } from '../lib/index.js'

const config = {
  specgraphCommand: 'python -m specgraph',
  pythonPath: '',
  specgraphCwd: '',
  timeoutMs: 30000,
  implRoot: '',
  slow: false,
  allowCommandReplay: false
}

test('an explicit implRoot that does not exist fails loudly', async () => {
  const graphRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-root-'))
  const missing = path.join(graphRoot, 'not-there')
  const result = await runCheck({ graphRoot, implRoot: missing }, { config })
  assert.equal(result.error?.code, 'E_ROOT_MISSING')
  assert.match(result.error?.message ?? '', /implRoot does not exist/)
})

test('omitting implRoot still falls back to graphRoot', async () => {
  const graphRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-root-'))
  const result = await runCheck({ graphRoot }, { config })
  // No plan/graph in the temp dir: the specgraph call fails, but not with a
  // missing-implRoot error.
  assert.notEqual(result.error?.code, 'E_ROOT_MISSING')
  assert.doesNotMatch(result.error?.message ?? '', /implRoot/)
})
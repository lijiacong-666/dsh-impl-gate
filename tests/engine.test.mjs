// The npm package ships a pinned copy of the specgraph engine under engine/.
// A fresh install must work with Python alone — no separate `pip install`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { bundledEngineHome, resolveSpecgraphEnv } from '../lib/index.js'

const root = path.resolve(import.meta.dirname, '..')

test('the package contains the bundled engine', () => {
  const init = path.join(root, 'engine', 'specgraph', '__init__.py')
  assert.equal(fs.existsSync(init), true, `missing ${init}`)
  assert.equal(fs.existsSync(path.join(root, 'engine', 'specgraph', 'checks.py')), true)
  assert.equal(bundledEngineHome(), path.join(root, 'engine'))
})

test('resolveSpecgraphEnv falls back to the bundled engine', () => {
  const env = resolveSpecgraphEnv({
    command: 'python -m specgraph',
    pythonPath: '',
    startDirs: [],
    env: { PATH: process.env.PATH ?? '' },
  })
  assert.equal(env.home, path.join(root, 'engine'))
  assert.ok(
    (env.env.PYTHONPATH ?? '').split(path.delimiter).includes(path.join(root, 'engine')),
    `PYTHONPATH did not point at the engine: ${env.env.PYTHONPATH ?? ''}`,
  )
  assert.ok(env.probed.some((entry) => entry.startsWith('bundled engine:')), 'probe trail missing')
})

test('an explicit home still wins over the bundled engine', () => {
  const env = resolveSpecgraphEnv({
    command: 'python -m specgraph',
    pythonPath: '',
    home: root,
    startDirs: [],
    env: { PATH: process.env.PATH ?? '' },
  })
  assert.equal(env.home, root)
})

test('python can import specgraph from the bundled engine', (t) => {
  const env = resolveSpecgraphEnv({
    command: 'python -m specgraph',
    pythonPath: '',
    startDirs: [],
    env: { PATH: process.env.PATH ?? '' },
  })
  const probe = spawnSync('python', ['-c', 'import specgraph; print(specgraph.__name__)'], {
    cwd: env.home,
    env: env.env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (probe.error !== undefined) {
    t.skip(`python is not available: ${probe.error.message}`)
    return
  }
  assert.equal(probe.status, 0, probe.stderr)
  assert.match(probe.stdout.trim(), /^specgraph$/)
})
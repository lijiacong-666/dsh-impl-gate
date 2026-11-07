import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  computeWaves,
  materializePlan,
  missingSlots,
  stripMeta,
  validatePlan,
  renderSpecDoc,
} from '../lib/index.js'

function basePlan(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'demo-app',
    title: '演示',
    summary: '一句话',
    stack: 'node22',
    goals: ['目标一'],
    nonGoals: ['不做实时推送'],
    boundaries: [{ dependency: 'node', purpose: '运行时', version: '22', fallback: '不启动' }],
    globals: { conventions: [], forbidden: [], envKeys: [] },
    data: [{ table: 'users', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] }],
    modules: [
      {
        id: 'M1',
        dir: 'shared',
        title: '共享',
        responsibility: '共享能力',
        exposes: [{ kind: 'fn', signature: 'Db' }],
        requires: [],
        constraints: ['无状态'],
        files: ['shared/db.ts'],
        acceptance: [{ id: 'a1', assertion: '能连', test: 'pnpm test' }],
      },
    ],
    deliverables: { tree: 'demo-app/', files: [{ path: 'shared/db.ts', purpose: '句柄' }] },
    ...overrides,
  }
}

test('missingSlots reports plan level and module level in one list', () => {
  const raw = {
    modules: [{ id: 'M1', exposes: [], constraints: [], files: [], acceptance: [] }],
  }
  const slots = missingSlots(raw)
  assert.equal(slots[0], 'plan: title, summary, stack, goals, data, deliverables')
  assert.equal(slots[1], 'M1: dir, responsibility, exposes, constraints, files, acceptance')
})

test('missingSlots reports modules slot when the array is empty', () => {
  assert.deepEqual(missingSlots({ title: 't', summary: 's', stack: 'x', goals: ['g'], data: [{}], deliverables: { tree: 't', files: [{}] }, modules: [] }), [
    'plan: modules（至少 1 个）',
  ])
})

test('_hint is ignored at every depth, including inside array elements', () => {
  const plan = basePlan()
  plan._hint = 'top'
  plan.modules[0]._hint = 'module'
  plan.modules[0].exposes[0]._hint = 'expose'
  plan.modules[0].acceptance[0]._hint = 'acceptance'
  const result = validatePlan(plan)
  assert.deepEqual(result.problems, [])
  assert.ok(result.plan !== null)
  const stripped = stripMeta(plan)
  assert.equal(stripped._hint, undefined)
  assert.equal(stripped.modules[0]._hint, undefined)
  assert.equal(stripped.modules[0].exposes[0]._hint, undefined)
  assert.equal(stripped.modules[0].acceptance[0]._hint, undefined)
  assert.equal(stripped.modules[0].exposes[0].signature, 'Db')
})

test('unmatched requires.item reports PLAN_INVALID with a JSON pointer', () => {
  const plan = basePlan({
    modules: [
      { ...basePlan().modules[0] },
      {
        id: 'M2',
        dir: 'api',
        title: 'API',
        responsibility: '接口',
        exposes: [{ kind: 'http', signature: 'getUser' }],
        requires: [{ module: 'M1', item: 'createUserX' }],
        constraints: ['只读'],
        files: ['api/get.ts'],
        acceptance: [{ id: 'a2', assertion: 'ok', test: 't' }],
      },
    ],
  })
  const result = validatePlan(plan)
  assert.equal(result.plan, null)
  const found = result.problems.find((entry) => entry.path === '/modules/1/requires/0/item')
  assert.ok(found !== undefined)
  assert.match(found.message, /createUserX/)
})

test('materialize refuses unregistered files before spawning specgraph', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-conflict-'))
  try {
    fs.writeFileSync(path.join(out, 'compose-plan.json'), JSON.stringify(basePlan()))
    fs.mkdirSync(path.join(out, 'demo-app'), { recursive: true })
    fs.writeFileSync(path.join(out, 'demo-app', 'stray.txt'), 'keep me')
    const result = await materializePlan(out, {
      specgraphCommand: 'python -m specgraph',
      pythonPath: 'definitely-not-a-real-python',
      specgraphCwd: '',
      timeoutMs: 1000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'EXPORT_REFUSED')
    assert.match(result.message, /demo-app\/stray\.txt/)
    assert.equal(fs.readFileSync(path.join(out, 'demo-app', 'stray.txt'), 'utf8'), 'keep me')
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('waves: chain of three modules gives three waves', () => {
  const plan = basePlan({
    modules: [
      basePlan().modules[0],
      { ...basePlan().modules[0], id: 'M2', dir: 'b', requires: [{ module: 'M1', item: 'Db' }], files: ['b/x.ts'] },
      { ...basePlan().modules[0], id: 'M3', dir: 'c', requires: [{ module: 'M2', item: 'Db' }], files: ['c/x.ts'] },
    ],
  })
  const result = computeWaves(plan)
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.waves.map((wave) => wave.modules), [['M1'], ['M2'], ['M3']])
})

test('waves: diamond puts the middle modules in the same wave', () => {
  const plan = basePlan({
    modules: [
      { ...basePlan().modules[0], id: 'M1', dir: 'base', files: ['base.ts'] },
      { ...basePlan().modules[0], id: 'M2', dir: 'left', requires: [{ module: 'M1', item: 'Db' }], files: ['left.ts'] },
      { ...basePlan().modules[0], id: 'M3', dir: 'right', requires: [{ module: 'M1', item: 'Db' }], files: ['right.ts'] },
      {
        ...basePlan().modules[0],
        id: 'M4',
        dir: 'top',
        requires: [
          { module: 'M2', item: 'Db' },
          { module: 'M3', item: 'Db' },
        ],
        files: ['top.ts'],
      },
    ],
  })
  const result = computeWaves(plan)
  assert.equal(result.ok, true)
  assert.deepEqual(result.result.waves.map((wave) => wave.modules), [['M1'], ['M2', 'M3'], ['M4']])
})

test('waves: a cycle returns PLAN_INVALID with the path', () => {
  const plan = basePlan({
    modules: [
      { ...basePlan().modules[0], id: 'M1', dir: 'a', requires: [{ module: 'M2', item: 'Db' }], files: ['a.ts'] },
      { ...basePlan().modules[0], id: 'M2', dir: 'b', requires: [{ module: 'M1', item: 'Db' }], files: ['b.ts'] },
    ],
  })
  const result = computeWaves(plan)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PLAN_INVALID')
  assert.match(result.message, /→/)
})

test('waves: file overlaps inside a wave are reported, not merged', () => {
  const plan = basePlan({
    modules: [
      { ...basePlan().modules[0], id: 'M1', dir: 'a', files: ['shared.ts'] },
      { ...basePlan().modules[0], id: 'M2', dir: 'b', files: ['shared.ts', 'b.ts'] },
    ],
  })
  const result = computeWaves(plan)
  assert.equal(result.ok, true)
  assert.equal(result.result.waves.length, 1)
  assert.deepEqual(result.result.overlaps, [{ a: 'M1', b: 'M2', files: ['shared.ts'] }])
})

test('spec doc: nine numbered sections in order, empty sections say （无）', () => {
  const plan = basePlan({ nonGoals: [], boundaries: [], data: [] })
  const waves = computeWaves(plan)
  assert.equal(waves.ok, true)
  const doc = renderSpecDoc({ plan, waves: waves.result })
  const headings = [...doc.matchAll(/^## (\d) (.+)$/gm)].map((match) => `${match[1]} ${match[2]}`)
  assert.deepEqual(headings, [
    '1 目标与非目标',
    '2 系统边界',
    '3 模块清单',
    '4 数据结构',
    '5 模块连线',
    '6 验收标准',
    '7 实施波次',
    '8 全局约定',
    '9 交付清单',
  ])
  assert.match(doc, /### 非目标\n（无）/)
  assert.match(doc, /### 4\.1 表\n\n（无）/)
  assert.match(doc, /### 4\.2 类型\n\n（无）/)
  assert.match(doc, /### 4\.3 错误码\n\n（无）/)
  assert.match(doc, /### 4\.4 接口面\n\n（无）/)
  assert.match(doc, /（无跨模块依赖）/)
})
const winOnly = process.platform === 'win32'

function writeFakePython(dir, lines) {
  const file = path.join(dir, 'fake-python.cmd')
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n')
  return file
}

function tempOut(plan) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-env-'))
  fs.writeFileSync(path.join(out, 'compose-plan.json'), JSON.stringify(plan))
  return out
}

function listing(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((entry) => String(entry).split(path.sep).join('/')).sort()
}

test('missing specgraph package is PYTHON_ENV_MISSING and writes nothing', { skip: !winOnly && 'fake python wrapper is cmd-only' }, async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-fakepy-'))
  const fake = writeFakePython(fakeDir, ['@echo off', 'echo No module named specgraph 1>&2', 'exit /b 1'])
  const out = tempOut(basePlan())
  const before = listing(out)
  try {
    const result = await materializePlan(out, {
      specgraphCommand: `cmd /d /c "${fake}" -m specgraph`,
      pythonPath: '',
      specgraphCwd: '',
      timeoutMs: 5000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PYTHON_ENV_MISSING')
    assert.match(result.message, /python cannot import specgraph; set PYTHONPATH to the spec-graph root or configure specgraphCwd \(probed: /)
    assert.deepEqual(listing(out), before)
  } finally {
    fs.rmSync(fakeDir, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('real python with PYTHONPATH materializes and writes the export package', async (t) => {
  const home = process.env.IMPL_GATE_SPECGRAPH_HOME ?? 'D:\\ruanjian\\deepharness\\spec-graph'
  if (!fs.existsSync(path.join(home, 'specgraph', '__init__.py'))) {
    t.skip(`no specgraph checkout at ${home}`)
    return
  }
  const probe = spawnSync('python', ['-c', 'import specgraph'], { env: { ...process.env, PYTHONPATH: home } })
  if (probe.status !== 0) {
    t.skip('host python cannot import specgraph even with PYTHONPATH')
    return
  }
  const out = tempOut(basePlan())
  try {
    const result = await materializePlan(out, {
      specgraphCommand: 'python -m specgraph',
      pythonPath: '',
      specgraphCwd: home,
      timeoutMs: 60000,
    })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    assert.ok(fs.existsSync(path.join(out, 'export', 'export.md')))
    assert.ok(fs.existsSync(path.join(out, 'export', 'manifest.json')))
    assert.ok(result.files.includes('export/export.md'))
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('non-JSON check failure is PYTHON_ENV_MISSING, not GRAPH_INVALID', { skip: !winOnly && 'fake python wrapper is cmd-only' }, async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-fakepy-'))
  const fake = writeFakePython(fakeDir, ['@echo off', 'if "%~1"=="-c" exit /b 0', 'echo No module named specgraph', 'exit /b 1'])
  const out = tempOut(basePlan())
  try {
    const result = await materializePlan(out, {
      specgraphCommand: `cmd /d /c "${fake}" -m specgraph`,
      pythonPath: '',
      specgraphCwd: '',
      timeoutMs: 5000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PYTHON_ENV_MISSING')
    assert.notEqual(result.code, 'GRAPH_INVALID')
  } finally {
    fs.rmSync(fakeDir, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('non-JSON export failure is PYTHON_ENV_MISSING', { skip: !winOnly && 'fake python wrapper is cmd-only' }, async () => {
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-fakepy-'))
  const fake = writeFakePython(fakeDir, [
    '@echo off',
    'if "%~1"=="-c" exit /b 0',
    'echo %* | findstr /C:" check " >nul',
    'if %errorlevel%==0 (',
    '  echo {"ok":true,"issues":[]}',
    '  exit /b 0',
    ')',
    'echo No module named specgraph',
    'exit /b 1',
  ])
  const out = tempOut(basePlan())
  try {
    const result = await materializePlan(out, {
      specgraphCommand: `cmd /d /c "${fake}" -m specgraph`,
      pythonPath: '',
      specgraphCwd: '',
      timeoutMs: 5000,
    })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'PYTHON_ENV_MISSING')
    assert.match(result.message, /export/)
  } finally {
    fs.rmSync(fakeDir, { recursive: true, force: true })
    fs.rmSync(out, { recursive: true, force: true })
  }
})

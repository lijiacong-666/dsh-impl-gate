import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { initTasks, renderTaskCard } from '../lib/index.js'

function moduleOf(partial) {
  return {
    exposes: [],
    requires: [],
    constraints: [],
    files: [],
    acceptance: [],
    ...partial,
  }
}

function makePlan(modules) {
  return {
    schemaVersion: 1,
    name: 'demo-app',
    title: '演示应用',
    summary: '一句话',
    stack: 'node22',
    goals: ['目标一'],
    nonGoals: ['不做实时推送'],
    boundaries: [{ dependency: 'node', purpose: '运行时', version: '22', fallback: '不启动' }],
    globals: { conventions: ['统一错误码'], forbidden: ['不引第三方 ORM'], envKeys: ['DATABASE_URL'] },
    data: [{ table: 'users', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] }],
    modules,
    deliverables: { tree: 'demo-app/', files: [{ path: 'src/index.ts', purpose: '入口' }] },
  }
}

function threeModules() {
  return [
    moduleOf({
      id: 'M1',
      dir: 'shared',
      title: '共享层',
      responsibility: '提供数据库句柄',
      exposes: [{ kind: 'fn', signature: 'Db', note: '数据库句柄' }],
      constraints: ['无状态'],
      files: ['src/db.ts', 'src/migrations/001_users.sql'],
      acceptance: [{ id: 'a1', assertion: '能连数据库', test: 'pnpm test db' }],
    }),
    moduleOf({
      id: 'M2',
      dir: 'user-service',
      title: '用户服务',
      responsibility: '维护用户记录',
      exposes: [{ kind: 'fn', signature: 'createUser' }],
      requires: [{ module: 'M1', item: 'Db', why: '读写用户表' }],
      constraints: ['只写自己的表'],
      files: ['src/user.ts'],
      acceptance: [{ id: 'a2', assertion: '能创建用户', test: 'pnpm test user' }],
    }),
    moduleOf({
      id: 'M3',
      dir: 'auth-api',
      title: '认证接口',
      responsibility: '登录与令牌',
      exposes: [{ kind: 'fn', signature: 'login' }],
      requires: [{ module: 'M2', item: 'createUser', why: '登录时懒创建' }],
      constraints: ['令牌十分钟过期'],
      files: ['src/auth.ts'],
      acceptance: [{ id: 'a3', assertion: '能登录', test: 'pnpm test auth' }],
    }),
  ]
}

function tempOut(plan) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-init-'))
  fs.writeFileSync(path.join(out, 'compose-plan.json'), JSON.stringify(plan))
  return out
}

function hashes(root) {
  const result = {}
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else result[path.relative(root, full).split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    }
  }
  walk(root)
  return result
}

test('three modules produce three waves, three cards, TASKS.md and cards.json', (t) => {
  const out = tempOut(makePlan(threeModules()))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const result = initTasks(out)
  assert.equal(result.ok, true, result.ok ? '' : result.error?.message)
  assert.deepEqual(result.waves.map((wave) => wave.modules), [['M1'], ['M2'], ['M3']])
  assert.deepEqual(result.cards, [
    { moduleId: 'M1', wave: 1, cardPath: 'wave-1/M1-shared.md' },
    { moduleId: 'M2', wave: 2, cardPath: 'wave-2/M2-user-service.md' },
    { moduleId: 'M3', wave: 3, cardPath: 'wave-3/M3-auth-api.md' },
  ])
  for (const relative of ['TASKS.md', 'cards.json', 'wave-1/M1-shared.md', 'wave-2/M2-user-service.md', 'wave-3/M3-auth-api.md']) {
    assert.ok(fs.statSync(path.join(out, 'tasks', ...relative.split('/'))).isFile(), `missing ${relative}`)
  }
  const cards = JSON.parse(fs.readFileSync(path.join(out, 'tasks', 'cards.json'), 'utf8'))
  assert.equal(cards.schemaVersion, 1)
  assert.equal(cards.planName, 'demo-app')
  assert.deepEqual(cards.waves.map((wave) => wave.index), [1, 2, 3])
  assert.deepEqual(Object.keys(cards), ['schemaVersion', 'planName', 'waves', 'overlaps'])
  assert.deepEqual(Object.keys(cards.waves[0].modules[0]), ['id', 'dir', 'title', 'cardPath', 'files'])
})

test('a card has the nine fixed sections in order and renders （无） for empty exposes', () => {
  const plan = makePlan(threeModules())
  const module = { ...plan.modules[2], exposes: [], requires: [] }
  const card = renderTaskCard(plan, module, { index: 3, modules: ['M3'], dependsOn: ['M2'] })
  const headings = [
    '## 1 你负责什么',
    '## 2 文件白名单',
    '## 3 你要提供的契约',
    '## 4 你依赖的契约',
    '## 5 约束',
    '## 6 验收断言',
    '## 7 完成标准',
    '## 8 回报格式',
    '## 9 禁止',
  ]
  let cursor = -1
  for (const heading of headings) {
    const index = card.indexOf(heading)
    assert.ok(index > cursor, `${heading} missing or out of order`)
    cursor = index
  }
  assert.ok(card.startsWith('# 认证接口（M3 · auth-api）'))
  assert.match(card, /## 3 你要提供的契约\n\n（无）\n\n本模块不对外提供契约/)
  assert.match(card, /## 4 你依赖的契约\n\n（无）\n\n本模块可独立开工/)
})

test('section 6 lists each AC with its plan id and acceptance command', (t) => {
  const out = tempOut(makePlan(threeModules()))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  assert.equal(initTasks(out).ok, true)
  const card = fs.readFileSync(path.join(out, 'tasks', 'wave-3', 'M3-auth-api.md'), 'utf8')
  assert.match(card, /\| 编号 \| 断言 \| 验收命令 \|/)
  assert.match(card, /\| a3 \| 能登录 \| `pnpm test auth` \|/)
})

test('section 4 resolves the provider signature from the plan', (t) => {
  const out = tempOut(makePlan(threeModules()))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  assert.equal(initTasks(out).ok, true)
  const card = fs.readFileSync(path.join(out, 'tasks', 'wave-3', 'M3-auth-api.md'), 'utf8')
  assert.match(card, /\| M2\/user-service \| createUser \| createUser \| 按签名调用，不要复制其实现 \|/)
})

test('same-wave file overlaps are called out in TASKS.md section 2', (t) => {
  const modules = [
    moduleOf({ id: 'M1', dir: 'a', title: 'A', responsibility: 'a', exposes: [{ kind: 'fn', signature: 'A' }], constraints: ['c1'], files: ['src/x.ts', 'src/migrations/001_users.sql'], acceptance: [{ id: 'a1', assertion: 'x', test: 't' }] }),
    moduleOf({ id: 'M2', dir: 'b', title: 'B', responsibility: 'b', exposes: [{ kind: 'fn', signature: 'B' }], constraints: ['c2'], files: ['src/x.ts'], acceptance: [{ id: 'a2', assertion: 'y', test: 't' }] }),
  ]
  const out = tempOut(makePlan(modules))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const result = initTasks(out)
  assert.equal(result.ok, true)
  assert.deepEqual(result.overlaps, [{ a: 'M1', b: 'M2', files: ['src/x.ts'] }])
  const tasks = fs.readFileSync(path.join(out, 'tasks', 'TASKS.md'), 'utf8')
  assert.match(tasks, /M1 与 M2 都写 src\/x\.ts —— 必须串行或拆分文件/)
})

test('a dependency cycle returns PLAN_HAS_CYCLE and writes nothing', (t) => {
  const modules = [
    moduleOf({ id: 'M1', dir: 'a', title: 'A', responsibility: 'a', exposes: [{ kind: 'fn', signature: 'A' }], requires: [{ module: 'M2', item: 'B' }], files: ['a.ts', 'src/migrations/001_users.sql'], acceptance: [{ id: 'a1', assertion: 'x', test: 't' }] }),
    moduleOf({ id: 'M2', dir: 'b', title: 'B', responsibility: 'b', exposes: [{ kind: 'fn', signature: 'B' }], requires: [{ module: 'M1', item: 'A' }], files: ['b.ts'], acceptance: [{ id: 'a2', assertion: 'y', test: 't' }] }),
  ]
  const out = tempOut(makePlan(modules))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const result = initTasks(out)
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'PLAN_HAS_CYCLE')
  assert.match(result.error?.message ?? '', /M1 → M2 → M1/)
  assert.equal(fs.existsSync(path.join(out, 'tasks')), false)
})

test('running twice with overwrite yields byte-identical files', (t) => {
  const out = tempOut(makePlan(threeModules()))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const first = initTasks(out)
  assert.equal(first.ok, true)
  const before = hashes(path.join(out, 'tasks'))
  const second = initTasks(out, { overwrite: true })
  assert.equal(second.ok, true)
  assert.deepEqual(hashes(path.join(out, 'tasks')), before)
})

test('the payload lists every written file exactly once', (t) => {
  const out = tempOut(makePlan(threeModules()))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  const result = initTasks(out)
  assert.equal(result.ok, true)
  const written = [...result.filesWritten].sort()
  const withinTasks = written.map((file) => file.replace(/^tasks\//, ''))
  assert.equal(new Set(written).size, written.length)
  assert.deepEqual(withinTasks, Object.keys(hashes(path.join(out, 'tasks'))).sort())
  assert.equal(result.cards.length, 3)
  for (const card of result.cards) {
    assert.equal(written.includes(`tasks/${card.cardPath}`), true)
    assert.equal(fs.existsSync(path.join(out, 'tasks', card.cardPath)), true)
  }
})

test('implRoot prefixes whitelist paths only when supplied', (t) => {
  const plan = makePlan(threeModules())
  const plain = tempOut(plan)
  const prefixed = tempOut(plan)
  t.after(() => {
    fs.rmSync(plain, { recursive: true, force: true })
    fs.rmSync(prefixed, { recursive: true, force: true })
  })
  assert.equal(initTasks(plain).ok, true)
  assert.equal(initTasks(prefixed, { implRoot: 'D:/work/app' }).ok, true)
  const plainCard = fs.readFileSync(path.join(plain, 'tasks', 'wave-2', 'M2-user-service.md'), 'utf8')
  const prefixedCard = fs.readFileSync(path.join(prefixed, 'tasks', 'wave-2', 'M2-user-service.md'), 'utf8')
  assert.match(plainCard, /^- src\/user\.ts$/m)
  assert.match(prefixedCard, /^- D:\/work\/app\/src\/user\.ts$/m)
  assert.match(plainCard, new RegExp(`以下路径相对 本任务包所在目录 ${plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}。`))
  assert.match(prefixedCard, /以下路径相对 D:\/work\/app。往 graphRoot 里写文件视为失败/)
  assert.match(plainCard, /不往 graphRoot 或 tasks\/ 目录里写实现代码/)
})

test('TASKS.md marks single-module waves 独立 and shared waves 可并行', (t) => {
  const single = tempOut(makePlan(threeModules()))
  const shared = tempOut(
    makePlan([
      moduleOf({ id: 'M1', dir: 'a', title: 'A', responsibility: 'a', exposes: [{ kind: 'fn', signature: 'A' }], constraints: ['c1'], files: ['a.ts', 'src/migrations/001_users.sql'], acceptance: [{ id: 'a1', assertion: 'x', test: 't' }] }),
      moduleOf({ id: 'M2', dir: 'b', title: 'B', responsibility: 'b', exposes: [{ kind: 'fn', signature: 'B' }], constraints: ['c2'], files: ['b.ts'], acceptance: [{ id: 'a2', assertion: 'y', test: 't' }] }),
    ]),
  )
  t.after(() => {
    fs.rmSync(single, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  })
  assert.equal(initTasks(single).ok, true)
  assert.equal(initTasks(shared).ok, true)
  const singleTasks = fs.readFileSync(path.join(single, 'tasks', 'TASKS.md'), 'utf8')
  const sharedTasks = fs.readFileSync(path.join(shared, 'tasks', 'TASKS.md'), 'utf8')
  assert.match(singleTasks, /波次 1：M1（独立）/)
  assert.match(singleTasks, /波次 3：M3（独立）/)
  assert.match(sharedTasks, /波次 1：M1、M2（可并行）/)
})
test('init accepts tasks/EVIDENCE.md left by impl_gate_record', (t) => {
  const out = tempOut(makePlan(threeModules()))
  t.after(() => fs.rmSync(out, { recursive: true, force: true }))
  assert.equal(initTasks(out).ok, true)
  const evidence = path.join(out, 'tasks', 'EVIDENCE.md')
  fs.writeFileSync(evidence, '# 实现证据\n\n| id | status |\n', 'utf8')
  const again = initTasks(out, { overwrite: true })
  assert.equal(again.ok, true)
  assert.equal(fs.existsSync(evidence), true)
})
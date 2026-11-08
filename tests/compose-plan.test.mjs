// G1: compose plan schema v1 + impl_gate_compose(mode:"plan").
// No specgraph process is spawned by any case here.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCompose, missingSlots, renderDraft, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'demo-app',
    title: 'Demo App',
    summary: '一个用于测试的最小系统。',
    stack: 'node22+fastify',
    goals: ['可以登录'],
    nonGoals: ['不做支付'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败并报错' }],
    globals: { conventions: ['错误统一用 code'], forbidden: ['禁止裸 SQL 拼接'], envKeys: ['DATABASE_URL'] },
    data: [{ table: 'users', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid', constraints: ['pk'] }], indexes: ['id'], notes: '用户表' }],
    types: [{ name: 'Order', kind: 'object', fields: [{ name: 'id', type: 'string' }] }],
    errors: [{ code: 'E_AUTH_REQUIRED', status: 401, when: '无会话', shape: '{"error":{"code","message"}}' }],
    http: [{ method: 'POST', path: '/login', module: 'M1', handler: 'login', res: 'Order' }],
    modules: [
      {
        id: 'M1',
        dir: 'auth',
        title: '登录入口',
        responsibility: '校验账号密码并签发会话',
        exposes: [{ kind: 'http', signature: 'login(account: string, password: string): Promise<Order>' }],
        requires: [],
        constraints: ['登录失败返回 401'],
        files: ['src/auth/api.ts', 'src/auth/migrations/001_users.sql'],
        acceptance: [{ id: 'AC-1', assertion: '错误密码返回 401', test: '集成测试' }],
      },
      {
        id: 'M2',
        dir: 'orders',
        title: '订单列表',
        responsibility: '按用户返回订单',
        exposes: [{ kind: 'fn', signature: 'listOrders(userId): Order[]', note: '按用户列出订单' }],
        requires: [{ module: 'M1', item: 'login(account: string, password: string): Promise<Order>', why: '需要已登录会话' }],
        constraints: ['无会话返回 401'],
        files: ['src/orders/api.ts'],
        acceptance: [{ id: 'AC-2', assertion: '无会话时返回 401', test: '集成测试' }],
      },
    ],
    deliverables: { tree: 'src/', files: [{ path: 'src/index.ts', purpose: '进程入口' }] },
  }
}

function problemsOf(plan) {
  return validatePlan(plan).problems
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-compose-'))
}

test('a legal plan validates with zero problems', () => {
  assert.deepEqual(problemsOf(basePlan()), [])
})

test('modules is required and non-empty', () => {
  const plan = basePlan()
  delete plan.modules
  assert.ok(problemsOf(plan).some((item) => item.path === '/modules'))
})

test('module ids must match ^M<digits>$', () => {
  const plan = basePlan()
  plan.modules[0].id = 'AUTH'
  assert.ok(problemsOf(plan).some((item) => item.path === '/modules/0/id' && /M\[0-9\]/.test(item.message)))
})

test('requires.module must name an existing module', () => {
  const plan = basePlan()
  plan.modules[1].requires[0].module = 'M9'
  const problems = problemsOf(plan)
  assert.ok(problems.some((item) => item.path === '/modules/1/requires/0/module'))
})

test('dependency cycles report the id sequence', () => {
  const plan = basePlan()
  plan.modules[0].requires = [{ module: 'M2', item: 'listOrders(userId): Order[]' }]
  const problems = problemsOf(plan)
  const cycle = problems.find((item) => item.message.startsWith('dependency cycle:'))
  assert.ok(cycle, JSON.stringify(problems))
  assert.match(cycle.message, /M1 → M2 → M1/)
})

test('requires.item must match an exposes signature or note exactly', () => {
  const plan = basePlan()
  plan.modules[1].requires[0].item = 'POST /sign-in'
  assert.ok(problemsOf(plan).some((item) => item.path === '/modules/1/requires/0/item'))
})

test('module files must be relative and free of ".."', () => {
  const absolute = basePlan()
  absolute.modules[0].files = ['C:\\tmp\\api.ts']
  assert.ok(problemsOf(absolute).some((item) => item.path === '/modules/0/files/0'))

  const escaping = basePlan()
  escaping.modules[0].files = ['../outside.ts']
  assert.ok(problemsOf(escaping).some((item) => item.path === '/modules/0/files/0'))
})

test('acceptance ids are unique across all modules', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].id = 'AC-1'
  assert.ok(problemsOf(plan).some((item) => item.path === '/modules/1/acceptance/0/id'))
})

test('data and deliverables must not be empty', () => {
  const noData = basePlan()
  noData.data = []
  assert.ok(problemsOf(noData).some((item) => item.path === '/data'))

  const noFiles = basePlan()
  noFiles.deliverables.files = []
  assert.ok(problemsOf(noFiles).some((item) => item.path === '/deliverables/files'))
})

test('unknown fields are rejected (schema v1 is fixed)', () => {
  const plan = basePlan()
  plan.extra = true
  assert.ok(problemsOf(plan).some((item) => item.path === '/extra'))
})

test('mode plan writes the template and the draft, and nothing else', async () => {
  const outDir = tempDir()
  const result = await buildCompose({ outDir, mode: 'plan', requirement: '做一个登录系统', name: 'demo-app' })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'plan')
  assert.equal(result.planPath, path.join(outDir, 'compose-plan.json'))
  assert.equal(result.draftPath, path.join(outDir, 'SPEC-DRAFT.md'))
  assert.deepEqual(result.missingSlots, [
    'plan: title, summary, stack, goals, data, deliverables',
    'M1: dir, responsibility, exposes, constraints, files, acceptance',
  ])
  assert.ok(fs.existsSync(result.planPath))
  assert.ok(fs.existsSync(result.draftPath))
  assert.ok(!fs.existsSync(path.join(outDir, 'spec.md')))
  assert.ok(!fs.existsSync(path.join(outDir, 'graph.toml')))
  assert.deepEqual(fs.readdirSync(outDir).sort(), ['SPEC-DRAFT.md', 'compose-plan.json'])
})

test('draft covers all nine sections and every module', async () => {
  const outDir = tempDir()
  const result = await buildCompose({ outDir, mode: 'plan' })
  const draft = fs.readFileSync(result.draftPath, 'utf8')
  for (const heading of [
    '## 1 目标与非目标',
    '## 2 系统边界',
    '## 3 模块清单',
    '## 4 数据结构',
    '## 5 模块连线',
    '## 6 验收标准',
    '## 7 实施波次',
    '## 8 全局约定',
    '## 9 交付清单',
  ]) {
    assert.ok(draft.includes(heading), `missing ${heading}`)
  }
  assert.ok(draft.includes('### M1'))
  assert.ok(draft.includes('<!-- TODO: exposes -->'))
  assert.ok(draft.includes('本文件由 impl_gate_compose 生成'))
})

test('a non-empty outDir needs overwrite:true', async () => {
  const outDir = tempDir()
  fs.writeFileSync(path.join(outDir, 'keep.txt'), 'x')
  const refused = await buildCompose({ outDir, mode: 'plan' })
  assert.equal(refused.error.code, 'E_OUT_DIR_NOT_EMPTY')

  const allowed = await buildCompose({ outDir, mode: 'plan', overwrite: true })
  assert.equal(allowed.ok, true)
  assert.ok(fs.existsSync(path.join(outDir, 'keep.txt')))
})

test('materialize without a compose-plan.json returns E_PLAN_MISSING', async () => {
  const result = await buildCompose({ outDir: tempDir(), mode: 'materialize' })
  assert.equal(result.error.code, 'E_PLAN_MISSING')
})

test('missingSlots reflects a partially filled module', () => {
  const plan = basePlan()
  plan.modules[0].exposes = []
  plan.modules[0].acceptance = []
  assert.deepEqual(missingSlots(plan), ['M1: exposes, acceptance'])
})

test('renderDraft is deterministic for the same input', () => {
  const plan = basePlan()
  assert.equal(renderDraft({ plan }), renderDraft({ plan }))
})
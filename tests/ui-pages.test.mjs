// flows[]: cross-module call order (who calls whom, in what sequence).
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeWaves, renderSpecDoc, renderTaskCard, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'flow-demo',
    title: '流程示例',
    summary: 's',
    stack: 'node22+postgres16',
    goals: ['登录'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DATABASE_URL'] },
    data: [
      { table: 'users', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] },
    ],
    errors: [
      { code: 'E_AUTH_INVALID', status: 401, when: '密码错', shape: '{"error":{"code","message"}}', by: 'M2' },
    ],
    http: [
      { method: 'POST', path: '/auth/login', module: 'M3', handler: 'login', req: 'LoginInput', res: 'TokenPair', auth: 'public' },
    ],
    types: [
      { name: 'User', kind: 'object', fields: [{ name: 'id', type: 'string' }] },
      { name: 'LoginInput', kind: 'object', fields: [{ name: 'account', type: 'string' }] },
      { name: 'TokenPair', kind: 'object', fields: [{ name: 'token', type: 'string' }] },
    ],
    modules: [
      {
        id: 'M1',
        dir: 'users',
        title: '用户',
        responsibility: '读写用户',
        exposes: [{ kind: 'fn', signature: 'findUser(account: string): Promise<User | null>' }],
        requires: [],
        constraints: ['按 account 唯一'],
        files: ['users/find.ts', 'users/migrations/001_users.sql'],
        acceptance: [{ id: 'a1', assertion: '能按 account 查到', test: 'pnpm test' }],
      },
      {
        id: 'M2',
        dir: 'auth',
        title: '鉴权',
        responsibility: '校验密码',
        exposes: [{ kind: 'fn', signature: 'verifyPassword(account: string, password: string): Promise<boolean>' }],
        requires: [{ module: 'M1', item: 'findUser(account: string): Promise<User | null>' }],
        constraints: ['失败抛 E_AUTH_INVALID'],
        files: ['auth/verify.ts'],
        acceptance: [{ id: 'a2', assertion: '密码错抛 E_AUTH_INVALID', test: 'pnpm test' }],
      },
      {
        id: 'M3',
        dir: 'api',
        title: '接口',
        responsibility: '编排登录',
        exposes: [{ kind: 'http', signature: 'login(input: LoginInput): Promise<TokenPair>' }],
        requires: [{ module: 'M2', item: 'verifyPassword(account: string, password: string): Promise<boolean>' }],
        constraints: ['不自己校验密码'],
        files: ['api/login.ts'],
        acceptance: [{ id: 'a3', assertion: '登录成功返回 TokenPair', test: 'pnpm test' }],
      },
    ],
    flows: [
      {
        id: 'F1',
        name: '账号密码登录',
        trigger: 'POST /auth/login',
        steps: [
          { module: 'M3', action: 'login' },
          { module: 'M1', action: 'findUser', note: '查不到按同一错误码处理' },
          { module: 'M2', action: 'verifyPassword' },
        ],
        success: '返回 TokenPair',
        failure: ['E_AUTH_INVALID'],
      },
    ],
    deliverables: { tree: 'api/', files: [{ path: 'api/login.ts', purpose: '登录路由' }] },
  }
}

const problemsOf = (plan) => validatePlan(plan).problems.map((entry) => `${entry.path}: ${entry.message}`)

function withUi(extra) {
  const plan = basePlan()
  plan.ui = [extra]
  return plan
}

test('ui[] renders section 10 with owner, route and calls', () => {
  const plan = withUi({
    id: 'P1',
    title: '登录页',
    route: '/login',
    module: 'M3',
    shows: ['账号输入框', '密码输入框', '登录按钮'],
    calls: ['POST /auth/login'],
    states: { empty: '—', error: '表单上方显示错误文案' },
  })
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /## 10 界面（页面级）/)
  assert.match(doc, /P1 登录页/)
  assert.match(doc, /POST \/auth\/login/)
  assert.match(doc, /错误态：表单上方显示错误文案/)
})

test('ui[] rejects a call to an undeclared route', () => {
  const plan = withUi({ id: 'P1', title: 'x', route: '/x', module: 'M3', shows: ['a'], calls: ['POST /nope'] })
  assert.ok(validatePlan(plan).problems.map((entry) => entry.path + ' ' + entry.message).some((line) => line.includes('/ui/0/calls/0') && line.includes('undeclared route')))
})

test('ui[] rejects an unknown module and a duplicate id', () => {
  const plan = basePlan()
  plan.ui = [
    { id: 'P1', title: 'a', route: '/a', module: 'M9', shows: ['x'], calls: [] },
    { id: 'P1', title: 'b', route: '/b', module: 'M3', shows: ['y'], calls: [] },
  ]
  const lines = validatePlan(plan).problems.map((entry) => entry.path + ' ' + entry.message)
  assert.ok(lines.some((line) => line.includes('/ui/0/module') && line.includes('does not exist')))
  assert.ok(lines.some((line) => line.includes('/ui/1/id') && line.includes('duplicate')))
})

test('task card lists the pages a module owns', () => {
  const plan = withUi({ id: 'P1', title: '登录页', route: '/login', module: 'M3', shows: ['账号'], calls: ['POST /auth/login'] })
  const card = renderTaskCard(plan, plan.modules[2], computeWaves(plan).result.waves[2])
  assert.match(card, /### 4.3 你负责的页面/)
  assert.match(card, /`P1` 登录页/)
})

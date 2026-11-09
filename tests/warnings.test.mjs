// flows[]: cross-module call order (who calls whom, in what sequence).
import assert from 'node:assert/strict'
import test from 'node:test'

import { collectWarnings, computeWaves, renderSpecDoc, renderTaskCard, validatePlan } from '../lib/index.js'

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

test('an error code nobody references is reported as unused', () => {
  const plan = basePlan()
  plan.errors = [
    { code: 'E_USED', status: 401, when: '密码错', shape: '{"error":{"code"}}', by: 'M2' },
    { code: 'E_ORPHAN', status: 500, when: '没人用', shape: '{"error":{"code"}}', by: 'M2' },
  ]
  plan.modules[1].constraints = ['失败抛 E_USED']
  const codes = collectWarnings(plan).filter((entry) => entry.code === 'ERROR_UNUSED')
  assert.equal(codes.length, 1)
  assert.deepEqual(codes[0].items, ['E_ORPHAN'])
})

test('referencing the code in a flow failure also counts', () => {
  const plan = basePlan()
  plan.errors = [{ code: 'E_FLOW', status: 500, when: 'x', shape: '{"error":{"code"}}', by: 'M2' }]
  plan.flows = [{ id: 'F1', name: 'f', trigger: 'POST /auth/login', steps: [{ module: 'M3', action: 'login' }], success: 'ok', failure: ['E_FLOW'] }]
  assert.equal(collectWarnings(plan).filter((entry) => entry.code === 'ERROR_UNUSED').length, 0)
})

test('two modules claiming the same file is reported', () => {
  const plan = basePlan()
  plan.modules[0].files.push('shared/schema.sql')
  plan.modules[1].files.push('Shared/Schema.sql')
  const warnings = collectWarnings(plan)
  const clash = warnings.find((entry) => entry.code === 'FILE_OWNERSHIP_OVERLAP')
  assert.ok(clash !== undefined)
  assert.equal(clash.count, 1)
  assert.match(clash.items[0], /^shared\/schema\.sql ← M1, M2$/)
})

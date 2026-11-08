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

test('a valid flow passes and is rendered under 5.1', () => {
  const plan = basePlan()
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /### 5\.1 关键流程（时序）/)
  assert.match(doc, /#### F1 账号密码登录/)
  assert.match(doc, /1\. `api`：login/)
  assert.match(doc, /2\. `users`：findUser　— 查不到按同一错误码处理/)
  assert.match(doc, /3\. `auth`：verifyPassword/)
  assert.match(doc, /- 失败可能：E_AUTH_INVALID/)
})

test('an unknown module in a flow is a plan problem', () => {
  const plan = basePlan()
  plan.flows[0].steps[1].module = 'M9'
  const problems = problemsOf(plan)
  assert.ok(problems.some((entry) => entry.includes('/flows/0/steps/1/module') && entry.includes('module "M9" does not exist')))
})

test('an action that matches no signature is a plan problem', () => {
  const plan = basePlan()
  plan.flows[0].steps[2].action = 'checkPassword'
  const problems = problemsOf(plan)
  assert.ok(
    problems.some(
      (entry) => entry.includes('/flows/0/steps/2/action') && entry.includes('does not match the leading identifier'),
    ),
  )
})

test('a flow may only surface declared error codes', () => {
  const plan = basePlan()
  plan.flows[0].failure = ['E_NOT_DECLARED']
  const problems = problemsOf(plan)
  assert.ok(problems.some((entry) => entry.includes('/flows/0/failure/0') && entry.includes('is not declared in errors')))
})

test('flow ids must be F<n> and unique', () => {
  const plan = basePlan()
  plan.flows[0].id = 'flow-1'
  plan.flows.push({ ...plan.flows[0], id: 'flow-1' })
  const problems = problemsOf(plan)
  assert.ok(problems.some((entry) => entry.includes('/flows/0/id') && entry.includes('^F[0-9]{1,2}$')))
})

test('a task card says where the module sits in the flow', () => {
  const plan = basePlan()
  const card = renderTaskCard(plan, plan.modules[1], computeWaves(plan).result.waves[1])
  assert.match(card, /### 4\.2 你在流程中的位置/)
  assert.match(card, /`F1` 账号密码登录：第 3\/3 步/)
})
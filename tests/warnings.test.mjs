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

test('a concrete path inside a constraint is flagged before the graph check', () => {
  const plan = basePlan()
  plan.modules[0].constraints.push('样式放在 public/styles.css 里')
  const warnings = collectWarnings(plan)
  const hit = warnings.find((entry) => entry.code === 'CONSTRAINT_HAS_PATH')
  assert.ok(hit !== undefined)
  assert.equal(hit.count, 1)
  assert.match(hit.items[0], /^M1: .*public\/styles\.css/)
})

test('an http assertion on a module without routes is flagged', () => {
  const plan = basePlan()
  plan.modules[0].acceptance.push({ id: 'M1-http', assertion: 'POST /auth/login 返回 200', covers: 'G1' })
  const warnings = collectWarnings(plan)
  const hit = warnings.find((entry) => entry.code === 'AC_HTTP_OUTSIDE_SHELL')
  assert.ok(hit !== undefined)
  assert.deepEqual(hit.items, ['M1: M1-http'])
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

test('a bare filename in a constraint is not a hard-coded path', () => {
  const plan = {
    modules: [
      { id: 'M1', constraints: ['app.js 以 <script type="module"> 引入'], acceptance: [] },
      { id: 'M2', constraints: ['样式写在 public/styles.css 里'], acceptance: [] },
    ],
    http: [],
  }
  const pathWarnings = collectWarnings(plan).filter((warning) => warning.code === 'CONSTRAINT_HAS_PATH')
  assert.equal(pathWarnings.length, 1)
  assert.match(pathWarnings[0].items[0], /public\/styles\.css/)
})

test('a route mentioned after prose is still counted as asserted', () => {
  const plan = {
    modules: [
      {
        id: 'M2',
        constraints: [],
        acceptance: [
          { id: 'AC-M2-1', assertion: 'GET/PATCH/DELETE 一个不存在的 id 都返回 404；DELETE 成功后该条从列表消失（DELETE /api/runs/:id 生效）' },
        ],
      },
    ],
    http: [{ method: 'DELETE', path: '/api/runs/:id', module: 'M2', handler: 'deleteRun', auth: 'session' }],
  }
  const codes = collectWarnings(plan).map((warning) => warning.code)
  assert.equal(codes.includes('HTTP_ROUTE_UNCOVERED'), false)
})
test('an HTTP AC in a wave before the shell is reported as AC_SHELL_LATER', () => {
  const plan = {
    modules: [
      {
        id: 'M1',
        wave: 1,
        requires: [],
        constraints: [],
        files: [],
        acceptance: [{ id: 'AC-M1-1', assertion: 'POST /api/runs 返回 201' }],
      },
      {
        id: 'M2',
        requires: [{ module: 'M1', item: 'doWork', note: '调用 M1' }],
        constraints: [],
        files: ['app.ts', 'server.ts'],
        exposes: [{ kind: 'fn', signature: 'buildServer(): Promise<unknown>' }],
        acceptance: [{ id: 'AC-M2-1', assertion: '起服务后健康检查 200' }],
      },
    ],
    http: [{ method: 'POST', path: '/api/runs', module: 'M1', handler: 'createRun', auth: 'public' }],
  }
  const warning = collectWarnings(plan).find((entry) => entry.code === 'AC_SHELL_LATER')
  assert.ok(warning)
  assert.deepEqual(warning.items, ['M1: AC-M1-1 runs in wave 1, shell M2 is wave 2'])
})
test('mutating routes without an explicit status are reported', () => {
  const plan = {
    modules: [{ id: 'M1', constraints: [], acceptance: [] }],
    http: [
      { method: 'POST', path: '/things', module: 'M1', handler: 'createThing', auth: 'public' },
      { method: 'GET', path: '/things', module: 'M1', handler: 'listThings', auth: 'public' },
      { method: 'DELETE', path: '/things/:id', module: 'M1', handler: 'deleteThing', auth: 'public', status: 204, res: 'void' },
    ],
  }
  const warning = collectWarnings(plan).find((entry) => entry.code === 'STATUS_DEFAULTED')
  assert.ok(warning)
  assert.deepEqual(warning.items, ['POST /things'])
})

test('a list response with no declared order is reported', () => {
  const plan = {
    modules: [{ id: 'M1', constraints: [], acceptance: [] }],
    types: [{ name: 'ThingPage', kind: 'object', fields: [{ name: 'items', type: 'Thing[]' }] }],
    http: [
      { method: 'GET', path: '/things', module: 'M1', handler: 'listThings', auth: 'public', res: 'ThingPage', status: 200 },
      { method: 'GET', path: '/things/sorted', module: 'M1', handler: 'listSorted', auth: 'public', res: 'ThingPage', status: 200, query: [{ name: 'orderBy', type: 'string' }] },
    ],
  }
  const warning = collectWarnings(plan).find((entry) => entry.code === 'LIST_ORDER_UNDEFINED')
  assert.ok(warning)
  assert.deepEqual(warning.items, ['GET /things → ThingPage'])
})

test('an all-nullable PATCH request type is reported', () => {
  const plan = {
    modules: [{ id: 'M1', constraints: [], acceptance: [] }],
    types: [
      { name: 'ThingPatch', kind: 'object', fields: [{ name: 'name', type: 'string | null' }, { name: 'note', type: 'string | null' }] },
      { name: 'OtherPatch', kind: 'object', fields: [{ name: 'name', type: 'string' }] },
    ],
    http: [
      { method: 'PATCH', path: '/things/:id', module: 'M1', handler: 'updateThing', auth: 'public', req: 'ThingPatch', status: 200 },
      { method: 'PATCH', path: '/others/:id', module: 'M1', handler: 'updateOther', auth: 'public', req: 'OtherPatch', status: 200 },
    ],
  }
  const warning = collectWarnings(plan).find((entry) => entry.code === 'PATCH_NULLABLE_AMBIGUOUS')
  assert.ok(warning)
  assert.deepEqual(warning.items, ['ThingPatch'])
})
test('BOUNDARY_UNUSED flags a declared dependency nobody else mentions', () => {
  const plan = basePlan()
  plan.boundaries = [{ dependency: 'redis', purpose: '缓存', version: '7', fallback: '降级为进程内缓存' }]
  const warning = collectWarnings(plan).find((entry) => entry.code === 'BOUNDARY_UNUSED')
  assert.ok(warning)
  assert.deepEqual(warning.items, ['redis'])
})

test('WRITE_NO_VALIDATION_ERROR flags a write route whose module declares no 4xx', () => {
  const plan = basePlan()
  const warning = collectWarnings(plan).find((entry) => entry.code === 'WRITE_NO_VALIDATION_ERROR')
  assert.ok(warning)
  assert.ok(warning.items.some((item) => item.startsWith('POST /auth/login')))
})
test('TYPE_OWNER_NO_SOURCE flags an owner whose files are all non-source', () => {
  const plan = basePlan()
  plan.types[0] = { ...plan.types[0], owner: 'M1' }
  plan.modules[0].files = ['users/migrations/001_users.sql']
  const warning = collectWarnings(plan).find((entry) => entry.code === 'TYPE_OWNER_NO_SOURCE')
  assert.ok(warning)
  assert.deepEqual(warning.items, ['User → M1'])
})
test('IN_MEMORY_VS_TABLE flags a table writer whose prose says in-memory', () => {
  const plan = basePlan()
  plan.modules[0].responsibility = '在内存 Map 里存用户'
  const warning = collectWarnings(plan).find((entry) => entry.code === 'IN_MEMORY_VS_TABLE')
  assert.ok(warning)
  assert.ok(warning.items.some((item) => item.endsWith('← M1')))
})
test('HTTP_ROUTE_UNCOVERED is silenced when a flow step calls the route', () => {
  const plan = basePlan()
  for (const module of plan.modules) {
    module.acceptance = (module.acceptance ?? []).map((item) => ({ ...item, assertion: '单元级断言，不涉及路由' }))
  }
  plan.flows = []
  const before = collectWarnings(plan).find((entry) => entry.code === 'HTTP_ROUTE_UNCOVERED')
  assert.ok(before, 'precondition: route starts uncovered')
  plan.flows = [
    { id: 'F1', name: '登录', trigger: '用户提交', success: '拿到 token', steps: [{ module: 'M3', action: 'login' }] },
  ]
  const after = collectWarnings(plan).find((entry) => entry.code === 'HTTP_ROUTE_UNCOVERED')
  assert.equal(after, undefined)
})
test('BOUNDARY_UNUSED ignores runtimes and standards', () => {
  const plan = basePlan()
  plan.boundaries = [
    { dependency: 'Node.js', purpose: '运行时', version: '22', fallback: '—' },
    { dependency: '现代浏览器的 fetch', purpose: '浏览器能力', version: '—', fallback: '—' },
  ]
  const warning = collectWarnings(plan).find((entry) => entry.code === 'BOUNDARY_UNUSED')
  assert.equal(warning, undefined)
})
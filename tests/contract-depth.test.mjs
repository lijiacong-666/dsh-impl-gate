// G4: typed contracts, an error catalog and an HTTP surface are now part of
// the plan contract. These tests pin both the rejections and the rendering.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  computeWaves,
  renderSpecDoc,
  renderTaskCard,
  validatePlan,
} from '../lib/index.js'

const root = path.resolve(import.meta.dirname, '..')

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'demo-app',
    title: '演示',
    summary: '一个登录演示',
    stack: 'node22',
    goals: ['成员能登录'],
    nonGoals: ['不做注册'],
    boundaries: [{ dependency: 'pg', purpose: '存储成员', fallback: '启动失败退出' }],
    globals: { conventions: ['时间用 UTC'], forbidden: ['明文密码'], envKeys: ['DATABASE_URL'] },
    data: [{ table: 'members', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] }],
    types: [
      { name: 'Member', kind: 'object', fields: [{ name: 'id', type: 'string' }] },
      {
        name: 'LoginInput',
        kind: 'object',
        fields: [
          { name: 'account', type: 'string' },
          { name: 'password', type: 'string' },
        ],
      },
      { name: 'TokenPair', kind: 'object', fields: [{ name: 'accessToken', type: 'string' }] },
      { name: 'Role', kind: 'enum', values: ['admin', 'member'] },
      { name: 'Pool', kind: 'external', source: 'pg' },
    ],
    errors: [
      { code: 'E_AUTH_INVALID', status: 401, when: '账号或密码错误', shape: '{"error":{"code","message"}}' },
    ],
    http: [{ method: 'POST', path: '/login', module: 'M1', handler: 'login', req: 'LoginInput', res: 'TokenPair' }],
    modules: [
      {
        id: 'M1',
        dir: 'auth',
        title: '认证',
        responsibility: '校验凭据并签发令牌',
        exposes: [
          { kind: 'http', signature: 'login(input: LoginInput): Promise<TokenPair>' },
          { kind: 'fn', signature: 'verify(password: string): Promise<Member>' },
        ],
        requires: [],
        constraints: ['账号或密码错误时返回 E_AUTH_INVALID'],
        files: ['auth/login.ts'],
        acceptance: [
          { id: 'a1', assertion: '错误密码返回 E_AUTH_INVALID', test: 'pnpm test auth', covers: 'G1' },
        ],
      },
    ],
    deliverables: { tree: 'demo-app/', files: [{ path: 'auth/login.ts', purpose: '登录' }] },
    openQuestions: ['是否需要刷新令牌'],
  }
}

function problemsOf(plan) {
  return validatePlan(plan).problems
}

function messagesOf(plan) {
  return problemsOf(plan).map((problem) => problem.message)
}

function renderDoc(plan) {
  const waves = computeWaves(plan)
  assert.equal(waves.ok, true)
  return renderSpecDoc({ plan, waves: waves.result })
}

test('blind-1 reports every undefined type reference in one pass', () => {
  const blind = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'blind-1.plan.json'), 'utf8'))
  const problems = problemsOf(blind)
  assert.equal(validatePlan(blind).plan, null)
  const names = problems
    .map((problem) => /undefined type reference "([^"]+)"/.exec(problem.message)?.[1])
    .filter((name) => name !== undefined)
  const expected = [
    'Pool',
    'CreateBookmarkInput',
    'Bookmark',
    'BookmarkFilter',
    'ChromeBookmark',
    'ImportReport',
    'SearchHit',
    'IndexStats',
    'Favorite',
    'FastifyInstance',
    'BookmarkDeps',
    'ImportDeps',
    'SearchDeps',
    'FavoriteDeps',
    'ServerConfig',
    'ServerHandle',
  ]
  assert.deepEqual([...names].sort(), [...expected].sort())
  assert.equal(new Set(names).size, names.length, 'each type is reported once')
})

test('built-in generics pass; a type named Pool must still be declared', () => {
  const ok = basePlan()
  ok.modules[0].exposes.push({ kind: 'fn', signature: 'open(): Promise<Pool>' })
  assert.deepEqual(problemsOf(ok), [])

  const bad = basePlan()
  bad.types = bad.types.filter((type) => type.name !== 'Pool')
  bad.modules[0].exposes.push({ kind: 'fn', signature: 'open(): Promise<Pool>' })
  assert.ok(messagesOf(bad).some((message) => message.includes('undefined type reference "Pool"')))
})

test('an E_ code used in a constraint must exist in errors, with a pointer', () => {
  const plan = basePlan()
  plan.modules[0].constraints.push('令牌过期返回 E_TOKEN_EXPIRED')
  const problem = problemsOf(plan).find((entry) => entry.message.includes('E_TOKEN_EXPIRED'))
  assert.notEqual(problem, undefined)
  assert.equal(problem.path, '/modules/0/constraints/1')
  assert.match(problem.message, /undefined error code "E_TOKEN_EXPIRED"/)
})

test('duplicate error codes are rejected', () => {
  const plan = basePlan()
  plan.errors.push({ code: 'E_AUTH_INVALID', status: 403, when: '重复' })
  assert.ok(messagesOf(plan).some((message) => message.includes('duplicate error code "E_AUTH_INVALID"')))
})

test('http.handler must be the leading identifier of an http signature', () => {
  const plan = basePlan()
  plan.http[0].handler = 'logout'
  assert.ok(messagesOf(plan).some((message) => message.includes('handler "logout"')))
})

test('the same method+path cannot appear twice', () => {
  const plan = basePlan()
  plan.http.push({ method: 'POST', path: '/login', module: 'M1', handler: 'login', res: 'TokenPair' })
  assert.ok(messagesOf(plan).some((message) => message.includes('duplicate route "POST /login"')))
})

test('http req/res must name a declared type', () => {
  const plan = basePlan()
  plan.http[0].res = 'Session'
  assert.ok(messagesOf(plan).some((message) => message.includes('undefined type reference "Session"')))
})

test('every table names an existing owner module', () => {
  const plan = basePlan()
  plan.data[0].owner = 'M9'
  const problem = problemsOf(plan).find((entry) => entry.path === '/data/0/owner')
  assert.equal(problem.message, 'owner "M9" is not a module id')

  const missing = basePlan()
  delete missing.data[0].owner
  assert.ok(messagesOf(missing).some((message) => message.includes('must be a non-empty string')))
})

test('acceptance covers must point inside the goals range', () => {
  const plan = basePlan()
  plan.modules[0].acceptance[0].covers = 'G2'
  assert.ok(messagesOf(plan).some((message) => message.includes('covers "G2" is outside goals 1..1')))

  const badFormat = basePlan()
  badFormat.modules[0].acceptance[0].covers = 'goal-1'
  assert.ok(messagesOf(badFormat).some((message) => message.includes('must be G<n>')))
})

test('type declarations are strict about their kind', () => {
  const objectNoFields = basePlan()
  objectNoFields.types[0] = { name: 'Member', kind: 'object' }
  assert.ok(messagesOf(objectNoFields).some((message) => message.includes('object types need at least one field')))

  const externalNoSource = basePlan()
  externalNoSource.types[4] = { name: 'Pool', kind: 'external' }
  assert.ok(messagesOf(externalNoSource).some((message) => message.includes('must be a non-empty string')))

  const enumNoValues = basePlan()
  enumNoValues.types[3] = { name: 'Role', kind: 'enum' }
  assert.ok(messagesOf(enumNoValues).some((message) => message.includes('enum/union need at least one value')))
})

test('SPEC 4.2/4.3/4.4 render types, errors and the http surface', () => {
  const doc = renderDoc(basePlan())
  assert.match(doc, /### 4\.2 类型/)
  assert.match(doc, /#### Member（object）/)
  assert.match(doc, /\| account \| string \| — \|/)
  assert.match(doc, /#### Role（enum）\n\n取值：`admin`、`member`/)
  assert.match(doc, /#### Pool（external）\n\n来源：pg/)
  assert.match(doc, /### 4\.3 错误码/)
  assert.match(doc, /\| E_AUTH_INVALID \| 401 \| 账号或密码错误 \|/)
  assert.match(doc, /### 4\.4 接口面/)
  assert.match(doc, /\| POST \| \/login \| M1 \| LoginInput \| TokenPair \|/)
})

test('SPEC 4.2/4.3/4.4 say （无） when the plan declares nothing', () => {
  const plan = basePlan()
  delete plan.types
  delete plan.errors
  delete plan.http
  plan.modules[0].constraints = ['不写明文密码']
  plan.modules[0].acceptance[0].assertion = '登录成功'
  const doc = renderDoc(plan)
  assert.match(doc, /### 4\.2 类型\n\n（无）/)
  assert.match(doc, /### 4\.3 错误码\n\n（无）/)
  assert.match(doc, /### 4\.4 接口面\n\n（无）/)
})

test('SPEC 5 prints verbatim need/provide text, not N1/E1', () => {
  const plan = basePlan()
  plan.modules.push({
    id: 'M2',
    dir: 'api',
    title: 'API',
    responsibility: '对外接口',
    exposes: [{ kind: 'fn', signature: 'handle(): Promise<void>' }],
    requires: [{ module: 'M1', item: 'login(input: LoginInput): Promise<TokenPair>', why: '调用登录' }],
    constraints: ['只做转发'],
    files: ['api/handler.ts'],
    acceptance: [{ id: 'a2', assertion: '转发成功', test: 'pnpm test api' }],
  })
  const doc = renderDoc(plan)
  const section = doc.split('## 5 模块连线')[1].split('## 6 验收标准')[0]
  assert.match(
    section,
    /\| api \| auth \| login\(input: LoginInput\): Promise<TokenPair> \| login\(input: LoginInput\): Promise<TokenPair> \|/,
  )
  assert.equal(/N1 → E1/.test(doc), false)
})

test('SPEC 6 carries the covers column and appendix A lists open questions', () => {
  const doc = renderDoc(basePlan())
  assert.match(doc, /\| AC-M1-1 \| M1 \| 错误密码返回 E_AUTH_INVALID \| pnpm test auth \| G1 \|/)
  assert.match(doc, /## 附录 A 未决问题\n\n- 是否需要刷新令牌/)
})

test('card 3.1 only lists types this module signature uses; 4.1 lists its error codes', () => {
  const plan = basePlan()
  const waves = computeWaves(plan)
  assert.equal(waves.ok, true)
  const card = renderTaskCard(plan, plan.modules[0], waves.result.waves[0])
  const section = card.split('### 3.1 相关类型')[1].split('## 4 你依赖的契约')[0]
  assert.match(section, /#### LoginInput/)
  assert.match(section, /#### TokenPair/)
  assert.match(section, /#### Member/)
  assert.equal(/#### Pool/.test(section), false)
  assert.equal(/#### Role/.test(section), false)
  assert.match(card, /### 4\.1 错误码/)
  assert.match(card, /- `E_AUTH_INVALID`/)
})
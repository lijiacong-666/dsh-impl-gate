// G7: structure coherence checks for compose plans.
//   - data[].rowWriters must list declared modules
//   - acceptance[].assertion routes must exist in http[]
//   - errors[].shape must be supplied per error or via globals.errorShape
// The tests are intentionally mechanical: they pin the JSON Pointer and the
// message text so a regression is visible, not just "some problem".
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCompose, computeWaves, renderSpecDoc, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'bookmarks',
    title: '书签服务',
    summary: '成员创建书签，按成员查询。',
    stack: 'node22+postgres16',
    goals: ['可以创建书签', '可以按成员查询书签'],
    nonGoals: ['不做分享'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败并报错' }],
    globals: { conventions: ['错误统一用 code'], forbidden: ['禁止裸 SQL 拼接'], envKeys: ['DATABASE_URL'] },
    data: [
      {
        table: 'members',
        owner: 'M1',
        rowWriters: ['M1'],
        columns: [
          { name: 'id', type: 'uuid', constraints: ['pk'] },
          { name: 'open_id', type: 'text', constraints: ['unique'] },
        ],
        indexes: ['members_open_id_idx'],
        notes: '由 M1 在运行时 upsert',
      },
      {
        table: 'bookmarks',
        owner: 'M2',
        rowWriters: ['M2'],
        columns: [
          { name: 'id', type: 'uuid', constraints: ['pk'] },
          { name: 'owner_id', type: 'uuid', constraints: ['references: members(id)'] },
        ],
        indexes: ['bookmarks_owner_idx'],
      },
    ],
    types: [
      { name: 'Member', kind: 'object', fields: [{ name: 'id', type: 'string' }, { name: 'openId', type: 'string' }] },
      { name: 'Bookmark', kind: 'object', fields: [{ name: 'id', type: 'string' }, { name: 'ownerId', type: 'string' }] },
    ],
    errors: [{ code: 'E_NOT_FOUND', status: 404, when: '书签不存在', shape: '{"error":{"code","message"}}' }],
    http: [{ method: 'GET', path: '/bookmarks', module: 'M2', handler: 'listBookmarks', res: 'Bookmark' }],
    modules: [
      {
        id: 'M1',
        dir: 'members',
        title: '成员',
        responsibility: '创建与读取成员',
        exposes: [{ kind: 'fn', signature: 'createMember(openId: string): Promise<Member>' }],
        requires: [],
        constraints: ['openId 唯一'],
        files: ['members/create.ts', 'members/migrations/001_members.sql'],
        acceptance: [{ id: 'member-create', assertion: '重复 openId 返回已有成员，不新建', test: 'pnpm test members' }],
      },
      {
        id: 'M2',
        dir: 'bookmarks',
        title: '书签',
        responsibility: '写入与查询书签',
        exposes: [{ kind: 'http', signature: 'listBookmarks(memberId: string): Promise<Bookmark>' }],
        requires: [{ module: 'M1', item: 'createMember(openId: string): Promise<Member>', why: '确保成员存在' }],
        constraints: ['只返回当前成员的书签'],
        files: ['bookmarks/list.ts', 'bookmarks/migrations/001_bookmarks.sql'],
        acceptance: [{ id: 'bookmark-list', assertion: 'GET /bookmarks 返回当前成员的书签', test: 'pnpm test bookmarks' }],
      },
    ],
    deliverables: { tree: 'bookmarks/', files: [{ path: 'members/create.ts', purpose: '建成员' }, { path: 'bookmarks/list.ts', purpose: '查书签' }] },
  }
}

function problemsOf(plan) {
  return validatePlan(plan).problems
}

function findProblem(plan, at) {
  return problemsOf(plan).find((item) => item.path === at)
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-g7-'))
}

function render(plan) {
  const waves = computeWaves(plan)
  assert.equal(waves.ok, true)
  return renderSpecDoc({ plan, waves: waves.result })
}

test('a plan whose tables have runtime writers validates with zero problems', () => {
  assert.deepEqual(problemsOf(basePlan()), [])
})

test('missing rowWriters reports /data/<i>/rowWriters', () => {
  const plan = basePlan()
  delete plan.data[0].rowWriters
  const found = findProblem(plan, '/data/0/rowWriters')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must list at least one module id')
})

test('empty rowWriters reports /data/<i>/rowWriters', () => {
  const plan = basePlan()
  plan.data[0].rowWriters = []
  const found = findProblem(plan, '/data/0/rowWriters')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must list at least one module id')
})

test('rowWriters naming an undeclared module reports the table and pointer', () => {
  const plan = basePlan()
  plan.data[0].rowWriters = ['M1', 'M9']
  const found = findProblem(plan, '/data/0/rowWriters/1')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'unknown module "M9" in rowWriters of table "members" at /data/0/rowWriters/1')
})

test('non-string rowWriters entries are rejected', () => {
  const plan = basePlan()
  plan.data[0].rowWriters = [42]
  const found = findProblem(plan, '/data/0/rowWriters/0')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must be a non-empty module id')
})

test('an FK target without runtime writers is rejected (members referenced by bookmarks)', () => {
  const plan = basePlan()
  assert.match(plan.data[1].columns[1].constraints[0], /^references: members\(id\)$/)
  plan.data[0].rowWriters = []
  const found = findProblem(plan, '/data/0/rowWriters')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must list at least one module id')
})

test('acceptance referencing an undeclared route reports the exact route and pointer', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].assertion = 'GET /bookmarks/:id 返回单条书签'
  const found = findProblem(plan, '/modules/1/acceptance/0/assertion')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(
    found.message,
    'acceptance references undeclared route "GET /bookmarks/:id" at /modules/1/acceptance/0（已声明：/bookmarks）',
  )
})

test('a query string on an acceptance route is not part of the path', () => {
  const plan = basePlan()
  plan.http.push({ method: 'GET', path: '/search', module: 'M2', handler: 'listBookmarks', res: 'Bookmark' })
  plan.modules[1].acceptance[0].assertion = 'GET /bookmarks?scope=team 与 GET /search?q=vue 都返回列表'
  assert.deepEqual(problemsOf(plan), [])
})

test('an undeclared route keeps its path but drops the query string', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].assertion = 'GET /bookmarks/:id?x=1 返回单条书签'
  const found = findProblem(plan, '/modules/1/acceptance/0/assertion')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.match(found.message, /undeclared route "GET \/bookmarks\/:id" at \/modules\/1\/acceptance\/0/)
  assert.equal(found.message.includes('?x=1'), false, found.message)
})

test('trailing punctuation and Chinese quotes are not part of the path', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].assertion = 'GET /bookmarks, 返回列表；GET “/bookmarks” 同样返回列表。'
  assert.deepEqual(problemsOf(plan), [])
})

test('a slash in prose without a leading path is not mistaken for a route', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].assertion = '支持读/写，不新增路由。'
  assert.deepEqual(problemsOf(plan), [])
})

test('acceptance referencing a declared route is accepted', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].assertion = 'GET /bookmarks 返回 200 与书签数组'
  assert.deepEqual(problemsOf(plan), [])
})

test('a bare command in acceptance is not mistaken for a route', () => {
  const plan = basePlan()
  plan.modules[1].acceptance[0].assertion = 'pnpm vitest run tests/bookmarks.test.ts 退出码为 0'
  const problems = problemsOf(plan)
  assert.equal(problems.some((item) => item.message.includes('undeclared route')), false, JSON.stringify(problems))
})

test('every declared method+path pair closes, including PATCH', () => {
  const plan = basePlan()
  plan.http.push({ method: 'PATCH', path: '/bookmarks/:id', module: 'M2', handler: 'listBookmarks', res: 'Bookmark' })
  plan.modules[1].acceptance.push({
    id: 'bookmark-patch',
    assertion: 'PATCH /bookmarks/:id 更新书签返回 200',
    test: 'pnpm test bookmarks',
  })
  assert.deepEqual(problemsOf(plan), [])
})

test('missing errors[].shape reports /errors/<i>/shape', () => {
  const plan = basePlan()
  delete plan.errors[0].shape
  const found = findProblem(plan, '/errors/0/shape')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must be a non-empty string')
})

test('empty errors[].shape is rejected', () => {
  const plan = basePlan()
  plan.errors[0].shape = '   '
  const found = findProblem(plan, '/errors/0/shape')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must be a non-empty string')
})

test('globals.errorShape supplies the default for every error', () => {
  const plan = basePlan()
  plan.globals.errorShape = '{"error":{"code","message"}}'
  plan.errors = [
    { code: 'E_NOT_FOUND', status: 404, when: '书签不存在' },
    { code: 'E_CONFLICT', status: 409, when: 'openId 已绑定其他成员' },
  ]
  assert.deepEqual(problemsOf(plan), [])
})

test('an empty globals.errorShape is rejected instead of silently defaulting', () => {
  const plan = basePlan()
  plan.globals.errorShape = ''
  const found = findProblem(plan, '/globals/errorShape')
  assert.ok(found, JSON.stringify(problemsOf(plan)))
  assert.equal(found.message, 'must be a non-empty string when present')
})

test('4.3 prints a body shape on every row when only globals.errorShape is given', () => {
  const plan = basePlan()
  plan.globals.errorShape = '{"error":{"code","message"}}'
  plan.errors = [
    { code: 'E_NOT_FOUND', status: 404, when: '书签不存在' },
    { code: 'E_CONFLICT', status: 409, when: '重复绑定' },
  ]
  const section = render(plan).split('### 4.3 错误码')[1].split('### 4.4 接口面')[0]
  const rows = section.split('\n').filter((line) => line.startsWith('| E_'))
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.ok(row.includes('{"error":{"code","message"}}'), row)
    assert.equal(row.includes('| — |'), false, row)
  }
})

test('4.3 keeps a per-error shape that overrides globals.errorShape', () => {
  const plan = basePlan()
  plan.globals.errorShape = '{"error":{"code","message"}}'
  plan.errors.push({ code: 'E_DB_DOWN', status: 500, when: '数据库不可用', shape: '{"error":{"code","message","detail"}}' })
  const section = render(plan).split('### 4.3 错误码')[1].split('### 4.4 接口面')[0]
  assert.match(section, /E_DB_DOWN \| 500 \| （未指定） \| 数据库不可用 \| \{"error":\{"code","message","detail"\}\}/)
})

test('4.1 names the writers when a referencing module does not write the table', () => {
  const doc = render(basePlan())
  const section = doc.split('#### members')[1].split('#### bookmarks')[0]
  assert.ok(section.includes('写入方：M1'), section)
})

test('4.1 surfaces writers that differ from the owner', () => {
  const plan = basePlan()
  plan.data[0].rowWriters = ['M1', 'M2']
  const doc = render(plan)
  const section = doc.split('#### members')[1].split('#### bookmarks')[0]
  assert.ok(section.includes('写入方：M1, M2'), section)
})

test('4.1 omits the writer line for a table no other module references', () => {
  const plan = basePlan()
  plan.data[1].columns = plan.data[1].columns.filter((column) => !(column.constraints ?? []).some((item) => item.startsWith('references:')))
  const doc = render(plan)
  assert.equal(doc.includes('写入方：'), false)
})

test('materialize refuses an incoherent plan with every G7 problem at once', async () => {
  const plan = basePlan()
  plan.data[0].rowWriters = []
  plan.data[1].rowWriters = ['M9']
  plan.modules[1].acceptance[0].assertion = 'GET /bookmarks/:id 返回单条书签'
  delete plan.errors[0].shape
  const outDir = tempDir()
  fs.writeFileSync(path.join(outDir, 'compose-plan.json'), JSON.stringify(plan), 'utf8')
  const result = await buildCompose({ outDir, mode: 'materialize' })
  assert.equal(result.error.code, 'PLAN_INVALID')
  const messages = result.problems.map((item) => item.message).join('\n')
  assert.match(messages, /must list at least one module id/)
  assert.match(messages, /unknown module "M9" in rowWriters of table "bookmarks"/)
  assert.match(messages, /acceptance references undeclared route "GET \/bookmarks\/:id"/)
  const shapeProblem = result.problems.find((item) => item.path === '/errors/0/shape')
  assert.ok(shapeProblem, JSON.stringify(result.problems))
  assert.equal(shapeProblem.message, 'must be a non-empty string')
})
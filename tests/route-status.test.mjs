// 4.4 成功状态码与响应头：文档必须能回答「成功返回几」与「哪些头是契约」。
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeWaves, renderSpecDoc, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'status-demo',
    title: '状态码示例',
    summary: 's',
    stack: 'node22+postgres16',
    goals: ['创建条目'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DATABASE_URL'] },
    data: [{ table: 'things', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] }],
    deliverables: {
      tree: 'things/\n  service.ts\n  migrations/001_things.sql',
      files: [
        { path: 'things/service.ts', purpose: '条目读写' },
        { path: 'things/migrations/001_things.sql', purpose: '建表' },
      ],
    },
    errors: [
      { code: 'E_NOT_FOUND', status: 404, when: '不存在', shape: '{"error":{"code","message"}}', by: 'M1' },
    ],
    http: [
      { method: 'POST', path: '/things', module: 'M1', handler: 'createThing', req: 'ThingInput', res: 'Thing' },
      { method: 'DELETE', path: '/things/:id', module: 'M1', handler: 'deleteThing', res: 'void' },
    ],
    types: [
      { name: 'ThingInput', kind: 'object', fields: [{ name: 'name', type: 'string' }] },
      { name: 'Thing', kind: 'object', fields: [{ name: 'id', type: 'string' }] },
    ],
    modules: [
      {
        id: 'M1',
        dir: 'things',
        title: '条目',
        responsibility: '读写条目',
        exposes: [
          { kind: 'http', signature: 'createThing(input: ThingInput): Promise<Thing>' },
          { kind: 'http', signature: 'deleteThing(id: string): Promise<void>' },
        ],
        requires: [],
        constraints: ['按 id 删除'],
        files: ['things/service.ts', 'things/migrations/001_things.sql'],
        acceptance: [{ id: 'm1-ok', assertion: '创建后能按 id 读回', test: 'pnpm test' }],
      },
    ],
  }
}

function render(plan) {
  return renderSpecDoc({ plan, waves: computeWaves(plan).result })
}

test('absent status renders 200, void renders 204', () => {
  const doc = render(basePlan())
  assert.match(doc, /\| POST \| \/things \| M1 \| createThing\(\) \| public \| 200 \| ThingInput \| Thing \|/)
  assert.match(doc, /deleteThing\(\) \| public \| 204 \|/)
})

test('an explicit status is rendered as written', () => {
  const plan = basePlan()
  plan.http[0].status = 201
  assert.deepEqual(validatePlan(plan).problems, [])
  assert.match(render(plan), /\| POST \| \/things \| M1 \| createThing\(\) \| public \| 201 \|/)
})

test('void must be 204 and a body must not be 204', () => {
  const voidWrong = basePlan()
  voidWrong.http[1].status = 200
  assert.ok(
    validatePlan(voidWrong).problems.some(
      (entry) => entry.path === '/http/1/status' && entry.message.includes('void response must use status 204'),
    ),
  )

  const bodyWrong = basePlan()
  bodyWrong.http[0].status = 204
  assert.ok(
    validatePlan(bodyWrong).problems.some(
      (entry) => entry.path === '/http/0/status' && entry.message.includes('status 204 needs res "void"'),
    ),
  )
})

test('response headers are rendered as part of the contract', () => {
  const plan = basePlan()
  plan.http[0].resHeaders = { 'X-Count': '<int>', 'Cache-Control': 'no-store' }
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = render(plan)
  assert.match(doc, /响应头（契约的一部分）：/)
  assert.match(doc, /- POST \/things — X-Count: <int>；Cache-Control: no-store/)
})

test('a malformed response header is a plan problem', () => {
  const plan = basePlan()
  plan.http[0].resHeaders = { 'X-Count': '' }
  assert.ok(
    validatePlan(plan).problems.some(
      (entry) => entry.path === '/http/0/resHeaders' && entry.message.includes('header "X-Count" must be a non-empty string'),
    ),
  )
})

test('a GET example is labelled as query parameters, not a body', () => {
  const plan = basePlan()
  plan.http.push({
    method: 'GET',
    path: '/things',
    module: 'M1',
    handler: 'listThings',
    res: 'Thing',
    reqExample: '{"page":1}',
  })
  plan.modules[0].exposes.push({ kind: 'http', signature: 'listThings(page: number): Promise<Thing>' })
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = render(plan)
  assert.match(doc, /#### GET \/things 示例/)
  assert.match(doc, /查询参数示例：/)
  assert.doesNotMatch(doc.split('#### GET /things 示例')[1], /请求体：/)
})

test('declared query parameters are rendered with requiredness', () => {
  const plan = basePlan()
  plan.http.push({
    method: 'GET',
    path: '/things',
    module: 'M1',
    handler: 'listThings',
    res: 'Thing',
    query: [
      { name: 'month', type: 'string', required: true },
      { name: 'page', type: 'number', note: '从 1 开始' },
    ],
  })
  plan.modules[0].exposes.push({ kind: 'http', signature: 'listThings(month: string): Promise<Thing>' })
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = render(plan)
  assert.match(doc, /查询参数（契约的一部分）：/)
  assert.match(doc, /- GET \/things — month（string，必填）、page（number，可选） — 从 1 开始/)
})

test('a query parameter with an undeclared type or a bad name is a plan problem', () => {
  const plan = basePlan()
  plan.http[0].query = [{ name: '1bad', type: 'Thing' }]
  assert.ok(
    validatePlan(plan).problems.some((entry) => entry.path === '/http/0/query/0/name' && entry.message.includes('plain identifier')),
  )

  const unknownType = basePlan()
  unknownType.http[0].query = [{ name: 'q', type: 'Nope' }]
  assert.ok(
    validatePlan(unknownType).problems.some(
      (entry) => entry.path === '/http/0/query/0/type' && entry.message.includes('unknown type "Nope"'),
    ),
  )

  const notArray = basePlan()
  notArray.http[0].query = { month: 'string' }
  assert.ok(
    validatePlan(notArray).problems.some(
      (entry) => entry.path === '/http/0/query' && entry.message.includes('must be an array'),
    ),
  )
})
// runtime block and http request/response examples.
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeWaves, renderSpecDoc, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'runtime-demo',
    title: '运行示例',
    summary: 's',
    stack: 'node22+postgres16',
    goals: ['能起来'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'postgres', purpose: '存储', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [] },
    data: [{ table: 'things', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'string' }] }],
    errors: [{ code: 'E_BAD', status: 400, when: '参数错', shape: '{"error":{"code"}}', by: 'M1' }],
    http: [
      {
        method: 'POST',
        path: '/things',
        module: 'M1',
        handler: 'createThing',
        req: 'ThingInput',
        res: 'Thing',
        auth: 'session',
        reqExample: '{"name":"x"}',
        resExample: '{"id":"t1","name":"x"}',
      },
    ],
    types: [
      { name: 'ThingInput', kind: 'object', fields: [{ name: 'name', type: 'string' }] },
      { name: 'Thing', kind: 'object', fields: [{ name: 'id', type: 'string' }] },
    ],
    modules: [
      {
        id: 'M1',
        dir: 'things',
        title: '事物',
        responsibility: '读写事物',
        exposes: [{ kind: 'http', signature: 'createThing(input: ThingInput): Promise<Thing>' }],
        requires: [],
        constraints: ['name 不能为空'],
        files: ['things/create.ts', 'things/migrations/001_things.sql'],
        acceptance: [{ id: 'a1', assertion: '空 name 返回 400', test: 'pnpm test' }],
      },
    ],
    deliverables: { tree: 'things/', files: [{ path: 'things/create.ts', purpose: '写入' }] },
  }
}

const problemsOf = (plan) => validatePlan(plan).problems.map((entry) => `${entry.path}: ${entry.message}`)

test('runtime is rendered as 8.1', () => {
  const plan = basePlan()
  plan.runtime = {
    port: 8080,
    start: 'pnpm start',
    health: '/healthz',
    migrate: 'pnpm migrate',
    rollback: 'pnpm migrate down 1',
  }
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /### 8\.1 运行与部署/)
  assert.match(doc, /\| 端口 \| 8080 \|/)
  assert.match(doc, /\| 健康检查 \| \/healthz \|/)
  assert.match(doc, /\| 回滚 \| pnpm migrate down 1 \|/)
})

test('an absent runtime says what to confirm at kickoff', () => {
  const doc = renderSpecDoc({ plan: basePlan(), waves: computeWaves(basePlan()).result })
  assert.match(doc, /### 8\.1 运行与部署/)
  assert.match(doc, /未声明；实现者需在开工会上确认/)
})

test('a bad port is a plan problem', () => {
  const plan = basePlan()
  plan.runtime = { port: 70000 }
  assert.ok(problemsOf(plan).some((entry) => entry.includes('/runtime/port') && entry.includes('0 and 65535')))
})

test('http examples are rendered under 4.4', () => {
  const doc = renderSpecDoc({ plan: basePlan(), waves: computeWaves(basePlan()).result })
  assert.match(doc, /#### POST \/things 示例/)
  assert.match(doc, /```json\n\{"name":"x"\}\n```/)
  assert.match(doc, /\{"id":"t1","name":"x"\}/)
})

test('an example that is not JSON is a plan problem', () => {
  const plan = basePlan()
  plan.http[0].reqExample = '{name: x}'
  assert.ok(
    problemsOf(plan).some((entry) => entry.includes('/http/0/reqExample') && entry.includes('must be valid JSON text')),
  )
})
test('globals.nfr is rendered as 8.2', () => {
  const plan = basePlan()
  plan.globals.nfr = ['登录接口每个 IP 每分钟 10 次', 'P95 < 300ms']
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /### 8\.2 非功能要求/)
  assert.match(doc, /登录接口每个 IP 每分钟 10 次/)
  assert.match(doc, /P95 < 300ms/)
})

test('nfr must be a string array', () => {
  const plan = basePlan()
  plan.globals.nfr = 'P95 < 300ms'
  assert.ok(problemsOf(plan).some((entry) => entry.includes('/globals/nfr') && entry.includes('must be an array')))
})

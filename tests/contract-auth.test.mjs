// 0.3.0 contract holes: http[].auth, errors[].by and res:"void".
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeWaves, renderSpecDoc, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'auth-demo',
    title: '鉴权示例',
    summary: 's',
    stack: 'node22+postgres16',
    goals: ['登录'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DATABASE_URL'] },
    data: [
      { table: 'things', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] },
    ],
    errors: [
      { code: 'E_FORBIDDEN', status: 403, when: '非管理员', shape: '{"error":{"code","message"}}', by: 'M1' },
    ],
    http: [
      { method: 'DELETE', path: '/things/:id', module: 'M1', handler: 'removeThing', res: 'void', auth: 'admin' },
    ],
    modules: [
      {
        id: 'M1',
        dir: 'things',
        title: '事物',
        responsibility: '读写事物',
        exposes: [
          { kind: 'http', signature: 'removeThing(id: string): Promise<void>' },
        ],
        requires: [],
        constraints: ['只有管理员能删'],
        files: ['things/create.ts', 'things/migrations/001_things.sql'],
        acceptance: [{ id: 'a1', assertion: '非管理员返回 403', test: 'pnpm test' }],
      },
    ],
    deliverables: { tree: 'things/', files: [{ path: 'things/create.ts', purpose: '写入' }] },
  }
}

const problemsOf = (plan) => validatePlan(plan).problems.map((entry) => `${entry.path}: ${entry.message}`)

test('auth and by are accepted and rendered', () => {
  const plan = basePlan()
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /\| E_FORBIDDEN \| 403 \| M1 \| 非管理员 \|/)
  assert.match(doc, /\| DELETE \| \/things\/:id \| M1 \| \w+\(\) \| admin \|/)
  assert.match(doc, /204（无响应体）/)
})

test('an unknown auth mode is a plan problem', () => {
  const plan = basePlan()
  plan.http[0].auth = 'oauth'
  const problems = problemsOf(plan)
  assert.ok(problems.some((entry) => entry.includes('/http/0/auth') && entry.includes('public, session, admin')))
})

test('an error attributed to an unknown module is a plan problem', () => {
  const plan = basePlan()
  plan.errors[0].by = 'M9'
  const problems = problemsOf(plan)
  assert.ok(problems.some((entry) => entry.includes('/errors/0/by') && entry.includes('module "M9" does not exist')))
})

test('a missing by renders as （未指定） instead of a bare dash', () => {
  const plan = basePlan()
  delete plan.errors[0].by
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /\| E_FORBIDDEN \| 403 \| （未指定） \|/)
})

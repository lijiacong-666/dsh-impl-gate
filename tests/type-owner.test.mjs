// 共享类型必须有归属文件（types[].owner），否则跨模块各造一份；错误对象契约写死在 §8。
import assert from 'node:assert/strict'
import test from 'node:test'

import { collectWarnings, computeWaves, renderSpecDoc, validatePlan } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'owner-demo',
    title: '类型归属示例',
    summary: 's',
    stack: 'node22+sqlite',
    goals: ['能创建条目'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'sqlite', purpose: '持久化', version: '3', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DB_PATH'] },
    data: [{ table: 'things', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'text' }] }],
    types: [{ name: 'Thing', kind: 'object', fields: [{ name: 'id', type: 'string' }] }],
    errors: [
      { code: 'E_NOT_FOUND', status: 404, when: '不存在', shape: '{"error":{"code","message"}}', by: 'M1' },
    ],
    http: [],
    modules: [
      {
        id: 'M1',
        dir: 'things',
        title: '条目',
        responsibility: '读写条目',
        exposes: [{ kind: 'fn', signature: 'createThing(): Promise<Thing>' }],
        requires: [],
        constraints: ['按 id 删除，删除不存在的抛 E_NOT_FOUND'],
        files: ['things/service.ts', 'things/migrations/001_things.sql'],
        acceptance: [{ id: 'm1-ok', assertion: '创建后能读回 Thing', test: 'pnpm test' }],
      },
      {
        id: 'M2',
        dir: 'reports',
        title: '报表',
        responsibility: '读条目做汇总',
        exposes: [{ kind: 'fn', signature: 'summarise(): Promise<Thing>' }],
        requires: [{ module: 'M1', item: 'createThing(): Promise<Thing>' }],
        constraints: ['只读，不写 things'],
        files: ['reports/summary.ts'],
        acceptance: [{ id: 'm2-ok', assertion: '汇总返回 Thing', test: 'pnpm test' }],
      },
    ],
    deliverables: {
      tree: 'things/\n  service.ts\nreports/\n  summary.ts',
      files: [
        { path: 'things/service.ts', purpose: '条目读写' },
        { path: 'things/migrations/001_things.sql', purpose: '建表' },
        { path: 'reports/summary.ts', purpose: '汇总' },
      ],
    },
  }
}

test('a type owner is rendered next to the type', () => {
  const plan = basePlan()
  plan.types[0].owner = 'M1'
  assert.deepEqual(validatePlan(plan).problems, [])
  const doc = renderSpecDoc({ plan, waves: computeWaves(plan).result })
  assert.match(doc, /#### Thing（object）/)
  assert.match(doc, /归属：M1（由该模块的某个文件定义并导出）/)
})

test('an unknown owner module is a plan problem', () => {
  const plan = basePlan()
  plan.types[0].owner = 'M9'
  assert.ok(
    validatePlan(plan).problems.some(
      (entry) => entry.path === '/types/0/owner' && entry.message.includes('module "M9" does not exist'),
    ),
  )
})

test('a type used by two modules without an owner warns once', () => {
  const warnings = collectWarnings(basePlan())
  assert.deepEqual(warnings.filter((warning) => warning.code === 'TYPE_OWNER_MISSING'), [
    { code: 'TYPE_OWNER_MISSING', count: 1, items: ['Thing'] },
  ])
})

test('an owned type produces no warning', () => {
  const plan = basePlan()
  plan.types[0].owner = 'M1'
  assert.equal(collectWarnings(plan).filter((warning) => warning.code === 'TYPE_OWNER_MISSING').length, 0)
})

test('section 8 states the error object contract', () => {
  const doc = renderSpecDoc({ plan: basePlan(), waves: computeWaves(basePlan()).result })
  assert.match(doc, /### 接口约定/)
  assert.match(doc, /错误对象：抛出的值必须是 `instanceof Error`，带 `code: string`/)
})
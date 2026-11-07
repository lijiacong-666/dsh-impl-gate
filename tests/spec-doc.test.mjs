import assert from 'node:assert/strict'
import test from 'node:test'
import { computeWaves, renderSpecDoc } from '../lib/index.js'

function plan() {
  return {
    schemaVersion: 1,
    name: 'shop',
    title: '小店',
    summary: '卖东西',
    stack: 'node22+pg',
    goals: ['能下单'],
    nonGoals: ['不做推荐'],
    boundaries: [{ dependency: 'pg', purpose: '存订单', version: '16', fallback: '启动失败' }],
    globals: { conventions: ['金额用分'], forbidden: ['不记录明文密码'], envKeys: ['DATABASE_URL'] },
    data: [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'uuid', constraints: ['主键'] },
          { name: 'amount', type: 'integer', constraints: ['>=0'] },
        ],
        indexes: ['orders_created_idx'],
        notes: '只追加',
      },
    ],
    modules: [
      {
        id: 'M1',
        dir: 'shared',
        title: '共享',
        responsibility: '基础能力',
        exposes: [
          { kind: 'fn', signature: 'Db', note: '连接' },
          { kind: 'fn', signature: 'Clock', note: '时间' },
        ],
        requires: [],
        constraints: ['无全局可变状态'],
        files: ['shared/db.ts', 'shared/clock.ts'],
        acceptance: [{ id: 'a1', assertion: 'Db 可用', test: 'pnpm test shared' }],
      },
      {
        id: 'M2',
        dir: 'orders',
        title: '订单',
        responsibility: '下单',
        exposes: [{ kind: 'fn', signature: 'createOrder' }],
        requires: [{ module: 'M1', item: 'Db', why: '写库' }],
        constraints: ['金额不可为负'],
        files: ['orders/create.ts'],
        acceptance: [
          { id: 'a2', assertion: '重复下单幂等', test: 'pnpm test orders' },
          { id: 'a3', assertion: '金额校验', test: 'pnpm test orders' },
        ],
      },
      {
        id: 'M3',
        dir: 'api',
        title: 'API',
        responsibility: '对外接口',
        exposes: [{ kind: 'http', signature: 'postOrder' }],
        requires: [{ module: 'M2', item: 'createOrder', why: '调用下单' }],
        constraints: ['鉴权后才能下单'],
        files: ['api/order.ts'],
        acceptance: [{ id: 'a4', assertion: '401 无 token', test: 'pnpm test api' }],
      },
    ],
    deliverables: {
      tree: 'shop/\n  shared/\n  orders/\n  api/',
      files: [
        { path: 'shared/db.ts', purpose: '连接池' },
        { path: 'orders/create.ts', purpose: '下单' },
      ],
    },
  }
}

function render() {
  const p = plan()
  const waves = computeWaves(p)
  assert.equal(waves.ok, true)
  return { doc: renderSpecDoc({ plan: p, waves: waves.result }), waves: waves.result }
}

test('section 5 lists exactly the two requires edges', () => {
  const { doc } = render()
  const section = doc.split('## 5 模块连线')[1].split('## 6 验收标准')[0]
  const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| 从') && !line.startsWith('| ---'))
  assert.deepEqual(rows, ['| orders | shared | N1 → E1 |', '| api | orders | N1 → E1 |'])
})

test('module table has one row per module with <br> for multiple items', () => {
  const { doc } = render()
  const section = doc.split('## 3 模块清单')[1].split('## 4 数据结构')[0]
  assert.match(section, /\| M1 \| shared \| 基础能力 \| Db<br>Clock \| （无） \| shared\/db\.ts<br>shared\/clock\.ts \|/)
  assert.match(section, /\| M2 \| orders \| 下单 \| createOrder \| Db \| orders\/create\.ts \|/)
})

test('data section renders one column table per table', () => {
  const { doc } = render()
  assert.match(doc, /### orders/)
  assert.match(doc, /\| id \| uuid \| 主键 \|/)
  assert.match(doc, /\| amount \| integer \| >=0 \|/)
  assert.match(doc, /索引：orders_created_idx/)
})

test('acceptance table uses AC-<module>-<n> ids', () => {
  const { doc } = render()
  const ids = [...doc.matchAll(/^\| (AC-[^ ]+) \|/gm)].map((match) => match[1])
  assert.deepEqual(ids, ['AC-M1-1', 'AC-M2-1', 'AC-M2-2', 'AC-M3-1'])
})

test('wave table has three waves and lists prerequisites', () => {
  const { doc } = render()
  const section = doc.split('## 7 实施波次')[1].split('## 8 全局约定')[0]
  assert.match(section, /\| 第 1 波 \| M1 \| 是 \| （无） \|/)
  assert.match(section, /\| 第 2 波 \| M2 \| 是 \| M1 \|/)
  assert.match(section, /\| 第 3 波 \| M3 \| 是 \| M2 \|/)
})

test('globals and deliverables are rendered, footer is fixed', () => {
  const { doc } = render()
  assert.match(doc, /### 约定\n- 金额用分/)
  assert.match(doc, /### 禁止\n- 不记录明文密码/)
  assert.match(doc, /### 环境变量\n- DATABASE_URL/)
  assert.match(doc, /```text\nshop\//)
  assert.ok(doc.endsWith('> 本文由 dsh-impl-gate 从 compose-plan.json 生成，改契约请改 plan 后重跑 materialize。\n'))
})

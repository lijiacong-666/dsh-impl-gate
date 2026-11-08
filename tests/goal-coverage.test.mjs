// 0.3.0: section 1 numbers the goals so acceptance[].covers can point at them.
import assert from 'node:assert/strict'
import test from 'node:test'

import { computeWaves, renderSpecDoc } from '../lib/index.js'

function plan() {
  return {
    schemaVersion: 1,
    name: 'goal-demo',
    title: '目标编号',
    summary: 's',
    stack: 'node22',
    goals: ['能登录', '能登出', '能改密码'],
    nonGoals: ['不做注册'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DATABASE_URL'] },
    data: [{ table: 'users', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'uuid' }] }],
    errors: [],
    http: [],
    modules: [
      {
        id: 'M1',
        dir: 'auth',
        title: '认证',
        responsibility: '登录与登出',
        exposes: [{ kind: 'fn', signature: 'login(): Promise<void>' }],
        requires: [],
        constraints: ['密码不落日志'],
        files: ['auth/login.ts', 'auth/migrations/001_users.sql'],
        acceptance: [
          { id: 'a1', assertion: '登录成功', test: 'pnpm test', covers: 'G1' },
          { id: 'a2', assertion: '登出清除会话', test: 'pnpm test', covers: 'G2' },
        ],
      },
    ],
    deliverables: { tree: 'auth/', files: [{ path: 'auth/login.ts', purpose: '登录' }] },
  }
}

const render = (value) => renderSpecDoc({ plan: value, waves: computeWaves(value).result })

test('section 1 numbers every goal as G<n>', () => {
  const doc = render(plan())
  assert.match(doc, /### 目标\n- \*\*G1\*\* 能登录\n- \*\*G2\*\* 能登出\n- \*\*G3\*\* 能改密码/)
})

test('an uncovered goal is called out right under the acceptance table', () => {
  const doc = render(plan())
  assert.match(doc, /覆盖缺口：G3 没有验收断言对应的 `covers`/)
})

test('a fully covered plan has no coverage note', () => {
  const value = plan()
  value.modules[0].acceptance.push({ id: 'a3', assertion: '改密码', test: 'pnpm test', covers: 'G3' })
  assert.equal(render(value).includes('覆盖缺口'), false)
})

test('section 6 shows the covered goal next to each acceptance row', () => {
  assert.match(render(plan()), /\| AC-M1-1 \| M1 \| 登录成功 \| pnpm test \| G1 \|/)
})
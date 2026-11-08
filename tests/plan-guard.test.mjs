// 0.3.0 P0: plan mode must never silently replace a filled plan, init failures
// must use the same {error:{code,message}} shape as compose, and a table owner
// without a migration file is a plan error instead of prose advice.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { buildCompose, buildInit, validatePlan } from '../lib/index.js'

const config = {
  specgraphCommand: 'python',
  pythonPath: '',
  specgraphCwd: '',
  timeoutMs: 30_000,
  implRoot: '',
  slow: false,
  allowCommandReplay: false,
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-guard-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function filledPlan(outDir) {
  const created = await buildCompose({ outDir, mode: 'plan', name: 'demo' }, config)
  assert.equal(created.ok, true)
  const planPath = path.join(outDir, 'compose-plan.json')
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  plan.title = '手写的设计'
  plan.summary = '已经填了很久的 plan'
  plan.goals = ['目标一']
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
  return planPath
}

test('plan mode refuses to overwrite an existing compose-plan.json', async (t) => {
  const out = tempDir(t)
  const planPath = await filledPlan(out)
  const before = digest(planPath)

  const second = await buildCompose({ outDir: out, mode: 'plan' }, config)
  assert.equal(second.ok, undefined)
  assert.equal(second.error.code, 'E_PLAN_EXISTS')
  assert.match(second.error.detail, /mode:"draft"/)
  assert.equal(digest(planPath), before)
})

test('draft mode refreshes SPEC-DRAFT.md without touching the plan', async (t) => {
  const out = tempDir(t)
  const planPath = await filledPlan(out)
  const before = digest(planPath)

  const draft = await buildCompose({ outDir: out, mode: 'draft' }, config)
  assert.equal(draft.ok, true)
  assert.equal(draft.mode, 'draft')
  assert.equal(digest(planPath), before)

  const text = fs.readFileSync(path.join(out, 'SPEC-DRAFT.md'), 'utf8')
  assert.match(text, /手写的设计/)
})

test('draft mode works before any plan exists and does not create one', async (t) => {
  const out = tempDir(t)
  const draft = await buildCompose({ outDir: out, mode: 'draft' }, config)
  assert.equal(draft.ok, true)
  assert.equal(draft.planPath, '')
  assert.equal(fs.existsSync(path.join(out, 'compose-plan.json')), false)
  assert.equal(fs.existsSync(path.join(out, 'SPEC-DRAFT.md')), true)
})

test('overwrite:true resets the plan only after writing a backup', async (t) => {
  const out = tempDir(t)
  const planPath = await filledPlan(out)
  const backupSource = fs.readFileSync(planPath, 'utf8')

  const reset = await buildCompose({ outDir: out, mode: 'plan', overwrite: true }, config)
  assert.equal(reset.ok, true)
  assert.match(path.basename(reset.backupPath), /^compose-plan\.backup-\d+T\d+\.json$/)
  assert.equal(fs.readFileSync(reset.backupPath, 'utf8'), backupSource)

  const fresh = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  assert.notEqual(fresh.title, '手写的设计')
  assert.match(fresh._hint ?? '', /impl_gate_compose/)
})

test('init failure uses {error:{code,message}} and no top-level code', async (t) => {
  const out = tempDir(t)
  const plan = planWithOwnerFiles(['things/create.ts', 'things/migrations/001_things.sql'])
  plan.goals = ['目标一']
  fs.writeFileSync(path.join(out, 'compose-plan.json'), `${JSON.stringify(plan, null, 2)}\n`)

  assert.equal(buildInit({ outDir: out }).ok, true)
  const second = buildInit({ outDir: out })
  assert.equal(second.ok, false)
  assert.equal(second.code, undefined)
  assert.equal(second.error.code, 'EXPORT_REFUSED')
  assert.match(second.error.message, /already exist/)
})

function planWithOwnerFiles(files) {
  return {
    schemaVersion: 1,
    name: 'migration-demo',
    title: '迁移必填',
    summary: 's',
    stack: 'node22+postgres16',
    goals: ['g'],
    nonGoals: ['n'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', version: '16', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DATABASE_URL'] },
    data: [
      {
        table: 'things',
        owner: 'M1',
        rowWriters: ['M1'],
        columns: [{ name: 'id', type: 'uuid' }],
      },
    ],
    modules: [
      {
        id: 'M1',
        dir: 'things',
        title: '事物',
        responsibility: '写入事物',
        exposes: [{ kind: 'fn', signature: 'createThing(id: string): Promise<string>' }],
        requires: [],
        constraints: ['id 唯一'],
        files,
        acceptance: [{ id: 't1', assertion: '能写入', test: 'pnpm test' }],
      },
    ],
    deliverables: { tree: 'things/', files: [{ path: 'things/create.ts', purpose: '写入' }] },
  }
}

test('a table owner without a migration file is a plan problem', () => {
  const result = validatePlan(planWithOwnerFiles(['things/create.ts']))
  const problem = result.problems.find((entry) => entry.path === '/data/0/owner')
  assert.notEqual(problem, undefined)
  assert.match(problem.message, /no migration file/)
})

test('a migrations/*.sql path in the owner whitelist satisfies the rule', () => {
  const result = validatePlan(planWithOwnerFiles(['things/create.ts', 'things/migrations/001_things.sql']))
  assert.deepEqual(result.problems, [])
})
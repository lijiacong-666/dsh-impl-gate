// impl_gate_record: the acceptance rows in compose-plan.json become commands,
// and the run turns them into evidence (exit code + log tail) instead of prose.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AC_EVIDENCE_REL, recordAcceptance, runnerOf, TASKS_EVIDENCE_REL } from '../lib/index.js'

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'record-demo',
    title: '记录演示',
    summary: 's',
    stack: 'node22',
    goals: ['跑通验收'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'sqlite', purpose: '本地存储', version: '3', fallback: '启动失败' }],
    globals: { conventions: ['统一错误码'], forbidden: [], envKeys: ['DATABASE_URL'] },
    data: [{ table: 'work', owner: 'M1', rowWriters: ['M1'], columns: [{ name: 'id', type: 'text' }] }],
    errors: [{ code: 'E_CORE_FAILED', status: 500, when: '写入失败', shape: '{"error":{"code","message"}}', by: 'M1' }],
    http: [],
    types: [],
    deliverables: {
      tree: 'core/\n  work.ts\nshell/\n  app.ts',
      files: [
        { path: 'core/work.ts', purpose: '核心实现' },
        { path: 'shell/app.ts', purpose: '装配入口' },
      ],
    },
    modules: [
      {
        id: 'M1',
        dir: 'core',
        title: '核心',
        responsibility: '提供 doWork',
        exposes: [{ kind: 'fn', signature: 'doWork(): Promise<void>' }],
        requires: [],
        constraints: ['无副作用'],
        files: ['core/work.ts', 'core/migrations/001_core.sql'],
        acceptance: [
          { id: 'AC-M1-1', assertion: '命令成功时 PASS', test: 'node -e "process.exit(0)"' },
          { id: 'AC-M1-2', assertion: '命令失败时 FAIL', test: 'node -e "process.exit(3)"' },
        ],
      },
      {
        id: 'M2',
        dir: 'shell',
        title: '壳',
        responsibility: '装配',
        exposes: [{ kind: 'fn', signature: 'buildServer(): Promise<void>' }],
        requires: [{ module: 'M1', item: 'doWork(): Promise<void>' }],
        constraints: ['不写业务'],
        files: ['shell/app.ts'],
        acceptance: [
          { id: 'AC-M2-1', assertion: '被禁命令不执行', test: 'rm -rf /' },
        ],
      },
    ],
  }
}

function tmpProject(plan = basePlan(), withTasks = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-record-'))
  const outDir = path.join(root, 'proj')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'compose-plan.json'), JSON.stringify(plan, null, 2), 'utf8')
  if (withTasks) fs.mkdirSync(path.join(outDir, 'tasks'), { recursive: true })
  return { root, outDir }
}

test('runnerOf strips dirs and windows extensions', () => {
  assert.equal(runnerOf('pnpm test'), 'pnpm')
  assert.equal(runnerOf('C:\\tools\\node.exe script.js'), 'node')
  assert.equal(runnerOf(''), null)
})

test('missing plan is reported without writing anything', () => {
  const { root, outDir } = tmpProject()
  fs.rmSync(path.join(outDir, 'compose-plan.json'))
  const outcome = recordAcceptance(outDir)
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.error.code, 'PLAN_MISSING')
  assert.equal(fs.existsSync(path.join(outDir, AC_EVIDENCE_REL)), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('dryRun records every acceptance as SKIPPED and never executes', () => {
  const { root, outDir } = tmpProject()
  const outcome = recordAcceptance(outDir, { dryRun: true })
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  if (!outcome.ok) return
  assert.equal(outcome.summary.total, 3)
  assert.equal(outcome.summary.skipped, 3)
  assert.deepEqual(outcome.items.map((item) => item.reason), ['DRY_RUN', 'DRY_RUN', 'RUNNER_NOT_ALLOWED (rm)'])
  const stored = JSON.parse(fs.readFileSync(path.join(outDir, AC_EVIDENCE_REL), 'utf8'))
  assert.equal(stored.items.length, 3)
  assert.equal(stored.summary.skipped, 3)
  fs.rmSync(root, { recursive: true, force: true })
})

test('commands run, exit codes decide PASS/FAIL, unlisted runners are skipped', () => {
  const { root, outDir } = tmpProject()
  const outcome = recordAcceptance(outDir)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  const byId = new Map(outcome.items.map((item) => [item.id, item]))
  assert.equal(byId.get('AC-M1-1')?.status, 'PASS')
  assert.equal(byId.get('AC-M1-1')?.exitCode, 0)
  assert.equal(byId.get('AC-M1-2')?.status, 'FAIL')
  assert.equal(byId.get('AC-M1-2')?.exitCode, 3)
  assert.equal(byId.get('AC-M2-1')?.status, 'SKIPPED')
  assert.match(byId.get('AC-M2-1')?.reason ?? '', /RUNNER_NOT_ALLOWED/)
  assert.equal(outcome.summary.pass, 1)
  assert.equal(outcome.summary.fail, 1)
  fs.rmSync(root, { recursive: true, force: true })
})

test('module filter limits the run and unknown ids are rejected', () => {
  const { root, outDir } = tmpProject()
  const ok = recordAcceptance(outDir, { modules: ['M1'] })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.summary.total, 2)

  const bad = recordAcceptance(outDir, { modules: ['M9'] })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.code, 'PLAN_INVALID')
  fs.rmSync(root, { recursive: true, force: true })
})

test('evidence markdown is written when tasks/ exists', () => {
  const { root, outDir } = tmpProject(basePlan(), true)
  const outcome = recordAcceptance(outDir, { dryRun: true })
  assert.equal(outcome.ok, true)
  const doc = fs.readFileSync(path.join(outDir, TASKS_EVIDENCE_REL), 'utf8')
  assert.match(doc, /# 验收证据：记录演示/)
  assert.match(doc, /PASS 0 \/ FAIL 0 \/ SKIPPED 3/)
  assert.match(doc, /\| AC-M1-1 \| M1 \| SKIPPED \| — \|/)
  fs.rmSync(root, { recursive: true, force: true })
})
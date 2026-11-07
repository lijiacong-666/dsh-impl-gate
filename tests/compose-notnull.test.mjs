// G8: a NOT NULL column without a default must appear in the write signature
// of at least one rowWriter, and compose must hand back the review entry point.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCompose, composeReview, validatePlan } from '../lib/index.js'

const root = path.resolve(import.meta.dirname, '..')
const RUBRIC = ['可开工', '需澄清', '不可开工']

function fnExpose(signature) {
  return { kind: 'fn', signature }
}

function moduleEntry(id, dir, exposes, files) {
  return {
    id,
    dir,
    title: dir,
    responsibility: `${dir} 只负责自己的写入`,
    exposes,
    requires: [],
    constraints: ['失败返回 500'],
    files,
    acceptance: [{ id: `${id}-ok`, assertion: '写入后能按主键读回', test: 'pnpm test' }],
  }
}

function basePlan() {
  return {
    schemaVersion: 1,
    name: 'notnull-demo',
    title: '必填列覆盖演示',
    summary: '演示 G8 的 not-null 列必须能在写入签名里找到字段',
    stack: 'node22+postgres16',
    goals: ['能创建预约'],
    nonGoals: ['不做前端'],
    boundaries: [{ dependency: 'postgres', purpose: '持久化', fallback: '启动失败并报错' }],
    globals: {
      conventions: ['错误码统一 code'],
      forbidden: [],
      envKeys: ['DATABASE_URL'],
      errorShape: '{"error":{"code","message"}}',
    },
    data: [
      {
        table: 'bookings',
        owner: 'M1',
        rowWriters: ['M1'],
        columns: [
          { name: 'id', type: 'uuid', constraints: ['pk'] },
          { name: 'employee_id', type: 'uuid', constraints: ['not null', 'references: employees(id)'] },
          { name: 'starts_at', type: 'timestamptz', constraints: ['not null'] },
          { name: 'created_at', type: 'timestamptz', constraints: ['not null', 'default now()'] },
        ],
      },
      {
        table: 'employees',
        owner: 'M1',
        rowWriters: ['M1'],
        columns: [{ name: 'id', type: 'uuid', constraints: ['pk'] }],
      },
    ],
    types: [
      {
        name: 'BookingInput',
        kind: 'object',
        fields: [
          { name: 'employeeId', type: 'string' },
          { name: 'startsAt', type: 'string' },
        ],
      },
      { name: 'Booking', kind: 'object', fields: [{ name: 'id', type: 'string' }] },
    ],
    modules: [
      moduleEntry(
        'M1',
        'booking-service',
        [fnExpose('createBooking(input: BookingInput): Promise<Booking>')],
        ['booking-service/index.ts'],
      ),
    ],
    deliverables: { tree: 'notnull-demo/', files: [{ path: 'booking-service/index.ts', purpose: '预约写入' }] },
  }
}

function clone(plan) {
  return structuredClone(plan)
}

function findProblem(plan, at) {
  return validatePlan(plan).problems.find((entry) => entry.path === at)
}

function dropField(plan, typeName, fieldName) {
  const type = plan.types.find((entry) => entry.name === typeName)
  type.fields = type.fields.filter((field) => field.name !== fieldName)
}

test('a not-null column missing from every write signature is reported', () => {
  const plan = clone(basePlan())
  dropField(plan, 'BookingInput', 'employeeId')
  const result = validatePlan(plan)
  assert.equal(result.plan, null)
  const found = result.problems.find((entry) => entry.path === '/data/0/columns/1')
  assert.ok(found !== undefined, JSON.stringify(result.problems))
  assert.equal(
    found.message,
    'not-null column "employee_id" has no input field "employeeId" in write signatures of rowWriters (M1)',
  )
})

test('a default on the column exempts it from the coverage check', () => {
  const plan = clone(basePlan())
  dropField(plan, 'BookingInput', 'employeeId')
  plan.data[0].columns[1].constraints = ['not null', 'default gen_random_uuid()']
  assert.equal(findProblem(plan, '/data/0/columns/1'), undefined)
  assert.deepEqual(validatePlan(plan).problems, [])
})

test('created_at / updated_at / deleted_at are exempt even without a default', () => {
  for (const name of ['created_at', 'updated_at', 'deleted_at']) {
    const plan = clone(basePlan())
    plan.data[0].columns = [{ name, type: 'timestamptz', constraints: ['not null'] }]
    assert.equal(findProblem(plan, '/data/0/columns/0'), undefined, name)
    assert.deepEqual(validatePlan(plan).problems, [], name)
  }
})

test('any rowWriter signature may satisfy the column', () => {
  const plan = clone(basePlan())
  dropField(plan, 'BookingInput', 'employeeId')
  plan.data[0].rowWriters = ['M1', 'M2']
  plan.modules.push(
    moduleEntry('M2', 'ledger', [fnExpose('recordBooking(employeeId: string): Promise<Booking>')], ['ledger/index.ts']),
  )
  plan.deliverables.files.push({ path: 'ledger/index.ts', purpose: '账本写入' })
  const result = validatePlan(plan)
  assert.deepEqual(result.problems, [])
  assert.ok(result.plan !== null)
})

test('a parameter named like the column counts as the input field', () => {
  const plan = clone(basePlan())
  plan.modules[0].exposes = [fnExpose('createBooking(employeeId: string, startsAt: string): Promise<Booking>')]
  assert.deepEqual(validatePlan(plan).problems, [])
})

test('references and generated do not relax the field lookup', () => {
  const plan = clone(basePlan())
  dropField(plan, 'BookingInput', 'employeeId')
  plan.data[0].columns[1].constraints = ['not null', 'generated always', 'references: employees(id)']
  const found = findProblem(plan, '/data/0/columns/1')
  assert.ok(found !== undefined)
  assert.match(found.message, /not-null column "employee_id" has no input field "employeeId"/)
})

test('Omit/Partial wrappers are not exempted from the field lookup', () => {
  for (const wrapper of ['Omit<BookingInput, "employeeId">', 'Partial<BookingInput>']) {
    const plan = clone(basePlan())
    plan.modules[0].exposes = [fnExpose(`createBooking(input: ${wrapper}): Promise<Booking>`)]
    const found = findProblem(plan, '/data/0/columns/1')
    assert.ok(found !== undefined, wrapper)
    assert.match(found.message, /employeeId/)
  }
})

test('only fields of the declared input type count, not a sibling type', () => {
  const plan = clone(basePlan())
  plan.types.push({ name: 'BookingDraft', kind: 'object', fields: [{ name: 'startsAt', type: 'string' }] })
  plan.modules[0].exposes = [fnExpose('createBooking(input: BookingDraft): Promise<Booking>')]
  const found = findProblem(plan, '/data/0/columns/1')
  assert.ok(found !== undefined)
  assert.match(found.message, /no input field "employeeId"/)
})

test('a camelCase column name is matched without conversion', () => {
  const plan = clone(basePlan())
  plan.data[0].columns[1].name = 'employeeId'
  assert.deepEqual(validatePlan(plan).problems, [])
  dropField(plan, 'BookingInput', 'employeeId')
  assert.ok(findProblem(plan, '/data/0/columns/1') !== undefined)
})

test('plan mode returns a review entry whose playbook resolves on disk', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-g8-plan-'))
  try {
    const result = await buildCompose({ outDir, mode: 'plan' }, {})
    assert.equal(result.ok, true)
    assert.deepEqual(result.review.rubric, RUBRIC)
    assert.equal(result.review.playbook, path.join(root, 'playbooks', 'review.md'))
    assert.equal(fs.existsSync(result.review.playbook), true)
    assert.equal(result.review.specPath, path.join(outDir, 'SPEC.md'))
    assert.equal(path.isAbsolute(result.review.specPath), true)
    assert.equal(fs.existsSync(result.draftPath), true)
    assert.equal(composeReview(outDir).specPath, result.review.specPath)
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

test('materialize mode returns the same review entry', async (t) => {
  const home = process.env.IMPL_GATE_SPECGRAPH_HOME ?? 'D:\\ruanjian\\deepharness\\spec-graph'
  if (!fs.existsSync(path.join(home, 'specgraph', '__init__.py'))) {
    t.skip(`no specgraph checkout at ${home}`)
    return
  }
  const probe = spawnSync('python', ['-c', 'import specgraph'], { env: { ...process.env, PYTHONPATH: home } })
  if (probe.status !== 0) {
    t.skip('host python cannot import specgraph even with PYTHONPATH')
    return
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-g8-mat-'))
  try {
    fs.writeFileSync(path.join(outDir, 'compose-plan.json'), JSON.stringify(basePlan()))
    const result = await buildCompose(
      { outDir, mode: 'materialize', specgraphCwd: home },
      { specgraphCommand: 'python -m specgraph', pythonPath: '', specgraphCwd: home, timeoutMs: 60000 },
    )
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    assert.deepEqual(result.review.rubric, RUBRIC)
    assert.equal(result.review.playbook, path.join(root, 'playbooks', 'review.md'))
    assert.equal(result.review.specPath, path.join(outDir, 'SPEC.md'))
    assert.equal(fs.existsSync(result.review.specPath), true)
    const spec = fs.readFileSync(result.review.specPath, 'utf8')
    // G8.1: materialize must carry the per-module constraints into SPEC.md.
    assert.match(spec, /### 3\.1 模块约束/)
    assert.match(spec, /^\| M1 \| 失败返回 500 \|$/m)
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

test('review.md carries the five mandatory checks, the pass line and the prompt', () => {
  const text = fs.readFileSync(path.join(root, 'playbooks', 'review.md'), 'utf8')
  for (const heading of [
    '类型字段与来源',
    '表 owner、rowWriters 与 FK 写入',
    '错误码形状与构造通道',
    '原子操作的共同事务句柄',
    'HTTP 覆盖与归属',
  ]) {
    assert.ok(text.includes(heading), heading)
  }
  assert.match(text, /≥80%/)
  assert.match(text, /最多 3 轮/)
  assert.match(text, /缩小范围/)
  const block = text.match(/```text\n([\s\S]*?)\n```/)
  assert.ok(block !== null)
  assert.ok(block[1].length <= 600, `prompt is ${block[1].length} chars`)
  assert.match(block[1], /只读/)
  assert.match(block[1], /600/)
  assert.match(block[1], /禁止写代码/)
})

test('review.md is packaged with the other playbooks', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('playbooks/review.md'))
})

test('compose.md shows a function-signature kind:"http" expose and points at review.md', () => {
  const text = fs.readFileSync(path.join(root, 'playbooks', 'compose.md'), 'utf8')
  assert.match(text, /"kind": "http"/)
  assert.ok(text.includes('login(input: LoginInput): Promise<SessionToken>'))
  assert.match(text, /review\.md/)
})

test('deviations registers the heuristic not-null check as D-16', () => {
  const text = fs.readFileSync(path.join(root, 'docs', 'deviations.md'), 'utf8')
  assert.match(text, /\| D-16 \|/)
  assert.match(text, /启发式/)
  assert.match(text, /default/)
})
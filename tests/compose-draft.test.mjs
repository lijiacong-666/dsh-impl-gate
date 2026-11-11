// Draft mode is a preview: it must accept plans written for older schemas,
// never touch compose-plan.json, and point its review prompt at SPEC-DRAFT.md.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildCompose, composeReview } from '../lib/index.js'

const example = path.resolve(import.meta.dirname, '..', 'playbooks', 'examples', 'login.md')
const base = () => {
  const md = fs.readFileSync(example, 'utf8')
  return JSON.parse(md.match(/```json\n([\s\S]*?)```/)[1])
}

function project(plan) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-draft-'))
  fs.writeFileSync(path.join(dir, 'compose-plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return dir
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

test('draft accepts a 0.3.x plan without flows/ui/runtime/owner/unit/auth/status', async () => {
  const plan = base()
  delete plan.flows
  delete plan.ui
  delete plan.runtime
  for (const type of plan.types ?? []) {
    delete type.owner
    for (const field of type.fields ?? []) delete field.unit
  }
  for (const route of plan.http ?? []) {
    delete route.auth
    delete route.status
    delete route.query
  }
  const dir = project(plan)
  const result = await buildCompose({ outDir: dir, mode: 'draft' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.problems ?? [], [])
  assert.ok(fs.existsSync(path.join(dir, 'SPEC-DRAFT.md')))
})

test('draft reports missing plan-level sections but still renders', async () => {
  const plan = base()
  delete plan.deliverables
  const dir = project(plan)
  const result = await buildCompose({ outDir: dir, mode: 'draft' })
  assert.equal(result.ok, true)
  assert.ok((result.missingSlots ?? []).includes('plan: deliverables'))
  assert.ok(fs.existsSync(path.join(dir, 'SPEC-DRAFT.md')))
})

test('draft never rewrites the plan and points review at the draft', async () => {
  const plan = base()
  const dir = project(plan)
  const planPath = path.join(dir, 'compose-plan.json')
  const before = sha(planPath)
  const result = await buildCompose({ outDir: dir, mode: 'draft' })
  assert.equal(sha(planPath), before)
  assert.equal(result.planPath, planPath)
  assert.ok(String(result.review?.specPath).endsWith('SPEC-DRAFT.md'))
  assert.match(result.review?.prompt ?? '', /草稿/)
  assert.match(result.review?.prompt ?? '', /不调用 impl_gate_review/)
})

test('materialize review still points at SPEC.md', () => {
  const review = composeReview('D:/tmp/whatever')
  assert.ok(review.specPath.endsWith('SPEC.md'))
  assert.doesNotMatch(review.specPath, /DRAFT/)
})
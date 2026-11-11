// The example plan in playbooks/examples/login.md is what a model copies. It
// rotted once already (the schema gained flows/ui/runtime/auth/status/unit and
// the example kept teaching the 0.2 shape). This test keeps it valid and keeps
// it demonstrating the parts a reader would otherwise never see.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { validatePlan } from '../lib/index.js'

const root = path.resolve(import.meta.dirname, '..')
const md = fs.readFileSync(path.join(root, 'playbooks/examples/login.md'), 'utf8')
const block = md.match(/```json\n([\s\S]*?)```/)
assert.ok(block, 'login.md must contain a ```json plan block')

const plan = JSON.parse(block[1])

test('the example plan still validates against the current schema', () => {
  const result = validatePlan(plan)
  const messages = (result.problems ?? []).map((p) => `${p.path}: ${p.message}`)
  assert.deepEqual(messages, [])
})

test('the example demonstrates the 0.4 contract fields', () => {
  assert.ok(plan.flows?.length, 'needs at least one flow')
  assert.ok(plan.ui?.length, 'needs at least one page')
  assert.ok(plan.runtime?.port, 'needs a runtime block')
  assert.ok(
    plan.http.every((h) => typeof h.auth === 'string'),
    'every route should state auth'
  )
  assert.ok(
    plan.http.every((h) => Number.isInteger(h.status)),
    'every route should state a success status'
  )
  assert.ok(
    plan.types.some((t) => t.owner),
    'shared types should show owner'
  )
  assert.ok(
    plan.types.some((t) => (t.fields ?? []).some((f) => f.unit)),
    'at least one numeric field should show unit'
  )
})
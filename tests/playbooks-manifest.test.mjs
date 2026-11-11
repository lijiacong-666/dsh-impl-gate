// The playbooks are what a model reads before writing a plan or a review. If a
// field exists in the schema but is missing from the playbook, the model never
// uses it (that is how `unit` slipped through 0.4.10 → 0.4.30). These assertions
// keep the two sides honest.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

const planSource = read('src/host/compose/plan.ts')
const compose = read('playbooks/compose.md')
const review = read('playbooks/review.md')

function keysOf(constName) {
  const m = planSource.match(new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  assert.ok(m, `could not find ${constName} in plan.ts`)
  return [...new Set([...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((x) => x[1]))]
}

const SETS = [
  'ROOT_KEYS',
  'MODULE_KEYS',
  'TYPE_KEYS',
  'TYPE_FIELD_KEYS',
  'ERROR_KEYS',
  'HTTP_KEYS',
  'HTTP_QUERY_KEYS',
  'FLOW_KEYS'
]

for (const name of SETS) {
  test(`${name} fields are all mentioned in playbooks/compose.md`, () => {
    const missing = keysOf(name).filter((k) => !compose.includes(k))
    assert.deepEqual(missing, [], `document these in playbooks/compose.md: ${missing.join(', ')}`)
  })
}

test('compose.md covers the three tool modes', () => {
  for (const mode of ['plan', 'draft', 'materialize']) {
    assert.ok(compose.includes(`"${mode}"`) || compose.includes(mode), `compose.md never mentions mode ${mode}`)
  }
})

test('review.md keeps the tri-state rubric and the pass line', () => {
  for (const status of ['可开工', '需澄清', '不可开工']) {
    assert.ok(review.includes(status), `review.md never mentions ${status}`)
  }
  assert.ok(/blocking\s*=\s*0/.test(review), 'review.md must state the pass line blocking = 0')
})

test('review.md tells the reviewer to write evidence with SPEC line numbers', () => {
  assert.match(review, /SPEC\.md:(?:<行号>|\d+)/)
})
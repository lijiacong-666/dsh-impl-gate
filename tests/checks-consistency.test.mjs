// Data-source consistency for checks/impl-gate.checks.json.
//
// Two layers:
//   1. structural: the JSON itself must satisfy the field contract in
//      TASK-dsh-impl-gate-v1.md §2 and carry exactly the 32 expected ids;
//   2. cross-file: when IMPL_GATE_SPEC_PATH points at
//      IMPL-GATE-执行清单-v1.txt, the id set in the JSON must equal the id set
//      scraped from that file (both difference directions empty).
//
// The cross-file check is skipped explicitly — with a printed reason — when the
// environment variable is absent. A silent pass is forbidden.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const CHECKS_URL = new URL('../checks/impl-gate.checks.json', import.meta.url)
const data = JSON.parse(fs.readFileSync(CHECKS_URL, 'utf8'))
const items = data.items

const FIELDS = [
  'id',
  'group',
  'title',
  'mode',
  'runtime',
  'requires',
  'notRunReason',
  'command',
  'assert',
]
const GROUPS = { A: 5, B: 7, M: 10, Q: 10 }
const EXPECTED_IDS = [
  ...Array.from({ length: 5 }, (_, i) => `A${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `B${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `M${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Q${i + 1}`),
]
const MODES = new Set(['auto', 'manual', 'notrun'])
const RUNTIMES = new Set(['fast', 'slow'])
// TASK §5 reasons, plus NOT_IMPLEMENTED (TASK v1.1 §0) and the two reasons this
// data source adds where the task gives no code: B1's missing mapping table and
// B4's manual arbitration record. Both are registered as deviations.
const REASONS = new Set([
  'MISSING_INSTRUCTION_PACKAGE',
  'CHECKLIST_NOT_PROVIDED',
  'IMPL_ROOT_NOT_PROVIDED',
  'LANGUAGE_UNSUPPORTED',
  'GIT_UNAVAILABLE',
  'SLOW_CHECK_DISABLED',
  'NETWORK_BLOCK_UNSUPPORTED',
  'SCHEMA_UNAVAILABLE',
  'D4_GRAPH_INVALID',
  'GUI_REQUIRES_MANUAL_CHECK',
  'NOT_IMPLEMENTED',
  'MAPPING_TABLE_NOT_PROVIDED',
  'MANUAL_REVIEW_REQUIRED',
  'EXEC_DISABLED',
  'HUMAN_PROCESS_REQUIRED',
  'EVIDENCE_TOKEN_UNSPECIFIED',
])

test('checks.json is data, versioned, and not a string[] shortcut', () => {
  assert.equal(data.version, '1.0')
  assert.ok(Array.isArray(items), 'items must be an array')
  for (const item of items) {
    assert.equal(typeof item, 'object', `item is not an object: ${JSON.stringify(item)}`)
    assert.notEqual(item, null)
  }
})

test('ids are unique and shaped A/B/M/Q + number', () => {
  const ids = items.map((item) => item.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate id')
  for (const id of ids) assert.match(id, /^[ABMQ](?:[1-9]|10)$/, `bad id: ${id}`)
})

test('all 32 expected ids are present, no extra ids', () => {
  const ids = new Set(items.map((item) => item.id))
  assert.deepEqual(
    [...ids].sort(),
    [...EXPECTED_IDS].sort(),
    'id set differs from the expected 32',
  )
})

test('group sizes are A:5 B:7 M:10 Q:10', () => {
  const counts = { A: 0, B: 0, M: 0, Q: 0 }
  for (const item of items) {
    assert.ok(item.group in counts, `unknown group: ${item.group}`)
    counts[item.group] += 1
    assert.equal(
      item.id.replace(/\d+$/, ''),
      item.group,
      `id ${item.id} does not belong to group ${item.group}`,
    )
  }
  assert.deepEqual(counts, GROUPS)
})

test('every item carries exactly the nine contract fields', () => {
  for (const item of items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      [...FIELDS].sort(),
      `field set of ${item.id} violates TASK §2`,
    )
    assert.equal(typeof item.title, 'string')
    assert.ok(item.title.length > 0, `${item.id} has an empty title`)
  }
})

test('mode and runtime use the fixed vocabulary', () => {
  for (const item of items) {
    assert.ok(MODES.has(item.mode), `${item.id} has bad mode ${item.mode}`)
    assert.ok(RUNTIMES.has(item.runtime), `${item.id} has bad runtime ${item.runtime}`)
    if (item.runtime === 'slow') assert.equal(item.mode, 'auto', `${item.id}: slow must be auto`)
  }
})

test('requires is a list of unique non-empty tokens', () => {
  for (const item of items) {
    assert.ok(Array.isArray(item.requires), `${item.id}: requires must be an array`)
    for (const token of item.requires)
      assert.equal(typeof token, 'string', `${item.id}: requires token must be a string`)
    assert.equal(new Set(item.requires).size, item.requires.length, `${item.id}: duplicate require`)
  }
})

test('notRunReason is null or a known code; manual/notrun must have one', () => {
  for (const item of items) {
    const reason = item.notRunReason
    if (reason !== null) {
      assert.equal(typeof reason, 'string', `${item.id}: reason must be string or null`)
      assert.ok(REASONS.has(reason), `${item.id}: unknown reason ${reason}`)
    }
    if (item.mode !== 'auto')
      assert.ok(reason, `${item.id}: mode ${item.mode} requires a notRunReason`)
  }
})

test('command and assert are non-empty and commands are unique', () => {
  const commands = new Set()
  for (const item of items) {
    assert.equal(typeof item.command, 'string', `${item.id}: command must be a string`)
    assert.ok(item.command.length > 0, `${item.id}: empty command`)
    assert.ok(!commands.has(item.command), `${item.id}: duplicate command ${item.command}`)
    commands.add(item.command)
    assert.equal(typeof item.assert, 'string', `${item.id}: assert must be a string`)
    assert.ok(item.assert.length > 0, `${item.id}: empty assert`)
  }
})

const specPath = process.env.IMPL_GATE_SPEC_PATH
if (!specPath) {
  console.log(
    '[checks-consistency] SKIP bidirectional diff: IMPL_GATE_SPEC_PATH is not set. ' +
      'Structural checks above still ran; set it to IMPL-GATE-执行清单-v1.txt to enable ' +
      'the id-set comparison against the spec.',
  )
}

test(
  'id set equals the spec, both difference directions empty',
  { skip: specPath ? false : 'IMPL_GATE_SPEC_PATH not set' },
  () => {
    assert.ok(specPath, 'unreachable: guarded by skip')
    assert.ok(fs.existsSync(specPath), `IMPL_GATE_SPEC_PATH does not exist: ${specPath}`)
    const text = fs.readFileSync(specPath, 'utf8')
    const specIds = [...text.matchAll(/^[ABMQ]\d+(?=\s)/gm)].map((match) => match[0])
    assert.equal(new Set(specIds).size, 32, 'spec must yield exactly 32 unique ids')

    const jsonIds = items.map((item) => item.id)
    const missingInJson = specIds.filter((id) => !jsonIds.includes(id))
    const extraInJson = jsonIds.filter((id) => !specIds.includes(id))
    assert.deepEqual(missingInJson, [], `ids in spec but missing from checks.json: ${missingInJson}`)
    assert.deepEqual(extraInJson, [], `ids in checks.json but missing from spec: ${extraInJson}`)
  },
)
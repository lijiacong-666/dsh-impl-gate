// DSH tool-schema subset guard (Step 2 review requirement).
// DSH validates schemas at registration time and rejects anything outside its
// enforced subset (dsh-tools/json-schema). A rejected schema means the tool
// silently never appears, so this test mirrors the host validator and fails
// `pnpm verify` on any violation.
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTools } from '../lib/index.js'

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const CONSTRAINT_KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

function validateSchema(schema, trail) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${trail}: schema must be an object`)
  // oneOf is technically allowed by DSH, but this plugin forbids it by policy.
  for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'nullable']) {
    assert.ok(!(keyword in schema), `${trail}: "${keyword}" is not allowed in this plugin`)
  }
  for (const key of Object.keys(schema)) {
    assert.ok(
      CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key),
      `${trail}: "${key}" is not a supported keyword`,
    )
  }
  if ('description' in schema) assert.equal(typeof schema.description, 'string', `${trail}.description must be a string`)
  if ('title' in schema) assert.equal(typeof schema.title, 'string', `${trail}.title must be a string`)

  assert.ok('type' in schema, `${trail}: every subschema must declare a single type`)
  assert.equal(typeof schema.type, 'string', `${trail}.type must be a single type string`)
  assert.ok(SCHEMA_TYPES.has(schema.type), `${trail}.type "${schema.type}" is not supported`)
  const type = schema.type

  const placed = { properties: 'object', required: 'object', additionalProperties: 'object', items: 'array' }
  for (const [key, expected] of Object.entries(placed)) {
    if (!(key in schema)) continue
    assert.equal(type, expected, `${trail}.${key} is not supported on type "${type}"`)
  }
  for (const key of ['enum', 'const']) {
    if (!(key in schema)) continue
    assert.ok(SCALAR_TYPES.has(type), `${trail}.${key} is not supported on type "${type}"`)
  }

  if ('additionalProperties' in schema) {
    assert.equal(typeof schema.additionalProperties, 'boolean', `${trail}.additionalProperties must be a boolean`)
  }
  if ('properties' in schema) {
    assert.ok(schema.properties !== null && typeof schema.properties === 'object', `${trail}.properties must be an object`)
    for (const [key, child] of Object.entries(schema.properties)) {
      validateSchema(child, `${trail}.properties.${key}`)
    }
  }
  if ('required' in schema) {
    assert.ok(Array.isArray(schema.required), `${trail}.required must be an array`)
    for (const name of schema.required) {
      assert.equal(typeof name, 'string', `${trail}.required entries must be strings`)
      assert.ok(
        schema.properties !== undefined && Object.hasOwn(schema.properties, name),
        `${trail}.required names "${name}" which is not in properties`,
      )
    }
  }
  if ('items' in schema) {
    assert.ok(schema.items !== null && typeof schema.items === 'object', `${trail}.items must be an object`)
    validateSchema(schema.items, `${trail}.items`)
  }
}

function definitions() {
  return buildTools({
    config: {
      specgraphCommand: 'python -m specgraph',
      pythonPath: '',
      specgraphCwd: '',
      timeoutMs: 30000,
      implRoot: '',
      slow: false,
    },
  })
}

test('exactly four tools are registered', () => {
  const names = definitions().map((tool) => tool.name)
  assert.deepEqual(names, [
    'impl_gate_check',
    'impl_gate_report',
    'impl_gate_verify_contract',
    'impl_gate_compose',
  ])
})

test('every tool definition satisfies the DSH schema subset', () => {
  for (const tool of definitions()) {
    assert.equal(tool.parameters.type, 'object', `${tool.name}.parameters must be object-rooted`)
    validateSchema(tool.parameters, `${tool.name}.parameters`)
    assert.ok(tool.output !== undefined, `${tool.name}.output is required`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name}.output.schema must be object-rooted`)
    validateSchema(tool.output.schema, `${tool.name}.output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name}.output.render must be a function`)
  }
})

test('evidence is an array of {id,text}, not an object map', () => {
  const check = definitions().find((tool) => tool.name === 'impl_gate_check')
  const evidence = check.output.schema.properties.evidence
  assert.equal(evidence.type, 'array')
  assert.equal(evidence.items.type, 'object')
  assert.equal(evidence.items.additionalProperties, false)
  assert.deepEqual(Object.keys(evidence.items.properties).sort(), ['id', 'text'])
})

test('the guard rejects the schema shapes DSH refused', () => {
  assert.throws(() => validateSchema({ type: ['string', 'null'] }, 'bad.typeArray'), /single type string/)
  assert.throws(
    () => validateSchema({ type: 'object', additionalProperties: { type: 'string' } }, 'bad.map'),
    /must be a boolean/,
  )
  assert.throws(() => validateSchema({ oneOf: [{ type: 'string' }] }, 'bad.oneOf'), /not allowed in this plugin/)
  assert.throws(() => validateSchema({ type: 'string', nullable: true }, 'bad.nullable'), /not allowed in this plugin/)
  assert.throws(
    () => validateSchema({ type: 'object', properties: {}, required: ['ghost'] }, 'bad.required'),
    /not in properties/,
  )
})
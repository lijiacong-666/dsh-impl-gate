// The warning catalogue is a user-facing promise: the number in the READMEs, the
// table in docs/WARNINGS.md and the union type in materialize.ts must agree, and
// every code must have at least one test that exercises it. This guards against
// the usual drift (a code added to the type, forgotten in the docs).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

const source = read('src/host/compose/materialize.ts')
const unionBlock = source.match(/export interface ComposeWarning \{[\s\S]*?\n\}/)?.[0] ?? ''
const codes = [...new Set([...unionBlock.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]))].sort()

const docs = read('docs/WARNINGS.md')
const docCodes = [
  ...new Set([...docs.matchAll(/^\| `([A-Z][A-Z0-9_]+)`/gm)].map((m) => m[1]))
].sort()

const readmeZh = read('README.md')
const readmeEn = read('README.en.md')

function mentionedInTests(code) {
  const dir = path.join(root, 'tests')
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.mjs') || name === 'warnings-manifest.test.mjs') continue
    if (fs.readFileSync(path.join(dir, name), 'utf8').includes(code)) return name
  }
  return null
}

test('the warning union has a stable size', () => {
  assert.ok(codes.length > 20, `expected a populated union, got ${codes.length}`)
})

test('docs/WARNINGS.md lists exactly the codes in the union type', () => {
  assert.deepEqual(docCodes, codes)
})

test('both READMEs state the real number of warning kinds', () => {
  assert.match(readmeZh, new RegExp(`共 ${codes.length} 类`))
  assert.match(readmeEn, new RegExp(`There are ${codes.length} kinds`))
})

test('every warning code is exercised by at least one test', () => {
  const missing = codes.filter((code) => mentionedInTests(code) === null)
  assert.deepEqual(missing, [], `no test mentions: ${missing.join(', ')}`)
})
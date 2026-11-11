// Every warning code documented in docs/WARNINGS.md must have a reproduction
// row, and that row must point at a test file that actually mentions the code.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repo = path.resolve(import.meta.dirname, '..')
const warnings = fs.readFileSync(path.join(repo, 'docs', 'WARNINGS.md'), 'utf8')
const testDir = path.join(repo, 'tests')

const codes = [...new Set([...warnings.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((m) => m[1]))]
const reproduction = new Map()
const section = warnings.split('## 每条警告的最小复现')[1] ?? ''
for (const m of section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| ([^|]+) \|$/gm)) {
  reproduction.set(m[1], m[2].trim())
}

test('the warning catalogue and its reproduction table list the same codes', () => {
  assert.deepEqual([...reproduction.keys()].sort(), [...codes].sort())
})

test('every reproduction row points at a test file that mentions the code', () => {
  for (const [code, file] of reproduction) {
    const full = path.join(testDir, file)
    assert.ok(fs.existsSync(full), `${code}: ${file} does not exist`)
    const body = fs.readFileSync(full, 'utf8')
    assert.ok(
      body.includes(`'${code}'`) || body.includes(`"${code}"`) || body.includes(code),
      `${code}: ${file} never mentions it`
    )
  }
})

test('no reproduction row survives after its warning is removed', () => {
  for (const code of reproduction.keys()) assert.ok(codes.includes(code), `${code} is documented but unlisted`)
})
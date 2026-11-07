import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { findSpecgraphHome } from '../lib/index.js'

function makeTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-resolve-'))
  const workspace = path.join(tmp, 'workspace')
  const checkout = path.join(workspace, 'spec-graph')
  fs.mkdirSync(path.join(checkout, 'specgraph'), { recursive: true })
  fs.writeFileSync(path.join(checkout, 'specgraph', '__init__.py'), '')
  const start = path.join(workspace, 'a', 'b', 'c')
  fs.mkdirSync(start, { recursive: true })
  return { tmp, workspace, checkout, start }
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

test('findSpecgraphHome finds a sibling spec-graph checkout', (t) => {
  const tree = makeTree()
  t.after(() => fs.rmSync(tree.tmp, { recursive: true, force: true }))
  assert.ok(samePath(findSpecgraphHome(tree.start) ?? '', path.resolve(tree.checkout)))
})

test('probed lists every visited ancestor and marks the hit', (t) => {
  const tree = makeTree()
  t.after(() => fs.rmSync(tree.tmp, { recursive: true, force: true }))
  const probed = []
  const home = findSpecgraphHome(tree.start, probed)
  assert.ok(samePath(home ?? '', path.resolve(tree.checkout)))
  const expected = [tree.start, path.join(tree.workspace, 'a', 'b'), path.join(tree.workspace, 'a')]
  for (const dir of expected) {
    assert.ok(probed.some((entry) => samePath(entry.replace(/ -> hit$/, ''), dir)), `missing probe for ${dir}`)
  }
  const workspaceEntry = probed.find((entry) => samePath(entry.replace(/ -> hit$/, ''), tree.workspace))
  assert.ok(workspaceEntry?.endsWith(' -> hit'), 'workspace entry should carry the hit marker')
  assert.equal(new Set(probed).size, probed.length, 'probed must be de-duplicated')
})

test('a renamed checkout resolves to undefined but probed still lists the walk', (t) => {
  const tree = makeTree()
  t.after(() => fs.rmSync(tree.tmp, { recursive: true, force: true }))
  const checkout = path.join(tree.workspace, 'spec-graph')
  fs.renameSync(checkout, path.join(tree.workspace, 'other-spec'))
  const probed = []
  assert.equal(findSpecgraphHome(tree.start, probed), undefined)
  assert.ok(probed.length >= 4, `expected at least 4 probes, got ${probed.length}`)
  assert.ok(probed.some((entry) => samePath(entry.replace(/ -> hit$/, ''), tree.workspace)))
  assert.ok(!probed.some((entry) => entry.endsWith(' -> hit')), 'no hit marker may appear')
})

test('a relative start resolves against cwd before walking up', (t) => {
  const tree = makeTree()
  const original = process.cwd()
  t.after(() => {
    process.chdir(original)
    fs.rmSync(tree.tmp, { recursive: true, force: true })
  })
  process.chdir(tree.tmp)
  const relative = path.relative(process.cwd(), tree.start)
  assert.ok(!path.isAbsolute(relative))
  const home = findSpecgraphHome(relative)
  assert.ok(samePath(home ?? '', path.resolve(tree.checkout)))
})
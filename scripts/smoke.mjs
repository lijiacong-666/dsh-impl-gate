#!/usr/bin/env node
// End-to-end smoke: materialize -> init -> check on every real plan kept outside the package.
// `node scripts/smoke.mjs --update` refreshes the snapshot; plain run fails on drift.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildCompose, buildInit, runCheck } from '../lib/index.js'

const REPO = path.resolve(import.meta.dirname, '..')
const SNAPSHOT = path.join(REPO, 'scripts', 'smoke-snapshots.json')
const SPECGRAPH_CWD = path.resolve(REPO, '..', '..', 'spec-graph')

const FIXTURES = [
  { name: 'mini', plan: path.resolve(REPO, '..', '_e2e', 'mini', 'compose-plan.json') },
  { name: 'fitness', plan: path.resolve(REPO, '..', '_e2e', 'fitness', 'compose-plan.json') },
  { name: 'pillbox', plan: path.resolve(REPO, '..', '_e2e', 'pillbox', 'compose-plan.json') },
  { name: 'run-log', plan: path.resolve(REPO, '..', '..', 'run-log', 'compose-plan.json') },
]

const config = {
  specgraphCommand: 'python -m specgraph',
  pythonPath: '',
  specgraphCwd: SPECGRAPH_CWD,
  timeoutMs: 60000,
  implRoot: '',
  slow: false,
  allowCommandReplay: false,
}

const update = process.argv.includes('--update')
const snapshots = update || !fs.existsSync(SNAPSHOT) ? {} : JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'))
const failures = []
const lines = []

function findGraphRoot(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(dir, entry.name)
    if (fs.existsSync(path.join(candidate, 'graph.toml'))) return candidate
  }
  return path.join(dir, 'missing-graph')
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-smoke-'))

for (const fixture of FIXTURES) {
  if (!fs.existsSync(fixture.plan)) {
    lines.push(`${fixture.name.padEnd(9)} SKIP  plan missing: ${fixture.plan}`)
    continue
  }
  const outDir = path.join(tmpRoot, fixture.name)
  fs.mkdirSync(outDir, { recursive: true })
  fs.copyFileSync(fixture.plan, path.join(outDir, 'compose-plan.json'))

  const composed = await buildCompose({ mode: 'materialize', outDir, overwrite: true, specgraphCwd: SPECGRAPH_CWD }, config)
  if (!composed || composed.ok !== true) {
    failures.push(`${fixture.name}: materialize failed — ${JSON.stringify(composed && composed.error)}`)
    lines.push(`${fixture.name.padEnd(9)} FAIL  materialize`)
    continue
  }

  const codes = (composed.warnings ?? []).map((warning) => warning.code)
  const specBytes = fs.statSync(path.join(outDir, 'SPEC.md')).size

  const inited = buildInit({ outDir, overwrite: true })
  if (!inited || inited.ok !== true) {
    failures.push(`${fixture.name}: init failed — ${JSON.stringify(inited && inited.error)}`)
    lines.push(`${fixture.name.padEnd(9)} FAIL  init`)
    continue
  }

  const checked = await runCheck({ graphRoot: findGraphRoot(outDir), implRoot: outDir }, { config })
  if (!checked || checked.error !== undefined || !Array.isArray(checked.passed)) {
    failures.push(`${fixture.name}: check failed — ${JSON.stringify(checked && checked.error)}`)
    lines.push(`${fixture.name.padEnd(9)} FAIL  check`)
    continue
  }

  const actual = {
    warnings: codes,
    cards: (inited.cards ?? []).length,
    passed: checked.passed.length,
    failed: checked.failed.length,
  }
  const expected = snapshots[fixture.name]
  if (update || expected === undefined) {
    snapshots[fixture.name] = actual
    lines.push(`${fixture.name.padEnd(9)} NEW   warnings=${actual.warnings.length} cards=${actual.cards} check=${actual.passed}/${actual.failed}`)
    continue
  }

  const sameWarnings = JSON.stringify(actual.warnings) === JSON.stringify(expected.warnings)
  const sameShape = actual.cards === expected.cards && actual.passed === expected.passed && actual.failed === expected.failed
  if (!sameWarnings || !sameShape) {
    failures.push(
      `${fixture.name}: snapshot drift — warnings ${JSON.stringify(actual.warnings)} vs ${JSON.stringify(expected.warnings)}; ` +
        `cards ${actual.cards} vs ${expected.cards}; check ${actual.passed}/${actual.failed} vs ${expected.passed}/${expected.failed}`,
    )
    lines.push(`${fixture.name.padEnd(9)} DRIFT`)
    continue
  }
  lines.push(`${fixture.name.padEnd(9)} OK    spec=${specBytes}B warnings=${actual.warnings.length} cards=${actual.cards} check=${actual.passed} pass`)
}

if (update) fs.writeFileSync(SNAPSHOT, `${JSON.stringify(snapshots, null, 2)}\n`, 'utf8')
fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log(lines.join('\n'))
if (failures.length > 0) {
  console.error(`\nsmoke failed (${failures.length}):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('\nsmoke ok')
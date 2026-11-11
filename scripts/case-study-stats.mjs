#!/usr/bin/env node
// Prints the numbers quoted in docs/CASE-STUDY-*.md so they can be re-checked
// after the example plans change. The example artifacts live outside this
// package (_e2e/, run-log/), so this script skips what it cannot find.
import fs from 'node:fs'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const cases = [
  ['mini', path.join(repo, '..', '_e2e', 'mini')],
  ['fitness', path.join(repo, '..', '_e2e', 'fitness')],
  ['pillbox', path.join(repo, '..', '_e2e', 'pillbox')],
  ['run-log', path.join(repo, '..', '..', 'run-log')]
]

let found = 0
for (const [name, dir] of cases) {
  const planPath = path.join(dir, 'compose-plan.json')
  const specPath = path.join(dir, 'SPEC.md')
  if (!fs.existsSync(planPath) || !fs.existsSync(specPath)) {
    console.log(`${name}: skipped (no artifact at ${dir})`)
    continue
  }
  found += 1
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
  const spec = fs.readFileSync(specPath, 'utf8')
  const ac = plan.modules.reduce((n, m) => n + (m.acceptance ?? []).length, 0)
  const files = plan.modules.reduce((n, m) => n + (m.files ?? []).length, 0)
  console.log(
    [
      name.padEnd(8),
      `modules ${plan.modules.length}`.padEnd(11),
      `routes ${(plan.http ?? []).length}`.padEnd(10),
      `ac ${ac}`.padEnd(6),
      `whitelisted files ${files}`.padEnd(21),
      `spec ${spec.split('\n').length} lines / ${(Buffer.byteLength(spec) / 1024).toFixed(1)} KB`
    ].join(' | ')
  )
}

if (found === 0) {
  console.log('no case-study artifacts found; nothing to check')
}
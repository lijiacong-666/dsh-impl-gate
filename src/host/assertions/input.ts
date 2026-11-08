// A2–A5: everything that can be judged from the delivered checklist plus the
// pre/post hash snapshot of the inspected graph.
import type { Assertion, AssertionContext, AssertionOutcome } from './types.js'
import { auditChecklist } from '../checklist.js'
import { splitCommand } from '../specgraph.js'

function checklistMissing(): AssertionOutcome {
  return { status: 'NOT-RUN', evidence: '', reason: 'CHECKLIST_NOT_PROVIDED' }
}

function firstProblems(problems: string[], limit = 6): string {
  if (problems.length === 0) return ''
  const head = problems.slice(0, limit).join(' | ')
  return problems.length > limit ? `${head} | +${problems.length - limit} more` : head
}

export const checkA2: Assertion = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing()
  const expected = new Set(ctx.checks.map((item) => item.id))
  const actual = new Set(ctx.checklist.rows.keys())
  const missing = [...expected].filter((id) => !actual.has(id))
  const unknown = [...actual].filter((id) => !expected.has(id))
  const problems: string[] = []
  if (ctx.checklist.rows.size !== ctx.checks.length) {
    problems.push(`row count ${ctx.checklist.rows.size} != ${ctx.checks.length}`)
  }
  if (missing.length > 0) problems.push(`missing ids: ${missing.join(', ')}`)
  if (unknown.length > 0) problems.push(`unknown ids: ${unknown.join(', ')}`)
  // parseChecklist already validates status / reason / evidence prefix / duplicates.
  for (const error of ctx.checklist.errors) problems.push(error)
  const evidence =
    `rows=${ctx.checklist.rows.size} expected=${ctx.checks.length} ` +
    `missing=${missing.length} unknown=${unknown.length} duplicates=${ctx.checklist.duplicatedIds.length} ` +
    `problem_count=${problems.length}`
  return problems.length === 0
    ? { status: 'PASS', evidence }
    : { status: 'FAIL', evidence: `${evidence} :: ${firstProblems(problems)}` }
}

const EXIT_MARKER = /\bexit:\s*(-?\d+)/
const COMMAND_SPLIT = /;\s*|\s+\|\s+/

function commandPayload(evidence: string): string {
  const rest = evidence.replace(/^command:\s*/i, '')
  // `exit:N` is metadata for A3, not an argument: replaying
  // `python -m specgraph check … exit:0` made python exit 2 ("unrecognized arguments").
  const withoutExit = rest.replace(/\s*\bexit:\s*-?\d+\b.*$/i, '')
  return (withoutExit.split(COMMAND_SPLIT)[0] ?? '').trim()
}

export const checkA3: Assertion = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing()
  const problems: string[] = []
  let prefixOk = 0
  let placeholders = 0
  const runnable: Array<{ id: string; argv: string[]; expected: number }> = []
  for (const row of ctx.checklist.rows.values()) {
    const isCommand = /^command:\s*\S/i.test(row.evidence)
    const isFile = /^file:\s*\S/i.test(row.evidence)
    if (!isCommand && !isFile) {
      problems.push(`${row.id}: evidence lacks command:/file: prefix`)
      continue
    }
    prefixOk += 1
    if (isFile) {
      if (!/:\d+$/.test(row.evidence.replace(/^file:\s*/i, ''))) {
        problems.push(`${row.id}: file evidence lacks :line`)
      }
      continue
    }
    const exitMatch = EXIT_MARKER.exec(row.evidence)
    if (exitMatch === null) {
      problems.push(`${row.id}: command evidence lacks exit: marker`)
      continue
    }
    const payload = commandPayload(row.evidence)
    if (/<[^>]+>/.test(payload)) {
      placeholders += 1
      continue
    }
    const argv = splitCommand(payload)
    if (argv.length < 2 || argv.includes('-m') === false || argv.includes('specgraph') === false) continue
    if (runnable.length < 3) runnable.push({ id: row.id, argv, expected: Number(exitMatch[1]) })
  }

  const results: string[] = []
  for (const sample of runnable) {
    try {
      const output = await ctx.runArgv(sample.argv)
      results.push(`${sample.id}=${output.exitCode}`)
      if (output.exitCode !== sample.expected) {
        problems.push(`${sample.id}: replayed exit ${output.exitCode} != ${sample.expected}`)
      }
    } catch (error) {
      problems.push(`${sample.id}: replay failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const evidence =
    `rows=${ctx.checklist.rows.size} prefix_ok=${prefixOk} sampled=${runnable.length} ` +
    `placeholders_skipped=${placeholders} replay=[${results.join(',')}] problems=${problems.length}`
  return problems.length === 0
    ? { status: 'PASS', evidence }
    : { status: 'FAIL', evidence: `${evidence} :: ${firstProblems(problems)}` }
}

export const checkA4: Assertion = async (ctx) => {
  if (!ctx.checklist.provided) return checklistMissing()
  const audit = auditChecklist(ctx.checklist)
  const { notRun, onlyInReport, onlyInSection, sectionMissingButNeeded } = audit
  const problems: string[] = []
  if (sectionMissingButNeeded) problems.push('missing "未覆盖" section')
  if (onlyInReport.length > 0) problems.push(`NOT-RUN not listed: ${onlyInReport.join(', ')}`)
  if (onlyInSection.length > 0) problems.push(`listed but not NOT-RUN: ${onlyInSection.join(', ')}`)
  const evidence =
    `notRun=${notRun.size} uncovered=${ctx.checklist.uncovered.size} section=${ctx.checklist.hasUncoveredSection} ` +
    `missing_from_section=${onlyInReport.length} extra_in_section=${onlyInSection.length}`
  return problems.length === 0
    ? { status: 'PASS', evidence }
    : { status: 'FAIL', evidence: `${evidence} :: ${firstProblems(problems)}` }
}

export const checkA5: Assertion = async (ctx) => {
  let current: Record<string, string>
  try {
    current = await ctx.hashGraph()
  } catch (error) {
    return {
      status: 'FAIL',
      evidence: `hash failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const before = ctx.preGraphHashes
  const changed: string[] = []
  const added: string[] = []
  const removed: string[] = []
  for (const key of Object.keys(before)) {
    if (!(key in current)) removed.push(key)
    else if (current[key] !== before[key]) changed.push(key)
  }
  for (const key of Object.keys(current)) {
    if (!(key in before)) added.push(key)
  }
  const files = Object.keys(before).length
  const stable = files - changed.length - removed.length
  const digest = Object.values(before).join('').slice(0, 16)
  const evidence =
    `files=${files} stable=${stable} changed=${changed.length} added=${added.length} removed=${removed.length} ` +
    `digest=${digest}`
  const problems = [...changed, ...removed].map((file) => `changed: ${file}`)
  problems.push(...added.map((file) => `appeared: ${file}`))
  if (problems.length === 0 && files === 0) {
    return { status: 'FAIL', evidence: `${evidence} :: no spec.md/graph.toml found under graphRoot` }
  }
  return problems.length === 0
    ? { status: 'PASS', evidence }
    : { status: 'FAIL', evidence: `${evidence} :: ${firstProblems(problems)}` }
}
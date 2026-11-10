// impl_gate_record: run the acceptance commands written in compose-plan.json and
// store the outcome as implementation evidence. The point is not "tests pass";
// it is that the document's own acceptance rows become checkable claims with a
// command, an exit code and a log tail attached.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { validatePlan, type Plan, type PlanProblem } from '../compose/plan.js'

export const AC_EVIDENCE_REL = '.impl-gate/ac-evidence.json'
export const TASKS_EVIDENCE_REL = 'tasks/EVIDENCE.md'

/** Commands are authored by the planning model, so only well-known runners run. */
const ALLOWED_RUNNERS = new Set([
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'bun',
  'deno',
  'node',
  'python',
  'python3',
  'py',
  'git',
  'bash',
  'sh',
  'cargo',
  'go',
  'dotnet',
  'java',
  'mvn',
  'gradle',
  'make',
])

export type EvidenceStatus = 'PASS' | 'FAIL' | 'SKIPPED'

export interface EvidenceItem {
  id: string
  module: string
  command: string
  status: EvidenceStatus
  exitCode: number | null
  durationMs: number
  tail: string
  reason?: string
}

export interface RecordSummary {
  pass: number
  fail: number
  skipped: number
  total: number
}

export interface RecordPayload {
  ok: true
  evidencePath: string
  summary: RecordSummary
  items: EvidenceItem[]
  planSha256: string
}

export interface RecordFailure {
  ok: false
  error: { code: string; message: string; detail?: string }
}

export type RecordOutcome = RecordPayload | RecordFailure

export interface RecordOptions {
  modules?: string[]
  implRoot?: string
  timeoutMs?: number
  dryRun?: boolean
  maxTailLines?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_TAIL_LINES = 20
const MAX_TAIL_CHARS = 1_200

function failure(code: string, message: string, detail?: string): RecordFailure {
  const out: RecordFailure = { ok: false, error: { code, message } }
  if (detail !== undefined) out.error.detail = detail
  return out
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function tailOf(stdout: string | Buffer | null | undefined, stderr: string | Buffer | null | undefined, lines: number): string {
  const text = `${stdout?.toString() ?? ''}\n${stderr?.toString() ?? ''}`.trim()
  if (text === '') return ''
  const rows = text.split(/\r?\n/).filter((row) => row.trim() !== '')
  const tail = rows.slice(-lines).join('\n')
  return tail.length > MAX_TAIL_CHARS ? `${tail.slice(0, MAX_TAIL_CHARS)}…` : tail
}

export function runnerOf(command: string): string | null {
  const first = command.trim().split(/\s+/)[0] ?? ''
  if (first === '') return null
  // Windows paths such as C:\tools\pnpm.cmd are judged by their basename.
  return first.replace(/\\/g, '/').split('/').pop()?.replace(/\.(cmd|exe|bat)$/i, '') ?? null
}

function firstProblem(problem: PlanProblem): string {
  return problem.path === undefined ? problem.message : `${problem.path}: ${problem.message}`
}

export function recordAcceptance(outDirRaw: string, options: RecordOptions = {}): RecordOutcome {
  if (typeof outDirRaw !== 'string' || outDirRaw.trim() === '') {
    return failure('E_ROOT_MISSING', 'outDir is required')
  }
  const outDir = path.resolve(outDirRaw)
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
    return failure('E_ROOT_MISSING', `outDir does not exist: ${outDir}`)
  }
  const planFile = path.join(outDir, 'compose-plan.json')
  if (!fs.existsSync(planFile)) {
    return failure('PLAN_MISSING', `no compose-plan.json under ${outDir}; run impl_gate_compose mode:"plan" first`)
  }

  let plan: Plan
  try {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8')) as Plan
  } catch (error) {
    return failure('PLAN_INVALID', `compose-plan.json is not valid JSON: ${(error as Error).message}`)
  }

  const { problems } = validatePlan(plan)
  if (problems.length > 0) {
    return failure('PLAN_INVALID', `${problems.length} problem(s) in compose-plan.json`, firstProblem(problems[0] as PlanProblem))
  }

  const wanted = options.modules === undefined ? null : new Set(options.modules)
  if (wanted !== null) {
    for (const id of wanted) {
      if (!plan.modules.some((module) => module.id === id)) {
        return failure('PLAN_INVALID', `unknown module "${id}" in modules filter`)
      }
    }
  }

  const implRoot = path.resolve(options.implRoot ?? outDir)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTailLines = options.maxTailLines ?? DEFAULT_TAIL_LINES
  const items: EvidenceItem[] = []

  for (const module of plan.modules) {
    if (wanted !== null && !wanted.has(module.id)) continue
    for (const acceptance of module.acceptance ?? []) {
      const command = (acceptance.test ?? '').trim()
      if (command === '') {
        items.push({ id: acceptance.id, module: module.id, command: '', status: 'SKIPPED', exitCode: null, durationMs: 0, tail: '', reason: 'NO_COMMAND' })
        continue
      }
      const runner = runnerOf(command)
      if (runner === null || !ALLOWED_RUNNERS.has(runner)) {
        items.push({ id: acceptance.id, module: module.id, command, status: 'SKIPPED', exitCode: null, durationMs: 0, tail: '', reason: `RUNNER_NOT_ALLOWED (${runner ?? 'unknown'})` })
        continue
      }
      if (options.dryRun === true) {
        items.push({ id: acceptance.id, module: module.id, command, status: 'SKIPPED', exitCode: null, durationMs: 0, tail: '', reason: 'DRY_RUN' })
        continue
      }

      const startedAt = Date.now()
      const result = spawnSync(command, {
        cwd: implRoot,
        shell: true,
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      const durationMs = Date.now() - startedAt
      const exitCode = typeof result.status === 'number' ? result.status : null
      const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      const tail = tailOf(result.stdout, result.stderr, maxTailLines)
      if (timedOut) {
        items.push({ id: acceptance.id, module: module.id, command, status: 'FAIL', exitCode, durationMs, tail, reason: `TIMEOUT after ${timeoutMs}ms` })
        continue
      }
      items.push({
        id: acceptance.id,
        module: module.id,
        command,
        status: exitCode === 0 ? 'PASS' : 'FAIL',
        exitCode,
        durationMs,
        tail,
        ...(exitCode === 0 ? {} : { reason: `exit:${exitCode ?? 'null'}` }),
      })
    }
  }

  const summary: RecordSummary = {
    pass: items.filter((item) => item.status === 'PASS').length,
    fail: items.filter((item) => item.status === 'FAIL').length,
    skipped: items.filter((item) => item.status === 'SKIPPED').length,
    total: items.length,
  }

  const evidencePath = path.join(outDir, AC_EVIDENCE_REL)
  const planSha256 = hashFile(planFile)
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true })
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), planSha256, summary, items }, null, 2)}\n`,
      'utf8',
    )
    const tasksDir = path.join(outDir, 'tasks')
    if (fs.existsSync(tasksDir)) {
      fs.writeFileSync(path.join(outDir, TASKS_EVIDENCE_REL), renderEvidenceDoc({ planSha256, summary, items, plan, dryRun: options.dryRun === true }), 'utf8')
    }
  } catch (error) {
    return failure('RECORD_WRITE_FAILED', `cannot write ${evidencePath}: ${(error as Error).message}`)
  }

  return { ok: true, evidencePath: path.relative(outDir, evidencePath).split(path.sep).join('/'), summary, items, planSha256 }
}

export function renderEvidenceDoc(input: {
  planSha256: string
  summary: RecordSummary
  items: EvidenceItem[]
  plan: Plan
  dryRun: boolean
}): string {
  const title = input.plan.title ?? input.plan.name
  const lines: string[] = []
  lines.push(`# 验收证据：${title}`)
  lines.push('')
  lines.push('> 由 `impl_gate_record` 生成：每条 AC 的命令被执行一次，下面是退出码与日志尾部。')
  lines.push('> 这是「实现证据」，不是「文档自洽」——文档层面请用 `impl_gate_review`。')
  lines.push('')
  lines.push(`- plan sha256: \`${input.planSha256.slice(0, 16)}\``)
  lines.push(`- 结果：PASS ${input.summary.pass} / FAIL ${input.summary.fail} / SKIPPED ${input.summary.skipped}（共 ${input.summary.total} 条）`)
  if (input.dryRun) lines.push('- 本次是 dryRun，没有真正执行任何命令。')
  lines.push('')
  lines.push('| AC | 模块 | 状态 | 退出码 | 耗时 | 命令 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const item of input.items) {
    const cells = [item.id, item.module, item.status, item.exitCode === null ? '—' : String(item.exitCode), `${item.durationMs}ms`, item.command === '' ? '（未声明命令）' : `\`${item.command}\``]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  const failed = input.items.filter((item) => item.status === 'FAIL')
  if (failed.length > 0) {
    lines.push('')
    lines.push('## 失败与跳过明细')
    for (const item of failed) {
      lines.push('')
      lines.push(`### ${item.id}（${item.module}）— ${item.reason ?? 'FAIL'}`)
      lines.push('')
      lines.push('```')
      lines.push(item.tail === '' ? '（没有输出）' : item.tail)
      lines.push('```')
    }
  }
  const skipped = input.items.filter((item) => item.status === 'SKIPPED')
  if (skipped.length > 0) {
    lines.push('')
    lines.push('## 未执行')
    for (const item of skipped) lines.push(`- ${item.id}（${item.module}）：${item.reason ?? 'SKIPPED'}`)
  }
  lines.push('')
  return lines.join('\n')
}
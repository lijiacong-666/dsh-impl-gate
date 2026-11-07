// The three DSH tools exposed by dsh-impl-gate v1.
// Only impl_gate_check is real in Step 2; report and verify are registered so
// the tool surface is stable, and return E_NOT_IMPLEMENTED until Step 4.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ASSERTIONS } from './assertions/index.js'
import type { AssertionContext } from './assertions/types.js'
import { loadChecks, type CheckItem } from './checks.js'
import { loadChecklist } from './checklist.js'
import { hashContractFiles } from './graph-hash.js'
import {
  SpecgraphError,
  findSpecgraphHome,
  resolveArgv,
  runProcess,
  runSpecgraph,
  type RunOutput,
} from './specgraph.js'

export interface PluginConfig {
  specgraphCommand: string
  pythonPath: string
  specgraphCwd: string
  timeoutMs: number
  implRoot: string
  slow: boolean
}

export interface ToolFailure {
  error: { code: string; message: string; detail?: string }
}

export interface CheckPayload {
  passed: string[]
  failed: string[]
  notRun: string[]
  evidence: Array<{ id: string; text: string }>
  graphIssues: Array<{ code: string; node: string; item: string; line: number }>
  graphExitCode: number
  runId: string
  startedAt: string
  durationMs: number
}

const MAX_EVIDENCE = 2048
const RUN_TTL_MS = 10 * 60 * 1000

interface RunRecord {
  payload: CheckPayload
  reasons: Record<string, string>
  finishedAt: number
}

const runs = new Map<string, RunRecord>()

export function rememberRun(runId: string, payload: CheckPayload, reasons: Record<string, string>): void {
  runs.set(runId, { payload, reasons, finishedAt: Date.now() })
  for (const [key, record] of runs) {
    if (Date.now() - record.finishedAt > RUN_TTL_MS) runs.delete(key)
  }
}

export function getRun(runId: string): RunRecord | null {
  const record = runs.get(runId)
  if (record === undefined) return null
  if (Date.now() - record.finishedAt > RUN_TTL_MS) {
    runs.delete(runId)
    return null
  }
  return record
}

function fail(code: string, message: string, detail?: string): ToolFailure {
  return detail === undefined ? { error: { code, message } } : { error: { code, message, detail } }
}

function failureFrom(error: unknown): ToolFailure {
  if (error instanceof SpecgraphError) return fail(error.code, error.message, error.detail)
  const message = error instanceof Error ? error.message : String(error)
  return fail('E_INTERNAL_INCONSISTENT', message)
}

function truncate(text: string): string {
  return text.length <= MAX_EVIDENCE ? text : `${text.slice(0, MAX_EVIDENCE)}…`
}

export interface ToolDeps {
  config: PluginConfig
}

function notRunReason(item: CheckItem, slow: boolean, implemented: boolean): string {
  if (item.mode === 'notrun') return item.notRunReason
  if (item.mode === 'manual') return 'MANUAL_REVIEW_REQUIRED'
  if (item.runtime === 'slow' && !slow) return 'SLOW_CHECK_DISABLED'
  if (!implemented) return 'NOT_IMPLEMENTED'
  return item.notRunReason
}

export async function runCheck(rawArgs: unknown, deps: ToolDeps): Promise<CheckPayload | ToolFailure> {
  const startedAt = new Date()
  const startedMs = Date.now()
  const args = (rawArgs ?? {}) as {
    graphRoot?: unknown
    implRoot?: unknown
    slow?: unknown
    checklistPath?: unknown
  }
  const graphRootRaw = typeof args.graphRoot === 'string' ? args.graphRoot : ''
  if (graphRootRaw.length === 0) return fail('E_ROOT_MISSING', 'graphRoot is required')
  const graphRoot = path.resolve(graphRootRaw)
  try {
    const stat = await fs.promises.stat(graphRoot)
    if (!stat.isDirectory()) return fail('E_ROOT_MISSING', `graphRoot is not a directory: ${graphRoot}`)
  } catch {
    return fail('E_ROOT_MISSING', `graphRoot does not exist: ${graphRoot}`)
  }

  const config = deps.config
  const implRootArg = typeof args.implRoot === 'string' && args.implRoot.length > 0 ? args.implRoot : ''
  const implRoot = path.resolve(implRootArg.length > 0 ? implRootArg : config.implRoot.length > 0 ? config.implRoot : graphRoot)
  const slow = args.slow === true || config.slow

  let checks: CheckItem[]
  try {
    checks = loadChecks()
  } catch (error) {
    return fail('E_INTERNAL_INCONSISTENT', (error as Error).message)
  }

  const runnerCwd = config.specgraphCwd.length > 0 ? config.specgraphCwd : undefined
  const sourceHome = runnerCwd === undefined ? findSpecgraphHome(graphRoot) : undefined
  const runnerEnv =
    sourceHome === undefined
      ? undefined
      : {
          ...process.env,
          PYTHONPATH: [sourceHome, process.env.PYTHONPATH].filter((part) => part !== undefined && part.length > 0).join(path.delimiter),
        }
  const runner = {
    argv: resolveArgv(config.specgraphCommand, config.pythonPath),
    cwd: runnerCwd,
    env: runnerEnv,
    timeoutMs: config.timeoutMs,
  }

  let graphRun: RunOutput
  try {
    graphRun = await runSpecgraph(runner, ['check', graphRoot, '--json'])
  } catch (error) {
    return failureFrom(error)
  }

  let parsed: { ok?: unknown; issues?: unknown }
  try {
    parsed = JSON.parse(graphRun.stdout) as { ok?: unknown; issues?: unknown }
  } catch {
    return fail(
      'E_BAD_JSON',
      'specgraph check did not print JSON',
      (graphRun.stderr || graphRun.stdout).trim().slice(-4000),
    )
  }

  const graphIssues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .filter((issue): issue is Record<string, unknown> => typeof issue === 'object' && issue !== null)
    .map((issue) => ({
      code: String(issue.code ?? ''),
      node: String(issue.node ?? ''),
      item: String(issue.item ?? ''),
      line: Number(issue.line ?? 0),
    }))

  const runId = `run-${startedMs.toString(36)}-${randomUUID().slice(0, 8)}`
  const base = {
    graphIssues,
    graphExitCode: graphRun.exitCode,
    runId,
    startedAt: startedAt.toISOString(),
  }

  if (graphRun.exitCode !== 0 || parsed.ok !== true) {
    const payload: CheckPayload = {
      ...base,
      passed: [],
      failed: [],
      notRun: checks.map((item) => item.id),
      evidence: [],
      durationMs: Date.now() - startedMs,
    }
    const reasons: Record<string, string> = {}
    for (const item of checks) reasons[item.id] = 'D4_GRAPH_INVALID'
    rememberRun(runId, payload, reasons)
    return payload
  }

  const checklistArg =
    typeof args.checklistPath === 'string' && args.checklistPath.length > 0 ? args.checklistPath : ''
  const checklistPath = path.resolve(
    checklistArg.length > 0 ? checklistArg : path.join(implRoot, '.impl-gate', 'checklist.md'),
  )
  const checklist = loadChecklist(checklistPath)
  const preGraphHashes = await hashContractFiles(graphRoot)

  const runArgv = (argv: string[]): Promise<RunOutput> => {
    const mapped = [...argv]
    const head = mapped[0]
    if (
      head !== undefined &&
      config.pythonPath.length > 0 &&
      /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path.basename(head))
    ) {
      mapped[0] = config.pythonPath
    }
    return runProcess(mapped, { cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs })
  }

  const ctx: AssertionContext = {
    graphRoot,
    implRoot,
    slow,
    timeoutMs: config.timeoutMs,
    checks,
    checklist,
    preGraphHashes,
    specgraphHome: sourceHome ?? '',
    run: (specArgs: string[]) =>
      runSpecgraph({ argv: runner.argv, cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs }, specArgs),
    runArgv,
    hashGraph: () => hashContractFiles(graphRoot),
    newTempDir: (prefix: string) => fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)),
  }

  const passed: string[] = []
  const failed: string[] = []
  const notRun: string[] = []
  const evidence: Array<{ id: string; text: string }> = []
  const reasons: Record<string, string> = {}

  for (const item of checks) {
    const assertion = ASSERTIONS[item.id]
    const gated = item.mode !== 'auto' || (item.runtime === 'slow' && !slow) || assertion === undefined
    if (gated) {
      notRun.push(item.id)
      reasons[item.id] = notRunReason(item, slow, assertion !== undefined)
      continue
    }
    try {
      const outcome = await assertion(ctx)
      if (outcome.status === 'PASS') {
        passed.push(item.id)
        evidence.push({ id: item.id, text: truncate(outcome.evidence) })
      } else if (outcome.status === 'FAIL') {
        failed.push(item.id)
        evidence.push({ id: item.id, text: truncate(outcome.evidence) })
      } else {
        notRun.push(item.id)
        reasons[item.id] = outcome.reason ?? item.notRunReason
      }
    } catch (error) {
      failed.push(item.id)
      evidence.push({ id: item.id, text: truncate(`error: ${error instanceof Error ? error.message : String(error)}`) })
    }
  }

  const partition = new Set([...passed, ...failed, ...notRun])
  if (partition.size !== checks.length || passed.length + failed.length + notRun.length !== checks.length) {
    return fail('E_INTERNAL_INCONSISTENT', `assertion partition is not a clean split of ${checks.length} ids`)
  }

  const payload: CheckPayload = {
    ...base,
    passed,
    failed,
    notRun,
    evidence,
    durationMs: Date.now() - startedMs,
  }
  rememberRun(runId, payload, reasons)
  return payload
}

function renderCheck(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<CheckPayload & ToolFailure>
  if (payload.error !== undefined) {
    return [{ type: 'text', text: `impl_gate_check failed: ${payload.error.code} — ${payload.error.message}` }]
  }
  const passed = payload.passed ?? []
  const failed = payload.failed ?? []
  const notRun = payload.notRun ?? []
  const lines = [`impl_gate_check ${payload.runId ?? ''}: PASS ${passed.length} / FAIL ${failed.length} / NOT-RUN ${notRun.length} (32)`]
  if (failed.length > 0) lines.push(`FAIL: ${failed.join(', ')}`)
  if (notRun.length > 0) lines.push(`NOT-RUN: ${notRun.join(', ')}`)
  if (payload.graphExitCode !== undefined && payload.graphExitCode !== 0) {
    lines.push(`graphExitCode=${payload.graphExitCode}, ${(payload.graphIssues ?? []).length} issue(s)`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

const errorSchema = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    detail: { type: 'string' },
  },
  required: ['code', 'message'],
  additionalProperties: false,
}

const checkOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    passed: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'string' } },
    notRun: { type: 'array', items: { type: 'string' } },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
    graphIssues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          node: { type: 'string' },
          item: { type: 'string' },
          line: { type: 'number' },
        },
        required: ['code', 'node', 'item'],
        additionalProperties: false,
      },
    },
    graphExitCode: { type: 'number' },
    runId: { type: 'string' },
    startedAt: { type: 'string' },
    durationMs: { type: 'number' },
    error: errorSchema,
  },
}

const checkParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    graphRoot: {
      type: 'string',
      description: '规格图谱根目录（含 graph.toml 与各节点 spec.md）。必填。',
    },
    implRoot: {
      type: 'string',
      description: '实现根目录，默认等于 graphRoot。只影响 B 组与 Q5–Q8。',
    },
    slow: {
      type: 'boolean',
      description: '运行 slow 断言（Q1 依赖审计）。默认关闭。',
    },
    checklistPath: {
      type: 'string',
      description: '交付的勾选表路径，缺省 <implRoot>/.impl-gate/checklist.md。',
    },
  },
  required: ['graphRoot'],
}

const stubOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { error: errorSchema },
}

export function buildTools(deps: ToolDeps) {
  const check = {
    name: 'impl_gate_check',
    description:
      'Run the 32 IMPL-GATE assertions against a spec-graph root. ' +
      'Calls `python -m specgraph check --json` first; an invalid graph makes every assertion NOT-RUN with D4_GRAPH_INVALID. ' +
      'Does not do GUI checks, does not render a canvas, and never writes into the inspected project.',
    parameters: checkParameters,
    output: { schema: checkOutputSchema, render: renderCheck },
    async execute(args: unknown) {
      try {
        return await runCheck(args, deps)
      } catch (error) {
        return failureFrom(error)
      }
    },
  }

  const stub = (name: string, description: string) => ({
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: '规格图谱根目录。' },
        runId: { type: 'string', description: 'impl_gate_check 返回的 runId；缺省表示最近一次运行。' },
      },
      required: ['root'],
    },
    output: {
      schema: stubOutputSchema,
      render: (_args: unknown, value: unknown) => {
        const v = value as ToolFailure
        return [{ type: 'text' as const, text: `${name} is not implemented yet: ${v.error?.code ?? 'E_NOT_IMPLEMENTED'}` }]
      },
    },
    async execute(_args: unknown) {
      return fail('E_NOT_IMPLEMENTED', `${name} ships in Step 4; use impl_gate_check for now`)
    },
  })

  return [
    check,
    stub('impl_gate_report', 'Summarise a previous impl_gate_check run as PASS/FAIL/NOT-RUN per assertion. Does not re-run checks.'),
    stub('impl_gate_verify_contract', 'Check that A1–A5 passed in one previous impl_gate_check run. Does not re-run checks.'),
  ]
}
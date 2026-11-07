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
import { renderDraft } from './compose/draft.js'
import { materializePlan } from './compose/materialize.js'
import { emptyPlan, missingSlots, type PlanProblem } from './compose/plan.js'
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
  allowCommandReplay: boolean
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

interface RunRecord {
  payload: CheckPayload
  reasons: Record<string, string>
  graphRoot: string
  finishedAt: number
}

const runs = new Map<string, RunRecord>()

/** Windows paths are case-insensitive; key the cache on a canonical form. */
export function normalizeRoot(root: string): string {
  const resolved = path.resolve(root)
  const unquoted = resolved.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? unquoted.toLowerCase() : unquoted
}

export function rememberRun(
  runId: string,
  payload: CheckPayload,
  reasons: Record<string, string>,
  graphRoot: string,
): void {
  runs.set(runId, { payload, reasons, graphRoot: normalizeRoot(graphRoot), finishedAt: Date.now() })
  for (const [key, record] of runs) {
    if (Date.now() - record.finishedAt > RUN_TTL_MS) runs.delete(key)
  }
}

type LookupResult =
  | { kind: 'ok'; record: RunRecord }
  | { kind: 'missing' }
  | { kind: 'expired' }

function lookupRun(runId: string): LookupResult {
  const record = runs.get(runId)
  if (record === undefined) return { kind: 'missing' }
  if (Date.now() - record.finishedAt > RUN_TTL_MS) {
    runs.delete(runId)
    return { kind: 'expired' }
  }
  return { kind: 'ok', record }
}

/** Latest live record for one root; never returns a record from another root. */
function latestRunFor(root: string): LookupResult {
  const wanted = normalizeRoot(root)
  let best: RunRecord | undefined
  let bestId = ''
  for (const [runId, record] of runs) {
    if (record.graphRoot !== wanted) continue
    if (Date.now() - record.finishedAt > RUN_TTL_MS) {
      runs.delete(runId)
      continue
    }
    if (best === undefined || record.finishedAt > best.finishedAt) {
      best = record
      bestId = runId
    }
  }
  if (best === undefined) return { kind: 'missing' }
  return { kind: 'ok', record: { ...best, payload: { ...best.payload, runId: best.payload.runId || bestId } } }
}

export function getRun(runId: string): RunRecord | null {
  const result = lookupRun(runId)
  return result.kind === 'ok' ? result.record : null
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
    rememberRun(runId, payload, reasons, graphRoot)
    return payload
  }

  const checklistArg =
    typeof args.checklistPath === 'string' && args.checklistPath.length > 0 ? args.checklistPath : ''
  const checklistPath = path.resolve(
    checklistArg.length > 0 ? checklistArg : path.join(implRoot, '.impl-gate', 'checklist.md'),
  )
  const checklist = loadChecklist(checklistPath)
  const preGraphHashes = await hashContractFiles(graphRoot)

  const mapPython = (argv: string[]): string[] => {
    const mapped = [...argv]
    const head = mapped[0]
    if (
      head !== undefined &&
      config.pythonPath.length > 0 &&
      /^python(\d+(?:\.\d+)*)?(\.exe)?$/i.test(path.basename(head))
    ) {
      mapped[0] = config.pythonPath
    }
    return mapped
  }

  const runArgvMapped = (argv: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunOutput> =>
    runProcess(mapPython(argv), { cwd: opts.cwd, env: runner.env, timeoutMs: opts.timeoutMs })

  const runArgv = (argv: string[]): Promise<RunOutput> =>
    runArgvMapped(argv, { cwd: runner.cwd, timeoutMs: config.timeoutMs })

  const runImpl = (argv: string[]): Promise<RunOutput> =>
    runArgvMapped(argv, { cwd: implRoot, timeoutMs: 120_000 })

  const ctx: AssertionContext = {
    graphRoot,
    implRoot,
    slow,
    timeoutMs: config.timeoutMs,
    checks,
    checklist,
    preGraphHashes,
    specgraphHome: sourceHome ?? '',
    allowCommandReplay: config.allowCommandReplay,
    replayBudget: { remaining: 5 },
    run: (specArgs: string[]) =>
      runSpecgraph({ argv: runner.argv, cwd: runner.cwd, env: runner.env, timeoutMs: config.timeoutMs }, specArgs),
    runArgv,
    runImpl,
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
  rememberRun(runId, payload, reasons, graphRoot)
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

export interface ReportPayload {
  summary: string
  checklist: Array<{ id: string; status: string; evidence: string; reason?: string }>
  uncovered: string[]
}

export interface VerifyPayload {
  ok: boolean
  details: string[]
}

function selectRun(rawRoot: unknown, rawRunId: unknown): { record: RunRecord } | ToolFailure {
  const rootArg = typeof rawRoot === 'string' ? rawRoot.trim() : ''
  if (rootArg.length === 0) return fail('E_ROOT_MISSING', 'root is required')
  const root = path.resolve(rootArg)
  const runId = typeof rawRunId === 'string' && rawRunId.length > 0 ? rawRunId : ''
  if (runId.length > 0) {
    const found = lookupRun(runId)
    if (found.kind === 'missing') {
      return fail('E_NO_PRIOR_RUN', `no cached run for runId ${runId}`, 'Run impl_gate_check first; the cache is in-memory and is lost on plugin reload.')
    }
    if (found.kind === 'expired') {
      return fail('E_RUN_EXPIRED', `run ${runId} is older than the 10 minute TTL`, 'Run impl_gate_check again.')
    }
    if (found.record.graphRoot !== normalizeRoot(root)) {
      return fail(
        'E_NO_PRIOR_RUN',
        `run ${runId} was produced for a different root`,
        `cached root: ${found.record.graphRoot}; requested root: ${normalizeRoot(root)}`,
      )
    }
    return { record: found.record }
  }
  const latest = latestRunFor(root)
  if (latest.kind === 'missing') {
    return fail('E_NO_PRIOR_RUN', `no cached run for root ${root}`, 'Run impl_gate_check first; the cache is in-memory and is lost on plugin reload.')
  }
  if (latest.kind === 'expired') return fail('E_RUN_EXPIRED', 'the cached run is older than the 10 minute TTL')
  return { record: latest.record }
}

const A_IDS = ['A1', 'A2', 'A3', 'A4', 'A5'] as const

function evidenceFor(payload: CheckPayload, id: string): string {
  return payload.evidence.find((entry) => entry.id === id)?.text ?? ''
}

export function buildReport(rawArgs: unknown): ReportPayload | ToolFailure {
  const args = (rawArgs ?? {}) as { root?: unknown; runId?: unknown }
  const selected = selectRun(args.root, args.runId)
  if ('error' in selected) return selected
  const { payload, reasons } = selected.record

  let order: string[]
  try {
    order = loadChecks().map((item) => item.id)
  } catch {
    order = [...payload.passed, ...payload.failed, ...payload.notRun]
  }
  const passed = new Set(payload.passed)
  const failed = new Set(payload.failed)
  const notRun = new Set(payload.notRun)

  const checklist = order.map((id) => {
    const status = passed.has(id) ? 'PASS' : failed.has(id) ? 'FAIL' : 'NOT-RUN'
    const reason = status === 'NOT-RUN' ? reasons[id] ?? 'NOT_IMPLEMENTED' : undefined
    const row: { id: string; status: string; evidence: string; reason?: string } = {
      id,
      status,
      evidence: evidenceFor(payload, id),
    }
    if (reason !== undefined) row.reason = reason
    return row
  })

  const uncovered = [...notRun]
  const uncoveredMatches =
    uncovered.length === notRun.size && uncovered.every((id) => notRun.has(id)) && checklist.length === 32
  if (!uncoveredMatches) {
    return fail(
      'E_INTERNAL_INCONSISTENT',
      '未覆盖集合与 NOT-RUN 集合不相等',
      `uncovered=${uncovered.length}; notRun=${notRun.size}; rows=${checklist.length}`,
    )
  }
  return {
    summary: `PASS ${payload.passed.length} / FAIL ${payload.failed.length} / NOT-RUN ${payload.notRun.length} (32)`,
    checklist,
    uncovered,
  }
}

/** The one line Step 4 requires: 未覆盖集合 ≡ NOT-RUN 集合（相等/不等）. */
export function coverageStatement(rows: Array<{ id: string; status: string }>, uncovered: string[]): string {
  const notRun = rows.filter((row) => row.status === 'NOT-RUN').map((row) => row.id)
  const enough = rows.length === 32
  const equal =
    enough &&
    notRun.length === uncovered.length &&
    notRun.every((id) => uncovered.includes(id)) &&
    uncovered.every((id) => notRun.includes(id))
  return `未覆盖集合 ≡ NOT-RUN 集合（${equal ? '相等' : '不等'}）`
}

export function buildVerifyContract(rawArgs: unknown): VerifyPayload | ToolFailure {
  const args = (rawArgs ?? {}) as { root?: unknown; runId?: unknown }
  const selected = selectRun(args.root, args.runId)
  if ('error' in selected) return selected
  const { payload, reasons } = selected.record

  const membership = new Map<string, number>()
  for (const id of [...payload.passed, ...payload.failed, ...payload.notRun]) {
    membership.set(id, (membership.get(id) ?? 0) + 1)
  }
  for (const id of A_IDS) {
    if (membership.get(id) !== 1) {
      return fail('E_INTERNAL_INCONSISTENT', `${id} does not appear exactly once in the cached run`)
    }
  }

  const details = A_IDS.map((id) => {
    const status = payload.passed.includes(id) ? 'PASS' : payload.failed.includes(id) ? 'FAIL' : 'NOT-RUN'
    const evidence = evidenceFor(payload, id)
    const reason = status === 'NOT-RUN' ? ` reason=${reasons[id] ?? 'NOT_IMPLEMENTED'}` : ''
    return `${id} ${status}${reason} — ${evidence || '(no evidence)'}`
  })
  const ok = A_IDS.every((id) => payload.passed.includes(id))
  return { ok, details }
}

function renderReport(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<ReportPayload & ToolFailure>
  if (payload.error !== undefined) {
    return [{ type: 'text', text: `impl_gate_report failed: ${payload.error.code} — ${payload.error.message}` }]
  }
  const lines = [
    payload.summary ?? '',
    coverageStatement(payload.checklist ?? [], payload.uncovered ?? []),
  ]
  const failed = (payload.checklist ?? []).filter((row) => row.status === 'FAIL').map((row) => row.id)
  if (failed.length > 0) lines.push(`FAIL: ${failed.join(', ')}`)
  return [{ type: 'text', text: lines.filter((line) => line.length > 0).join('\n') }]
}

export interface ComposePayload {
  ok: boolean
  mode: string
  planPath: string
  draftPath: string
  missingSlots: string[]
  problems: PlanProblem[]
  graphRoot?: string
  specMd?: string
  packageMd?: string
  manifestPath?: string
  files?: string[]
  waves?: Array<{ index: number; modules: string[]; dependsOn: string[] }>
  overlaps?: Array<{ a: string; b: string; files: string[] }>
}

export interface ComposeFailure extends ToolFailure {
  problems?: PlanProblem[]
  issues?: unknown[]
  graphExitCode?: number
}

/**
 * `mode: "plan"` only writes compose-plan.json and SPEC-DRAFT.md.
 * `mode: "materialize"` writes the spec-graph root, nine-section SPEC.md and
 * the export/ package, then validates the graph with `python -m specgraph check`.
 */
export async function buildCompose(rawArgs: unknown, config: PluginConfig): Promise<ComposePayload | ComposeFailure> {
  const args = (rawArgs ?? {}) as {
    outDir?: unknown
    requirement?: unknown
    name?: unknown
    stack?: unknown
    mode?: unknown
    overwrite?: unknown
  }
  const outDirRaw = typeof args.outDir === 'string' ? args.outDir.trim() : ''
  if (outDirRaw.length === 0) return fail('E_OUT_DIR_REQUIRED', 'outDir is required')

  const mode = args.mode === 'materialize' ? 'materialize' : 'plan'
  if (mode === 'materialize') {
    const outcome = await materializePlan(outDirRaw, config)
    if (outcome.ok) {
      return {
        ok: true,
        mode: 'materialize',
        planPath: path.join(path.resolve(outDirRaw), 'compose-plan.json'),
        draftPath: '',
        missingSlots: [],
        problems: [],
        graphRoot: outcome.graphRoot,
        specMd: outcome.specMd,
        packageMd: outcome.packageMd,
        manifestPath: outcome.manifestPath,
        files: outcome.files,
        waves: outcome.waves,
        overlaps: outcome.overlaps,
      }
    }
    const failure: ComposeFailure = {
      error: {
        code: outcome.code,
        message: outcome.message,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      },
    }
    if (outcome.problems !== undefined) failure.problems = outcome.problems
    if (outcome.issues !== undefined) failure.issues = outcome.issues
    if (outcome.graphExitCode !== undefined) failure.graphExitCode = outcome.graphExitCode
    return failure
  }

  const outDir = path.resolve(outDirRaw)
  try {
    const stat = await fs.promises.stat(outDir)
    if (!stat.isDirectory()) {
      return fail('E_OUT_DIR_NOT_EMPTY', `outDir exists and is not a directory: ${outDir}`)
    }
    const entries = await fs.promises.readdir(outDir)
    if (entries.length > 0 && args.overwrite !== true) {
      return fail(
        'E_OUT_DIR_NOT_EMPTY',
        `outDir is not empty: ${outDir}`,
        `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}; pass overwrite:true to replace compose-plan.json and SPEC-DRAFT.md`,
      )
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return failureFrom(error)
  }

  await fs.promises.mkdir(outDir, { recursive: true })
  const planPath = path.join(outDir, 'compose-plan.json')
  const draftPath = path.join(outDir, 'SPEC-DRAFT.md')

  const template = emptyPlan({
    name: typeof args.name === 'string' ? args.name : undefined,
    stack: typeof args.stack === 'string' ? args.stack : undefined,
  })
  const requirement = typeof args.requirement === 'string' ? args.requirement : undefined
  await fs.promises.writeFile(planPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  await fs.promises.writeFile(draftPath, renderDraft({ plan: template, requirement }), 'utf8')

  return {
    ok: true,
    mode: 'plan',
    planPath,
    draftPath,
    missingSlots: missingSlots(template),
    problems: [],
  }
}

function renderCompose(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<ComposePayload & ComposeFailure>
  if (payload.error !== undefined) {
    const lines = [`impl_gate_compose failed: ${payload.error.code} — ${payload.error.message}`]
    if (payload.problems !== undefined && payload.problems.length > 0) {
      lines.push(`problems (${payload.problems.length}):`)
      for (const entry of payload.problems) lines.push(`- ${entry.path || '/'}: ${entry.message}`)
    }
    if (payload.issues !== undefined && payload.issues.length > 0) {
      lines.push(`graph issues (${payload.issues.length}, unchanged from specgraph):`)
      for (const issue of payload.issues) lines.push(`- ${JSON.stringify(issue)}`)
    }
    if (payload.error.detail !== undefined) lines.push(payload.error.detail)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  if (payload.mode === 'materialize') {
    const waves = (payload.waves ?? []).map((wave) => `wave ${wave.index}: ${wave.modules.join(', ')}`).join(' | ')
    const overlaps = payload.overlaps ?? []
    const lines = [
      `impl_gate_compose materialize: ${payload.graphRoot ?? ''}`,
      `spec: ${payload.specMd ?? ''}`,
      `package: ${payload.packageMd ?? ''}`,
      `manifest: ${payload.manifestPath ?? ''}`,
      `files (${payload.files?.length ?? 0}): ${(payload.files ?? []).join(', ')}`,
      waves.length > 0 ? waves : 'waves: none',
    ]
    if (overlaps.length > 0) {
      lines.push(`overlaps (${overlaps.length}): ${overlaps.map((entry) => `${entry.a}/${entry.b}: ${entry.files.join(', ')}`).join(' | ')}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const slots = payload.missingSlots ?? []
  const lines = [`impl_gate_compose ${payload.mode ?? ''}: ${payload.planPath ?? ''}`, `draft: ${payload.draftPath ?? ''}`]
  lines.push(slots.length === 0 ? 'missingSlots: none' : `missingSlots (${slots.length}): ${slots.join(' | ')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderVerify(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<VerifyPayload & ToolFailure>
  if (payload.error !== undefined) {
    return [{ type: 'text', text: `impl_gate_verify_contract failed: ${payload.error.code} — ${payload.error.message}` }]
  }
  const lines = [`ok=${payload.ok === true}`]
  for (const detail of payload.details ?? []) lines.push(detail)
  return [{ type: 'text', text: lines.join('\n') }]
}

const reportOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
          evidence: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'status', 'evidence'],
        additionalProperties: false,
      },
    },
    uncovered: { type: 'array', items: { type: 'string' } },
    error: errorSchema,
  },
}

const verifyOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    details: { type: 'array', items: { type: 'string' } },
    error: errorSchema,
  },
}

const runSelectorParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    root: { type: 'string', description: '检查根（graphRoot）的绝对路径。必填。' },
    runId: { type: 'string', description: '前次 impl_gate_check 的 runId；缺省取该根最近一次运行。' },
  },
  required: ['root'],
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

const composeParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outDir: { type: 'string', description: '输出目录（绝对路径）。plan 模式只会写入 compose-plan.json 与 SPEC-DRAFT.md。' },
    requirement: { type: 'string', description: '需求原文，写进 SPEC-DRAFT.md 文首，供模型补槽时对照。' },
    name: { type: 'string', description: '输出目录名/项目名，需匹配 ^[a-z][a-z0-9-]{1,40}$；缺省 my-app。' },
    stack: { type: 'string', description: '技术栈描述，例如 "node22+fastify+react+pg"。' },
    mode: {
      type: 'string',
      enum: ['plan', 'materialize'],
      description: 'plan=写空槽模板与草稿；materialize=物化图谱与九节 SPEC.md（0.2.0-G2 起可用）。',
    },
    overwrite: { type: 'boolean', description: 'outDir 非空时是否覆盖 compose-plan.json 与 SPEC-DRAFT.md，默认 false。' },
  },
  required: ['outDir', 'mode'],
}

const composeOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    mode: { type: 'string' },
    planPath: { type: 'string' },
    draftPath: { type: 'string' },
    missingSlots: { type: 'array', items: { type: 'string' } },
    problems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          path: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['code', 'path', 'message'],
        additionalProperties: false,
      },
    },
    graphRoot: { type: 'string' },
    specMd: { type: 'string' },
    packageMd: { type: 'string' },
    manifestPath: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    waves: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          modules: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['index', 'modules', 'dependsOn'],
        additionalProperties: false,
      },
    },
    overlaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['a', 'b', 'files'],
        additionalProperties: false,
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          level: { type: 'string' },
          code: { type: 'string' },
          node: { type: 'string' },
          section: { type: 'string' },
          item: { type: 'string' },
          message: { type: 'string' },
          fix: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
        },
        additionalProperties: false,
      },
    },
    graphExitCode: { type: 'number' },
    error: errorSchema,
  },
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

  const report = {
    name: 'impl_gate_report',
    description:
      'Summarise a previous impl_gate_check run as PASS/FAIL/NOT-RUN per assertion, reusing that run\'s cached results. ' +
      'Does not re-run checks, does not do GUI checks and does not render a canvas.',
    parameters: runSelectorParameters,
    output: { schema: reportOutputSchema, render: renderReport },
    async execute(args: unknown) {
      try {
        return buildReport(args)
      } catch (error) {
        return failureFrom(error)
      }
    },
  }

  const verify = {
    name: 'impl_gate_verify_contract',
    description:
      'Check that A1–A5 passed in one previous impl_gate_check run, reusing that run\'s cached results. ' +
      'Does not re-run checks, does not do GUI checks and does not render a canvas.',
    parameters: runSelectorParameters,
    output: { schema: verifyOutputSchema, render: renderVerify },
    async execute(args: unknown) {
      try {
        return buildVerifyContract(args)
      } catch (error) {
        return failureFrom(error)
      }
    },
  }

  const compose = {
    name: 'impl_gate_compose',
    description:
      'Turn a requirement into a施工文档 chain. mode "plan" writes compose-plan.json (the only place content lives) and ' +
      'SPEC-DRAFT.md with explicit TODO slots. mode "materialize" writes <outDir>/<name>/graph.toml + per-module spec.md, ' +
      'a nine-section SPEC.md beside <name>/, and export/export.md + export/manifest.json, then validates the graph with ' +
      '`python -m specgraph check`; an invalid ' +
      'graph returns GRAPH_INVALID with specgraph issues unchanged. It never invents content and never does GUI/canvas work.',
    parameters: composeParameters,
    output: { schema: composeOutputSchema, render: renderCompose },
    async execute(args: unknown) {
      try {
        return await buildCompose(args, deps.config)
      } catch (error) {
        return failureFrom(error)
      }
    },
  }

  return [check, report, verify, compose]
}

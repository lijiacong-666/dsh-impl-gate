// The three DSH tools exposed by dsh-impl-gate v1.
// Only impl_gate_check is real in Step 2; report and verify are registered so
// the tool surface is stable, and return E_NOT_IMPLEMENTED until Step 4.
import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSERTIONS } from './assertions/index.js'
import type { AssertionContext } from './assertions/types.js'
import { loadChecks, type CheckItem } from './checks.js'
import { loadChecklist } from './checklist.js'
import { renderDraft } from './compose/draft.js'
import { materializePlan } from './compose/materialize.js'
import { emptyPlan, missingSlots, type PlanProblem } from './compose/plan.js'
import { initTasks, type InitFailure, type InitPayload } from './init/init.js'
import { recordReview, type ReviewPayload } from './review/review.js'
import { recordAcceptance, type EvidenceItem, type RecordPayload } from './record/record.js'
import { hashContractFiles } from './graph-hash.js'
import {
  SpecgraphError,
  resolveSpecgraphEnv,
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
  /** Set when compose-plan.json no longer matches ownership.json. */
  designStale?: string
  /** Present when impl_gate_record has run against this implRoot. */
  implementation?: { pass: number; fail: number; skipped: number; total: number; generatedAt: string; stale: boolean }
}

const MAX_EVIDENCE = 2048
const RUN_TTL_MS = 10 * 60 * 1000
/** Runs on disk survive an extension reload, so they get a longer lease. */
const RUN_FILE_TTL_MS = 24 * 60 * 60 * 1000

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

function runsDir(graphRoot: string): string {
  return path.join(graphRoot, '.impl-gate', 'runs')
}

/** Best effort: a read-only root must not turn a successful check into a failure. */
function persistRun(runId: string, record: RunRecord): void {
  try {
    const dir = runsDir(record.graphRoot)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ runId, ...record }), 'utf8')
  } catch {
    // ignore: the in-memory record still serves this process
  }
}

function readRunFile(root: string, runId: string): RunRecord | null {
  if (!/^run-[a-z0-9]+-[a-z0-9]+$/.test(runId)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runsDir(root), `${runId}.json`), 'utf8')) as
      | (RunRecord & { runId?: string })
      | null
    if (raw === null || typeof raw.finishedAt !== 'number') return null
    if (Date.now() - raw.finishedAt > RUN_FILE_TTL_MS) return null
    return { payload: raw.payload, reasons: raw.reasons, graphRoot: raw.graphRoot, finishedAt: raw.finishedAt }
  } catch {
    return null
  }
}

function readLatestRunFile(root: string): RunRecord | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(runsDir(root)).filter((name) => name.endsWith('.json'))
  } catch {
    return null
  }
  let best: RunRecord | null = null
  const wanted = normalizeRoot(root)
  for (const name of entries) {
    const record = readRunFile(root, name.slice(0, -'.json'.length))
    if (record === null) continue
    if (record.graphRoot !== wanted) continue
    if (best === null || record.finishedAt > best.finishedAt) best = record
  }
  return best
}

export function rememberRun(
  runId: string,
  payload: CheckPayload,
  reasons: Record<string, string>,
  graphRoot: string,
): void {
  const record: RunRecord = {
    payload,
    reasons,
    graphRoot: normalizeRoot(graphRoot),
    finishedAt: Date.now(),
  }
  runs.set(runId, record)
  persistRun(runId, record)
  for (const [key, entry] of runs) {
    if (Date.now() - entry.finishedAt > RUN_TTL_MS) runs.delete(key)
  }
}

type LookupResult =
  | { kind: 'ok'; record: RunRecord }
  | { kind: 'missing' }
  | { kind: 'expired' }

function lookupRun(runId: string, root?: string): LookupResult {
  const record = runs.get(runId)
  if (record === undefined) {
    const fromDisk = root === undefined ? null : readRunFile(root, runId)
    if (fromDisk === null) return { kind: 'missing' }
    return { kind: 'ok', record: fromDisk }
  }
  if (Date.now() - record.finishedAt > RUN_TTL_MS) {
    runs.delete(runId)
    const fromDisk = root === undefined ? null : readRunFile(root, runId)
    if (fromDisk === null) return { kind: 'expired' }
    return { kind: 'ok', record: fromDisk }
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
  if (best === undefined) {
    const fromDisk = readLatestRunFile(root)
    return fromDisk === null ? { kind: 'missing' } : { kind: 'ok', record: fromDisk }
  }
  return { kind: 'ok', record: { ...best, payload: { ...best.payload, runId: best.payload.runId || bestId } } }
}

export function getRun(runId: string, root?: string): RunRecord | null {
  const result = lookupRun(runId, root)
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

/**
 * 1.2: design artifacts drift silently. ownership.json records the sha256 of the
 * plan that produced SPEC.md/checklist; if the plan changed afterwards, say so.
 */
function designStaleness(implRoot: string): string | undefined {
  const planFile = path.join(implRoot, 'compose-plan.json')
  const ownershipFile = path.join(implRoot, '.impl-gate', 'ownership.json')
  try {
    if (!fs.existsSync(planFile) || !fs.existsSync(ownershipFile)) return undefined
    const record = JSON.parse(fs.readFileSync(ownershipFile, 'utf8')) as { plan_sha256?: unknown }
    const expected = typeof record.plan_sha256 === 'string' ? record.plan_sha256 : ''
    if (expected === '') return undefined
    const actual = createHash('sha256').update(fs.readFileSync(planFile)).digest('hex')
    if (actual === expected) return undefined
    return `compose-plan.json changed after the last materialize (plan sha256 ${actual.slice(0, 12)}… vs ${expected.slice(0, 12)}…); SPEC.md / checklist / tasks are stale — run impl_gate_compose mode:"materialize" then impl_gate_init again`
  } catch {
    return undefined
  }
}

/**
 * 0.3.6: impl_gate_record writes .impl-gate/ac-evidence.json next to the plan.
 * Surface it from check so "design is fine, implementation is 12/21" is one call
 * instead of two, and flag evidence produced against an older plan.
 */
function implementationEvidence(implRoot: string): { pass: number; fail: number; skipped: number; total: number; generatedAt: string; stale: boolean } | undefined {
  const evidenceFile = path.join(implRoot, '.impl-gate', 'ac-evidence.json')
  try {
    if (!fs.existsSync(evidenceFile)) return undefined
    const stored = JSON.parse(fs.readFileSync(evidenceFile, 'utf8')) as {
      planSha256?: unknown
      generatedAt?: unknown
      summary?: { pass?: unknown; fail?: unknown; skipped?: unknown; total?: unknown }
    }
    const summary = stored.summary ?? {}
    const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    const planFile = path.join(implRoot, 'compose-plan.json')
    const current = fs.existsSync(planFile) ? createHash('sha256').update(fs.readFileSync(planFile)).digest('hex') : ''
    return {
      pass: num(summary.pass),
      fail: num(summary.fail),
      skipped: num(summary.skipped),
      total: num(summary.total),
      generatedAt: typeof stored.generatedAt === 'string' ? stored.generatedAt : '',
      stale: current !== '' && typeof stored.planSha256 === 'string' && stored.planSha256 !== '' && stored.planSha256 !== current,
    }
  } catch {
    return undefined
  }
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

  const environment = resolveSpecgraphEnv({
    command: config.specgraphCommand,
    pythonPath: config.pythonPath,
    home: config.specgraphCwd,
    startDirs: [graphRoot],
  })
  const runner = {
    argv: environment.argv,
    cwd: environment.cwd,
    env: environment.env,
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
    specgraphHome: environment.home ?? '',
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

  const staleDesign = designStaleness(implRoot)
  const implementation = implementationEvidence(implRoot)
  const payload: CheckPayload = {
    ...base,
    passed,
    failed,
    notRun,
    evidence,
    durationMs: Date.now() - startedMs,
    ...(staleDesign === undefined ? {} : { designStale: staleDesign }),
    ...(implementation === undefined ? {} : { implementation }),
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
  if (payload.designStale !== undefined) lines.push(`stale design: ${payload.designStale}`)
  if (payload.implementation !== undefined) {
    const impl = payload.implementation
    lines.push(`implementation evidence: PASS ${impl.pass} / FAIL ${impl.fail} / SKIPPED ${impl.skipped} (${impl.total} AC) — recorded ${impl.generatedAt === '' ? 'unknown time' : impl.generatedAt}`)
    if (impl.stale) lines.push('these AC results were produced against an older compose-plan.json; re-run impl_gate_record')
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
    const found = lookupRun(runId, root)
    if (found.kind === 'missing') {
      return fail('E_NO_PRIOR_RUN', `no cached run for runId ${runId}`, 'Run impl_gate_check first; runs are cached in memory for 10 minutes and under <graphRoot>/.impl-gate/runs for a day.')
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

export interface ComposeReview {
  playbook: string
  specPath: string
  rubric: string[]
}

export interface ComposePayload {
  ok: boolean
  mode: string
  planPath: string
  draftPath: string
  missingSlots: string[]
  problems: PlanProblem[]
  review: ComposeReview
  graphRoot?: string
  specMd?: string
  packageMd?: string
  manifestPath?: string
  files?: string[]
  waves?: Array<{ index: number; modules: string[]; dependsOn: string[] }>
  overlaps?: Array<{ a: string; b: string; files: string[] }>
  /** Set when `mode:"plan" + overwrite:true` moved an existing plan aside. */
  backupPath?: string
  planSha256?: string
  checklistPreserved?: string[]
  checklistBackupPath?: string
  tasksRefreshed?: string[]
  warnings?: Array<{ code: string; count: number; items: string[] }>
}

/** G8: the verdict scale a reviewer must apply to every module of SPEC.md. */
export const REVIEW_RUBRIC = ['可开工', '需澄清', '不可开工']

/**
 * G8 review entry point: both compose modes point at the packaged playbook and
 * the SPEC.md a reviewer reads. `playbooks/` ships beside `lib/` in the repo
 * and in an installed package, so the same resolve works in both.
 */
export function composeReview(outDir: string): ComposeReview {
  return {
    playbook: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'playbooks', 'review.md'),
    specPath: path.join(path.resolve(outDir), 'SPEC.md'),
    rubric: [...REVIEW_RUBRIC],
  }
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
    specgraphCwd?: unknown
  }
  const outDirRaw = typeof args.outDir === 'string' ? args.outDir.trim() : ''
  if (outDirRaw.length === 0) return fail('E_OUT_DIR_REQUIRED', 'outDir is required')

  const mode =
    args.mode === 'materialize' ? 'materialize' : args.mode === 'draft' ? 'draft' : 'plan'
  if (mode === 'materialize') {
    const toolHome = typeof args.specgraphCwd === 'string' ? args.specgraphCwd.trim() : ''
    const materializeConfig = toolHome.length > 0 ? { ...config, specgraphCwd: toolHome } : config
    const outcome = await materializePlan(outDirRaw, materializeConfig)
    if (outcome.ok) {
      return {
        ok: true,
        mode: 'materialize',
        planPath: path.join(path.resolve(outDirRaw), 'compose-plan.json'),
        draftPath: '',
        missingSlots: [],
        problems: [],
        review: composeReview(outDirRaw),
        graphRoot: outcome.graphRoot,
        specMd: outcome.specMd,
        packageMd: outcome.packageMd,
        manifestPath: outcome.manifestPath,
        files: outcome.files,
        waves: outcome.waves,
        overlaps: outcome.overlaps,
        planSha256: outcome.planSha256,
        checklistPreserved: outcome.checklistPreserved,
        ...(outcome.checklistBackupPath === undefined ? {} : { checklistBackupPath: outcome.checklistBackupPath }),
        ...(outcome.tasksRefreshed === undefined ? {} : { tasksRefreshed: outcome.tasksRefreshed }),
        warnings: outcome.warnings,
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
  const planPath = path.join(outDir, 'compose-plan.json')
  const draftPath = path.join(outDir, 'SPEC-DRAFT.md')
  const requirement = typeof args.requirement === 'string' ? args.requirement : undefined

  let existingPlan: unknown
  try {
    existingPlan = JSON.parse(await fs.promises.readFile(planPath, 'utf8')) as unknown
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') return failureFrom(error)
  }

  await fs.promises.mkdir(outDir, { recursive: true })

  // `draft` refreshes SPEC-DRAFT.md from whatever plan is on disk and never
  // writes the plan. Before 0.3.0 the only documented way to refresh the draft
  // was `mode:"plan" + overwrite:true`, which silently replaced a filled plan
  // with an empty template — the most expensive bug found in the 0.2.x review.
  if (mode === 'draft') {
    const source =
      existingPlan ??
      emptyPlan({
        name: typeof args.name === 'string' ? args.name : undefined,
        stack: typeof args.stack === 'string' ? args.stack : undefined,
      })
    await fs.promises.writeFile(draftPath, renderDraft({ plan: source, requirement }), 'utf8')
    return {
      ok: true,
      mode: 'draft',
      planPath: existingPlan === undefined ? '' : planPath,
      draftPath,
      missingSlots: missingSlots(source),
      problems: [],
      review: composeReview(outDir),
    }
  }

  // A project directory usually has files already; plan mode only writes the
  // two files it owns, so an otherwise non-empty outDir is fine.
  if (existingPlan !== undefined && args.overwrite !== true) {
    return fail(
      'E_PLAN_EXISTS',
      `compose-plan.json already exists: ${planPath}`,
      'use mode:"draft" to refresh SPEC-DRAFT.md without touching the plan, or overwrite:true to reset the plan (a timestamped backup is written first)',
    )
  }

  const template = emptyPlan({
    name: typeof args.name === 'string' ? args.name : undefined,
    stack: typeof args.stack === 'string' ? args.stack : undefined,
  })
  let backupPath = ''
  if (existingPlan !== undefined) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    backupPath = path.join(outDir, `compose-plan.backup-${stamp}.json`)
    await fs.promises.rename(planPath, backupPath)
  }
  await fs.promises.writeFile(planPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  await fs.promises.writeFile(draftPath, renderDraft({ plan: template, requirement }), 'utf8')

  return {
    ok: true,
    mode: 'plan',
    planPath,
    draftPath,
    missingSlots: missingSlots(template),
    problems: [],
    review: composeReview(outDir),
    ...(backupPath === '' ? {} : { backupPath }),
  }
}

/**
 * G3: builds per-module task cards from <outDir>/compose-plan.json.
 * Argument validation stays here; all plan/card work lives in init/.
 */
export function buildInit(rawArgs: unknown): InitPayload | InitFailure {
  const args = (rawArgs ?? {}) as Record<string, unknown>
  const outDir = typeof args.outDir === 'string' ? args.outDir.trim() : ''
  if (outDir.length === 0) {
    return { ok: false, error: { code: 'E_ROOT_MISSING', message: 'outDir is required' } }
  }
  const implRoot = typeof args.implRoot === 'string' ? args.implRoot : ''
  const overwrite = args.overwrite === true
  return initTasks(outDir, { implRoot, overwrite })
}

function renderInit(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<Omit<InitPayload, 'ok'>> & {
    ok?: boolean
    error?: { code: string; message: string }
  }
  if (payload.ok !== true) {
    const error = payload.error
    return [{ type: 'text', text: `impl_gate_init failed: ${error?.code ?? ''} — ${error?.message ?? ''}` }]
  }
  const lines = [
    `impl_gate_init: ${payload.tasksDir ?? ''}`,
    `cards (${payload.cards?.length ?? 0}): ${(payload.cards ?? []).map((card) => `${card.moduleId} ${card.cardPath}`).join(', ')}`,
    `files (${payload.filesWritten?.length ?? 0})`,
  ]
  for (const wave of payload.waves ?? []) {
    lines.push(`wave ${wave.index}: ${wave.modules.join(', ')}${wave.dependsOn.length > 0 ? ` (after ${wave.dependsOn.join(', ')})` : ''}`)
  }
  if ((payload.overlaps ?? []).length > 0) {
    lines.push(`overlaps: ${(payload.overlaps ?? []).map((entry) => `${entry.a}/${entry.b}: ${entry.files.join(', ')}`).join(' | ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function reviewLine(review: ComposeReview | undefined): string {
  if (review === undefined) return 'review: not available'
  return `review: ${review.playbook} | spec: ${review.specPath} | rubric: ${review.rubric.join('/')}`
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
      reviewLine(payload.review),
    ]
    if (overlaps.length > 0) {
      lines.push(`overlaps (${overlaps.length}): ${overlaps.map((entry) => `${entry.a}/${entry.b}: ${entry.files.join(', ')}`).join(' | ')}`)
    }
    if ((payload.tasksRefreshed ?? []).length > 0) {
      lines.push(`tasks: refreshed ${payload.tasksRefreshed?.length ?? 0} card file(s) from the same plan`)
    }
    if ((payload.checklistPreserved ?? []).length > 0) {
      const backup = payload.checklistBackupPath === undefined ? '' : `; previous checklist at ${payload.checklistBackupPath}`
      lines.push(`checklist: preserved ${payload.checklistPreserved?.length ?? 0} filled row(s)${backup}`)
    }
    for (const warning of payload.warnings ?? []) {
      lines.push(`warning ${warning.code} (${warning.count}): ${warning.items.join(', ')}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const slots = payload.missingSlots ?? []
  const lines =
    payload.mode === 'draft'
      ? [`impl_gate_compose draft: ${payload.draftPath ?? ''}`]
      : [`impl_gate_compose ${payload.mode ?? ''}: ${payload.planPath ?? ''}`, `draft: ${payload.draftPath ?? ''}`]
  if (payload.mode === 'draft') {
    lines.push(
      payload.planPath === ''
        ? 'note: no compose-plan.json yet; draft rendered from an empty template'
        : 'note: SPEC-DRAFT.md refreshed from the existing plan; the plan was not touched',
    )
  }
  if (payload.backupPath !== undefined) lines.push(`previous plan moved to: ${payload.backupPath}`)
  lines.push(slots.length === 0 ? 'missingSlots: none' : `missingSlots (${slots.length}): ${slots.join(' | ')}`)
  lines.push(reviewLine(payload.review))
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
    designStale: { type: 'string' },
    implementation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pass: { type: 'number' },
        fail: { type: 'number' },
        skipped: { type: 'number' },
        total: { type: 'number' },
        generatedAt: { type: 'string' },
        stale: { type: 'boolean' },
      },
      required: ['pass', 'fail', 'skipped', 'total', 'generatedAt', 'stale'],
    },
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
      enum: ['plan', 'draft', 'materialize'],
      description:
        'plan=首次写空槽模板与草稿（已有 plan 时拒绝，除非 overwrite:true）；draft=只按现有 plan 刷新 SPEC-DRAFT.md，绝不改 plan；materialize=物化图谱与九节 SPEC.md。',
    },
    overwrite: {
      type: 'boolean',
      description: 'plan 模式：已有 compose-plan.json 时允许重置（先写时间戳备份）。materialize 不受影响。默认 false。',
    },
    specgraphCwd: {
      type: 'string',
      description: '本次调用覆盖配置里的 specgraphCwd（spec-graph 源码目录）；缺省按配置、向上查找、SPECGRAPH_HOME 依次解析。',
    },
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
    review: {
      type: 'object',
      additionalProperties: false,
      properties: {
        playbook: { type: 'string' },
        specPath: { type: 'string' },
        rubric: { type: 'array', items: { type: 'string' } },
      },
      required: ['playbook', 'specPath', 'rubric'],
    },
    packageMd: { type: 'string' },
    manifestPath: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    backupPath: { type: 'string' },
    planSha256: { type: 'string' },
    checklistPreserved: { type: 'array', items: { type: 'string' } },
    checklistBackupPath: { type: 'string' },
    tasksRefreshed: { type: 'array', items: { type: 'string' } },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          count: { type: 'number' },
          items: { type: 'array', items: { type: 'string' } },
        },
        required: ['code', 'count', 'items'],
        additionalProperties: false,
      },
    },
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


const reviewParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outDir: { type: 'string', description: '含 compose-plan.json 与 SPEC.md 的项目目录（绝对路径）。' },
    reviewer: { type: 'string', description: '评审者标识（人或者子智能体 id），写进 review.json 作为证据。' },
    round: { type: 'number', description: '轮次；缺省 = 已有轮次 + 1。同一轮重复提交会被拒绝。' },
    verdicts: {
      type: 'array',
      description: '每个模块一条：ready=能直接开工，clarify=开工会上问一句就能开工，blocked=照文档写不出来。',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          module: { type: 'string', description: '模块 id，必须存在于 plan。' },
          status: { type: 'string', enum: ['ready', 'clarify', 'blocked'] },
          note: { type: 'string', description: '一句话理由。' },
          blocking: { type: 'array', items: { type: 'string' }, description: 'blocked 时必须给出具体缺口。' },
          evidence: { type: 'string', description: '理由在 SPEC.md 的位置，形如 "SPEC.md:412"。' },
        },
        required: ['module', 'status'],
      },
    },
  },
  required: ['outDir', 'reviewer', 'verdicts'],
}

const reviewOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    reviewPath: { type: 'string' },
    round: { type: 'number' },
    ready: { type: 'number' },
    clarify: { type: 'number' },
    blocked: { type: 'number' },
    blocking: { type: 'number' },
    total: { type: 'number' },
    planSha256: { type: 'string' },
    specSha256: { type: 'string' },
    blockingDelta: { type: 'number' },
    error: {
      type: 'object',
      additionalProperties: false,
      properties: { code: { type: 'string' }, message: { type: 'string' }, detail: { type: 'string' } },
      required: ['code', 'message'],
    },
  },
  required: ['ok'],
}

function renderReview(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<ReviewPayload> & { ok?: boolean; error?: { code: string; message: string; detail?: string } }
  // a recorded round is always ok:true; a failure is { ok:false, error }
  if (payload.error !== undefined && payload.ok !== true) {
    return [{ type: 'text', text: `impl_gate_review failed: ${payload.error.code} — ${payload.error.message}` }]
  }
  const lines = [
    `impl_gate_review: round ${payload.round ?? 0} recorded at ${payload.reviewPath ?? ''}`,
    `verdicts: ready ${payload.ready ?? 0} / clarify ${payload.clarify ?? 0} / blocked ${payload.blocked ?? 0} (of ${payload.total ?? 0} modules)`,
    `blocking items: ${payload.blocking ?? 0}`,
  ]
  const planSha = (payload.planSha256 ?? '').slice(0, 12)
  const specSha = (payload.specSha256 ?? '').slice(0, 12)
  if (planSha !== '') {
    lines.push(`plan sha256: ${planSha}${specSha === '' ? '（SPEC.md 尚未物化）' : ` / spec sha256: ${specSha}`}`)
  }
  if (payload.blockingDelta !== undefined) {
    const verb = payload.blockingDelta > 0 ? '减少' : payload.blockingDelta < 0 ? '增加' : '不变'
    lines.push(`blocking vs 上一轮: ${verb} ${Math.abs(payload.blockingDelta)}`)
  }
  if ((payload.blocked ?? 0) > 0 || (payload.blocking ?? 0) > 0) {
    lines.push('这条评审未过线：blocked 或 blocking>0 时先改 plan 再重跑 materialize，不要开始实现。')
  } else {
    lines.push('评审过线：可以进入 impl_gate_init 分发。')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

const review = {
  name: 'impl_gate_review',
  description:
    'Record one review round of a generated SPEC.md into <outDir>/.impl-gate/review.json. ' +
    'A reviewer (human or another agent) marks every module ready / clarify / blocked with reasons, ' +
    'optionally citing where the reason can be read ("SPEC.md:<line>"). ' +
    'Each round also records the sha256 of compose-plan.json and SPEC.md, so later rounds can be proven to judge ' +
    'the same document, and reports how blocking moved versus the previous round. ' +
    'It appends rounds and never edits the plan, SPEC.md or the graph; use it before impl_gate_init so the ' +
    '"can we start?" judgement is evidence instead of chat history. The pass line is blocking = 0.',
  parameters: reviewParameters,
  output: { schema: reviewOutputSchema, render: renderReview },
  async execute(args: unknown) {
    const input = (args ?? {}) as { outDir?: string; reviewer?: string; round?: number; verdicts?: import('./review/review.js').ReviewVerdict[] }
    if (typeof input.outDir !== 'string' || input.outDir.trim() === '') {
      return { ok: false, error: { code: 'E_ROOT_MISSING', message: 'outDir is required' } }
    }
    if (typeof input.reviewer !== 'string') {
      return { ok: false, error: { code: 'REVIEW_INVALID', message: 'reviewer is required' } }
    }
    return await recordReview(input.outDir, {
      reviewer: input.reviewer,
      ...(input.round === undefined ? {} : { round: input.round }),
      verdicts: Array.isArray(input.verdicts) ? input.verdicts : [],
    })
  },
}

const recordParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outDir: { type: 'string', description: '含 compose-plan.json 的项目目录（绝对路径）。' },
    implRoot: { type: 'string', description: '命令的执行目录，缺省等于 outDir。' },
    modules: { type: 'array', items: { type: 'string' }, description: '只跑这些模块的验收；缺省=全部。' },
    timeoutMs: { type: 'number', description: '单条命令超时毫秒，缺省 120000。' },
    dryRun: { type: 'boolean', description: 'true=只登记将要执行的命令，不真正执行。' },
  },
  required: ['outDir'],
}

const recordOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    evidencePath: { type: 'string' },
    planSha256: { type: 'string' },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pass: { type: 'number' },
        fail: { type: 'number' },
        skipped: { type: 'number' },
        total: { type: 'number' },
      },
      required: ['pass', 'fail', 'skipped', 'total'],
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          module: { type: 'string' },
          command: { type: 'string' },
          status: { type: 'string' },
          exitCode: { type: 'number' },
          durationMs: { type: 'number' },
          tail: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'module', 'command', 'status', 'exitCode', 'durationMs', 'tail'],
      },
    },
    error: errorSchema,
  },
  required: ['ok'],
}

function renderRecord(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const payload = value as Partial<RecordPayload> & { ok?: boolean; error?: { code: string; message: string; detail?: string } }
  if (payload.error !== undefined && payload.ok !== true) {
    return [{ type: 'text', text: `impl_gate_record failed: ${payload.error.code} — ${payload.error.message}` }]
  }
  const summary = payload.summary
  const items = payload.items ?? []
  const failed = items.filter((item) => item.status === 'FAIL')
  const lines = [
    `impl_gate_record: PASS ${summary?.pass ?? 0} / FAIL ${summary?.fail ?? 0} / SKIPPED ${summary?.skipped ?? 0} (total ${summary?.total ?? 0})`,
    `evidence: ${payload.evidencePath ?? ''}`,
    `plan sha256: ${(payload.planSha256 ?? '').slice(0, 12)}`,
  ]
  if (failed.length > 0) {
    lines.push(`failed (${failed.length}):`)
    for (const item of failed.slice(0, 5)) {
      const firstLine = item.tail === '' ? '' : ` :: ${item.tail.split(/\r?\n/)[0]}`
      lines.push(`- ${item.id} (${item.module}) exit ${item.exitCode}${firstLine}`)
    }
    lines.push('失败的断言要修实现或修文档；把它贴回 plan 的 acceptance 里，不要只留在聊天里。')
  } else if ((summary?.skipped ?? 0) > 0) {
    lines.push('没有失败，但有未执行的断言：dryRun、缺命令，或命令首词不在允许列表里。')
  } else if ((summary?.total ?? 0) > 0) {
    lines.push('全部通过：这些退出码就是实现的「证据」，把它们连同 evidence 文件一起交付。')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

const initParameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outDir: { type: 'string', description: '含 compose-plan.json 的目录（绝对路径）；卡片写到 <outDir>/tasks/。' },
    implRoot: { type: 'string', description: '可选；只影响卡片文件白名单的前缀展示，不参与校验。' },
    overwrite: { type: 'boolean', description: '是否覆盖 tasks/ 下本次要写的文件，默认 false。' },
  },
  required: ['outDir'],
}

const initOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    tasksDir: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          moduleId: { type: 'string' },
          wave: { type: 'number' },
          cardPath: { type: 'string' },
        },
        required: ['moduleId', 'wave', 'cardPath'],
        additionalProperties: false,
      },
    },
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
    filesWritten: { type: 'array', items: { type: 'string' } },
    error: errorSchema,
  },
}

export function buildTools(deps: ToolDeps) {
  const check = {
    name: 'impl_gate_check',
    description:
      'Run the 32 IMPL-GATE assertions against a spec-graph root. ' +
      'Calls `python -m specgraph check --json` first; an invalid graph makes every assertion NOT-RUN with D4_GRAPH_INVALID. ' +
      'Does not do GUI checks, does not render a canvas, and never writes into the inspected project. ' +
      'Use it once before delivery, when you need the full verdict table.',
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
      'Does not re-run checks, does not do GUI checks and does not render a canvas. ' +
      'Use it right after check to read the summary and uncovered set.',
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
      'Does not re-run checks, does not do GUI checks and does not render a canvas. ' +
      'Use it when only the contract deliverables need a yes/no.',
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
      'Turn a requirement into a施工文档 chain. 动手前先读包内 playbooks/compose.md（相对本包根目录）；它规定了 plan 各字段的写法。 ' +
      'mode "plan" writes compose-plan.json (the only place content lives) and ' +
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

  const init = {
    name: 'impl_gate_init',
    description:
      'Generate per-module task cards from <outDir>/compose-plan.json into <outDir>/tasks/ (TASKS.md, cards.json, ' +
      'wave-N/<id>-<dir>.md). Waves and overlaps come from the same planner as materialize; output is deterministic. ' +
      'It never edits the graph root, SPEC.md or export/, and never invents requirements or assertions. ' +
      'Use it after materialize, before splitting implementation across several agents.',
    parameters: initParameters,
    output: { schema: initOutputSchema, render: renderInit },
    async execute(args: unknown) {
      try {
        return buildInit(args)
      } catch (error) {
        return failureFrom(error)
      }
    },
  }

  const record = {
    name: 'impl_gate_record',
    description:
      'Run the acceptance commands written in <outDir>/compose-plan.json and store the result as evidence ' +
      '(<outDir>/.impl-gate/ac-evidence.json, plus tasks/EVIDENCE.md when tasks/ exists). ' +
      'Each row records PASS/FAIL with the real exit code, duration and the log tail. ' +
      'Commands run in implRoot (default outDir) through the shell, and only commands whose first word is a known ' +
      'runner (pnpm/npm/node/python/git/...) are executed; anything else is SKIPPED with RUNNER_NOT_ALLOWED. ' +
      'Use dryRun first to see what would run. This is the implementation-side counterpart of impl_gate_review: ' +
      'review judges the document, record judges the code against the document.',
    parameters: recordParameters,
    output: { schema: recordOutputSchema, render: renderRecord },
    async execute(args: unknown) {
      const input = (args ?? {}) as { outDir?: string; implRoot?: string; modules?: string[]; timeoutMs?: number; dryRun?: boolean }
      if (typeof input.outDir !== 'string' || input.outDir.trim() === '') {
        return { ok: false, error: { code: 'E_ROOT_MISSING', message: 'outDir is required' } }
      }
      try {
        const outcome = recordAcceptance(input.outDir, {
          ...(typeof input.implRoot === 'string' && input.implRoot !== '' ? { implRoot: input.implRoot } : {}),
          ...(Array.isArray(input.modules) ? { modules: input.modules } : {}),
          ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.dryRun === true ? { dryRun: true } : {}),
        })
        if (!outcome.ok) return outcome
        return {
          ok: true,
          evidencePath: outcome.evidencePath,
          planSha256: outcome.planSha256,
          summary: outcome.summary,
          items: outcome.items.map((item: EvidenceItem) => ({
            id: item.id,
            module: item.module,
            command: item.command,
            status: item.status,
            exitCode: item.exitCode === null ? -1 : item.exitCode,
            durationMs: item.durationMs,
            tail: item.tail.length > 600 ? `${item.tail.slice(0, 600)}…` : item.tail,
            ...(item.reason === undefined ? {} : { reason: item.reason }),
          })),
        }
      } catch (error) {
        return failureFrom(error)
      }
    },
  }

  return [check, report, verify, compose, init, review, record]
}

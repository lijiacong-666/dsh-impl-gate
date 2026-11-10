// `mode: "materialize"`: compose-plan.json -> spec-graph root + nine-section
// SPEC.md + export/ instruction package. Every judgement about the graph comes
// from `python -m specgraph check|export`; nothing here re-implements it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  preflightSpecgraph,
  resolveSpecgraphEnv,
  runProcess,
  SpecgraphError,
  type SpecgraphEnv,
} from '../specgraph.js'
import type { Plan, PlanProblem } from './plan.js'
import { validatePlan } from './plan.js'
import { renderGraphToml, renderModuleSpec } from './graph.js'
import { renderSpecDoc } from './spec-doc.js'
import { computeWaves, type WavesResult } from '../init/waves.js'
import { loadChecks } from '../checks.js'
import { CHECKLIST_REL, mergeChecklist, specLineFor } from './checklist-template.js'
import { MAPPING_REL, renderMappingTemplate } from './mapping-template.js'
import { initTasks } from '../init/init.js'

export interface ComposeWarning {
  code:
    | 'COVERAGE_GAP'
    | 'ERROR_OWNER_MISSING'
    | 'AUTH_UNSPECIFIED'
    | 'ERROR_UNUSED'
    | 'FILE_OWNERSHIP_OVERLAP'
    | 'CONSTRAINT_HAS_PATH'
    | 'AC_AUTH_UNSTATED'
    | 'HTTP_ROUTE_UNCOVERED'
    | 'TYPE_OWNER_MISSING'
    | 'AC_HTTP_OUTSIDE_SHELL'
  count: number
  items: string[]
}

export interface MaterializeConfig {
  specgraphCommand: string
  pythonPath: string
  specgraphCwd: string
  timeoutMs: number
  /** Used only as a walk-up start for the specgraph home. */
  implRoot?: string
}

export interface MaterializePayload {
  ok: true
  mode: 'materialize'
  graphRoot: string
  specMd: string
  packageMd: string
  manifestPath: string
  files: string[]
  waves: WavesResult['waves']
  overlaps: WavesResult['overlaps']
  /** sha256 of compose-plan.json as written; check compares it to ownership.json. */
  planSha256: string
  /** Rows carried over from the previous checklist because they were PASS/FAIL. */
  checklistPreserved: string[]
  checklistBackupPath?: string
  /** Card files re-rendered because tasks/ already existed. */
  tasksRefreshed?: string[]
  warnings: ComposeWarning[]
}

export interface MaterializeFailure {
  ok: false
  code: string
  message: string
  detail?: string
  problems?: PlanProblem[]
  issues?: unknown[]
  graphExitCode?: number
}

export type MaterializeOutcome = MaterializePayload | MaterializeFailure

const OWNERSHIP = '.impl-gate/ownership.json'

function toPosix(file: string): string {
  return file.split(path.sep).join('/')
}

// `impl_gate_check` writes <graphRoot>/.impl-gate/runs/run-*.json. Those are
// tool output, so a later materialize must not treat them as foreign files.
const RUN_RECORD_RE = /(^|\/)\.impl-gate\/runs\/run-[a-z0-9]+-[a-z0-9]+\.json$/

export function isRunRecord(file: string): boolean {
  return RUN_RECORD_RE.test(file)
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile()) out.push(full)
    }
  }
  await walk(root, 0)
  return out
}

export interface OwnershipRecord {
  generated: string[]
  managedBy: string
  plan_sha256: string
  generated_at: string
}

async function readOwnershipRecord(outDir: string): Promise<OwnershipRecord | undefined> {
  try {
    const raw = await fs.promises.readFile(path.join(outDir, OWNERSHIP), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OwnershipRecord>
    if (!Array.isArray(parsed.generated)) return undefined
    return {
      generated: parsed.generated.filter((entry): entry is string => typeof entry === 'string'),
      managedBy: typeof parsed.managedBy === 'string' ? parsed.managedBy : '',
      plan_sha256: typeof parsed.plan_sha256 === 'string' ? parsed.plan_sha256 : '',
      generated_at: typeof parsed.generated_at === 'string' ? parsed.generated_at : '',
    }
  } catch {
    return undefined
  }
}

async function writeOwnership(outDir: string, generated: string[], planSha256: string): Promise<void> {
  const file = path.join(outDir, OWNERSHIP)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const body: OwnershipRecord = {
    generated: [...generated].sort(),
    managedBy: `dsh-impl-gate@${__PLUGIN_VERSION__}`,
    plan_sha256: planSha256,
    generated_at: new Date().toISOString(),
  }
  await fs.promises.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

/** sha256 of the plan file on disk, so "plan changed after materialize" is detectable. */
function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

// Only directory-qualified paths count: a bare `app.js` in prose is a filename
// reference, while `public/app.js` is the kind of hard-coded path that makes
// specgraph reject the rendered spec.md.
const FILE_PATH_RE = /(?:^|[\s（(，,、])(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|sql|html|css|json|md|yml|yaml)\b/

/** Signals a reviewer must not miss: gaps that validatePlan tolerates on purpose. */
export function collectWarnings(plan: Plan): ComposeWarning[] {
  const out: ComposeWarning[] = []
  const covered = new Set<string>()
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      if (typeof item.covers === 'string' && item.covers !== '') covered.add(item.covers)
    }
  }
  const gap = (plan.goals ?? []).filter((goal, index) => !covered.has(`G${index + 1}`))
  if (gap.length > 0) {
    out.push({ code: 'COVERAGE_GAP', count: gap.length, items: gap.map((_, i) => `G${i + 1}`) })
  }
  const noOwner = (plan.errors ?? []).filter((entry) => entry.by === undefined || entry.by === '').map((entry) => entry.code)
  if (noOwner.length > 0) out.push({ code: 'ERROR_OWNER_MISSING', count: noOwner.length, items: noOwner })
  const referenced = new Set<string>()
  for (const module of plan.modules) {
    for (const text of module.constraints ?? []) {
      for (const match of text.matchAll(/\bE_[A-Z0-9_]+\b/g)) referenced.add(match[0])
    }
    for (const item of module.acceptance ?? []) {
      for (const match of item.assertion.matchAll(/\bE_[A-Z0-9_]+\b/g)) referenced.add(match[0])
    }
  }
  for (const flow of plan.flows ?? []) {
    for (const code of flow.failure ?? []) referenced.add(code)
  }
  const unused = (plan.errors ?? []).map((entry) => entry.code).filter((code) => !referenced.has(code))
  if (unused.length > 0) out.push({ code: 'ERROR_UNUSED', count: unused.length, items: unused })
  const noAuth = (plan.http ?? []).filter((entry) => entry.auth === undefined).map((entry) => `${entry.method} ${entry.path}`)
  if (noAuth.length > 0) out.push({ code: 'AUTH_UNSPECIFIED', count: noAuth.length, items: noAuth })

  // A type used by more than one module but claimed by nobody is the "six DTOs,
  // six copies" failure: every module invents its own shape. Warning, not error,
  // because a truly local type may legitimately be used by nobody else.
  const typeUsers = new Map<string, Set<string>>()
  for (const type of plan.types ?? []) {
    for (const module of plan.modules) {
      const texts = [
        ...(module.exposes ?? []).map((expose) => expose.signature),
        ...(module.constraints ?? []),
        ...(module.acceptance ?? []).map((item) => item.assertion),
      ]
      if (texts.some((text) => new RegExp(`\\b${type.name}\\b`).test(text))) {
        const set = typeUsers.get(type.name) ?? new Set<string>()
        set.add(module.id)
        typeUsers.set(type.name, set)
      }
    }
    for (const route of plan.http ?? []) {
      if (route.req === type.name || route.res === type.name) {
        const set = typeUsers.get(type.name) ?? new Set<string>()
        set.add(route.module)
        typeUsers.set(type.name, set)
      }
    }
  }
  const ownerless = (plan.types ?? [])
    .filter((type) => type.owner === undefined || type.owner === '')
    .filter((type) => (typeUsers.get(type.name)?.size ?? 0) > 1)
    .map((type) => type.name)
  if (ownerless.length > 0) {
    out.push({ code: 'TYPE_OWNER_MISSING', count: ownerless.length, items: ownerless })
  }

  // Two modules claiming the same file (or paths that differ only by case) is the
  // failure mode that shows up as "we both wrote it" after the fact. Warnings, not
  // errors: a shared fixture path is defensible, a collision is not.
  const owners = new Map<string, Set<string>>()
  for (const module of plan.modules) {
    for (const file of module.files ?? []) {
      const key = file.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
      const set = owners.get(key) ?? new Set<string>()
      set.add(module.id)
      owners.set(key, set)
    }
  }
  const clashes = [...owners.entries()]
    .filter(([, modules]) => modules.size > 1)
    .map(([file, modules]) => `${file} ← ${[...modules].sort().join(', ')}`)
  if (clashes.length > 0) out.push({ code: 'FILE_OWNERSHIP_OVERLAP', count: clashes.length, items: clashes })

  // specgraph rejects concrete file paths inside spec prose (IMPL_FILE_PATH): a
  // path in a constraint fails the graph check after every file is already
  // written. Catch it before the run instead of after.
  const pathish: string[] = []
  for (const module of plan.modules) {
    for (const text of module.constraints ?? []) {
      if (FILE_PATH_RE.test(text)) pathish.push(module.id + ': ' + text.slice(0, 80))
    }
  }
  if (pathish.length > 0) out.push({ code: 'CONSTRAINT_HAS_PATH', count: pathish.length, items: pathish })

  // A route that needs a session but whose acceptance rows call it bare will be
  // reviewed as "works in the doc, 401 in reality". Also flag routes no AC touches.
  const routes = plan.http ?? []
  const asserted = new Set<string>()
  const unstated: string[] = []
  const seen = new Set<string>()
  const routePath = (raw: string): string => {
    const cut = raw.split('?')[0] ?? raw
    return cut.replace(/[.,;:!?。，；：、」』”’"'）)]+$/u, '')
  }
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      // A path must start with "/": without that anchor, prose like
      // "DELETE 成功后…" is mistaken for a route mention and the real
      // "(DELETE /api/runs/:id)" later in the same sentence is skipped.
      for (const match of item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,，、；;）」』"']*)/g)) {
        const rawPath = match[2]
        if (rawPath === undefined) continue
        const path = routePath(rawPath)
        const key = `${match[1]} ${path}`
        asserted.add(key)
        const route = routes.find((entry) => entry.method === match[1] && entry.path === path)
        if (route !== undefined && (route.auth ?? 'public') !== 'public' && !/Origin|401/i.test(item.assertion)) {
          const line = `${module.id}: ${key} needs ${route.auth}`
          if (!seen.has(line)) {
            seen.add(line)
            unstated.push(line)
          }
        }
      }
    }
  }
  if (unstated.length > 0) out.push({ code: 'AC_AUTH_UNSTATED', count: unstated.length, items: unstated })
  const uncovered = routes.filter((route) => !asserted.has(`${route.method} ${route.path}`)).map((route) => `${route.method} ${route.path}`)
  if (uncovered.length > 0) out.push({ code: 'HTTP_ROUTE_UNCOVERED', count: uncovered.length, items: uncovered })

  // A module with no route of its own cannot pass an HTTP-level assertion: the
  // shell that listens is a later wave, so such an AC can only fail at its own
  // wave and forces the whole plan to be validated after full integration.
  const outside: string[] = []
  for (const module of plan.modules) {
    const owns = routes.some((route) => route.module === module.id)
    if (owns) continue
    for (const item of module.acceptance ?? []) {
      if (/\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(item.assertion)) outside.push(`${module.id}: ${item.id}`)
    }
  }
  if (outside.length > 0) out.push({ code: 'AC_HTTP_OUTSIDE_SHELL', count: outside.length, items: outside })
  return out
}

function failure(code: string, message: string, detail?: string): MaterializeFailure {
  const out: MaterializeFailure = { ok: false, code, message }
  if (detail !== undefined) out.detail = detail
  return out
}

function fromError(error: unknown): MaterializeFailure {
  if (error instanceof SpecgraphError) return failure(error.code, error.message, error.detail)
  return failure('E_INTERNAL', (error as Error).message)
}

function buildEnv(config: MaterializeConfig, outDir: string): SpecgraphEnv {
  return resolveSpecgraphEnv({
    command: config.specgraphCommand,
    pythonPath: config.pythonPath,
    home: config.specgraphCwd,
    startDirs: [config.implRoot ?? '', outDir],
  })
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return undefined
  }
}

/** Copies the two files specgraph wrote into a temp dir and returns their text. */
async function runExport(
  environment: SpecgraphEnv,
  timeoutMs: number,
  graphRoot: string,
  moduleDir: string,
): Promise<{ md: string; manifest: unknown }> {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'impl-gate-export-'))
  try {
    const output = await runProcess([...environment.argv, 'export', moduleDir, '--root', graphRoot, '--out', tmp], {
      cwd: environment.cwd,
      env: environment.env,
      timeoutMs,
    })
    if (output.exitCode !== 0) {
      const parsed = parseJson(output.stdout) as { issues?: unknown } | undefined
      if (parsed !== undefined && Array.isArray(parsed.issues)) {
        throw new SpecgraphError(
          'GRAPH_INVALID',
          `specgraph export failed for "${moduleDir}" (exit ${output.exitCode})`,
          output.stderr.slice(-4096) || output.stdout.slice(-4096),
        )
      }
      throw new SpecgraphError(
        'PYTHON_ENV_MISSING',
        `python could not run specgraph export for "${moduleDir}" (exit ${output.exitCode}); check PYTHONPATH or specgraphCwd`,
        output.stderr.slice(-4096) || output.stdout.slice(-4096),
      )
    }
    const files = (await listFiles(tmp)).sort()
    const mdFile = files.find((file) => file.endsWith('.md'))
    const jsonFile = files.find((file) => file.endsWith('.json'))
    if (mdFile === undefined || jsonFile === undefined) {
      throw new SpecgraphError('E_BAD_JSON', `specgraph export wrote no package for "${moduleDir}"`)
    }
    const md = await fs.promises.readFile(mdFile, 'utf8')
    const manifest = JSON.parse(await fs.promises.readFile(jsonFile, 'utf8')) as unknown
    return { md, manifest }
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function materializePlan(
  outDirRaw: string,
  config: MaterializeConfig,
): Promise<MaterializeOutcome> {
  const outDir = path.resolve(outDirRaw)
  const planPath = path.join(outDir, 'compose-plan.json')

  let raw: string
  try {
    raw = await fs.promises.readFile(planPath, 'utf8')
  } catch {
    return failure('E_PLAN_MISSING', `compose-plan.json not found in ${outDir}`)
  }
  let parsedPlan: unknown
  try {
    parsedPlan = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (error) {
    return failure('E_BAD_JSON', `compose-plan.json is not valid JSON: ${(error as Error).message}`)
  }

  const validation = validatePlan(parsedPlan)
  if (validation.plan === null) {
    const first = validation.problems[0]
    const message = first === undefined ? 'plan is invalid' : `${first.path || '/'} ${first.message}`
    return { ...failure('PLAN_INVALID', message), problems: validation.problems }
  }
  const plan: Plan = validation.plan

  const waves = computeWaves(plan)
  if (!waves.ok) return failure('PLAN_INVALID', waves.message)

  const target = path.join(outDir, plan.name)
  const exportDir = path.join(outDir, 'export')
  const specFile = path.join(outDir, 'SPEC.md')
  const planFile = path.join(outDir, 'compose-plan.json')
  const planSha256 = hashFile(planFile)
  const previousOwnership = await readOwnershipRecord(outDir)
  const registered = new Set(previousOwnership?.generated ?? [])

  // Idempotency: only files registered in ownership.json may be replaced.
  const existing: string[] = []
  for (const root of [target, exportDir]) {
    for (const file of await listFiles(root)) existing.push(toPosix(path.relative(outDir, file)))
  }
  if (await fs.promises.stat(specFile).then((stat) => stat.isFile()).catch(() => false)) {
    existing.push('SPEC.md')
  }
  const conflicts = existing.filter((file) => !registered.has(file) && !isRunRecord(file)).sort()
  if (conflicts.length > 0) {
    return failure(
      'EXPORT_REFUSED',
      `target contains files not written by impl-gate: ${conflicts.join(', ')}`,
      `delete them or move them away; generated: ${[...registered].sort().join(', ') || '(none)'}`,
    )
  }

  // Resolve and prove the python environment before writing anything, so a
  // missing specgraph package leaves outDir exactly as it was.
  const environment = buildEnv(config, outDir)
  try {
    await preflightSpecgraph(environment, config.timeoutMs)
  } catch (error) {
    return fromError(error)
  }

  // SPEC.md must live OUTSIDE the graph root: spec-graph treats any spec.md in
  // the root (case-insensitively on Windows) as the root node and rejects the
  // human document (language names, file paths, code blocks).
  const files = new Map<string, string>()
  files.set(`${plan.name}/graph.toml`, renderGraphToml(plan))
  for (const module of plan.modules) {
    files.set(`${plan.name}/${module.dir}/spec.md`, renderModuleSpec(plan, module))
  }
  const specText = renderSpecDoc({ plan, waves: waves.result })
  files.set('SPEC.md', specText)

  const generated = [...files.keys()]
  for (const [rel, body] of files) {
    const full = path.join(outDir, rel)
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    await fs.promises.writeFile(full, body, 'utf8')
  }
  // Written before `check` so a failed run can be fixed and re-run in place.
  // Keep files a previous successful run owned: a failed attempt only rewrote part
  // of the tree, and dropping those entries would make them look foreign next time.
  const ownedBefore = previousOwnership?.generated ?? []
  await writeOwnership(outDir, [...new Set([...ownedBefore, ...generated])], planSha256)

  const runner = { argv: environment.argv, cwd: environment.cwd, env: environment.env, timeoutMs: config.timeoutMs }
  let checkOutput
  try {
    checkOutput = await runProcess([...runner.argv, 'check', target, '--json'], runner)
  } catch (error) {
    return fromError(error)
  }
  const checkJson = parseJson(checkOutput.stdout) as { ok?: unknown; issues?: unknown } | undefined
  if (checkOutput.exitCode !== 0 || checkJson?.ok !== true) {
    const issues = Array.isArray(checkJson?.issues) ? checkJson.issues : []
    if (checkOutput.exitCode !== 0 && (checkJson === undefined || !Array.isArray(checkJson.issues))) {
      return failure(
        'PYTHON_ENV_MISSING',
        `python could not run specgraph check (exit ${checkOutput.exitCode}); check PYTHONPATH or specgraphCwd`,
        `${checkOutput.stderr}\n${checkOutput.stdout}`.trim().slice(-4096) || undefined,
      )
    }
    const hints = collectWarnings(plan)
      .map((entry) => `warning ${entry.code} (${entry.count}): ${entry.items.slice(0, 3).join('; ')}`)
      .join('\n')
    const detail = [checkOutput.stderr.slice(-2048), hints].filter((part) => part !== '').join('\n')
    return {
      ...failure(
        'GRAPH_INVALID',
        `specgraph check rejected ${target} (exit ${checkOutput.exitCode})`,
        detail === '' ? undefined : detail,
      ),
      issues,
      graphExitCode: checkOutput.exitCode,
    }
  }

  // Export one instruction package per module, then a deterministic bundle.
  const exports: Array<{ dir: string; md: string; manifest: unknown }> = []
  for (const module of plan.modules) {
    try {
      const result = await runExport(environment, config.timeoutMs, target, module.dir)
      exports.push({ dir: module.dir, ...result })
    } catch (error) {
      return fromError(error)
    }
  }
  // specgraph's per-module export says "语言与结构由实现者自选", which
  // contradicts the hard file whitelist in tasks/. State the order once, up front.
  const bundlePreface = [
    '> 本包由 impl-gate 生成。技术栈以 plan.stack 为准，目录与文件白名单以 `tasks/` 下的任务卡为准；',
    '> 只有任务卡未提到的内部实现细节才由实现者自选。',
    '',
  ].join('\n')
  files.set('export/export.md', `${bundlePreface}\n${exports.map((entry) => entry.md.trimEnd()).join('\n\n---\n\n')}\n`)
  files.set(
    'export/manifest.json',
    `${JSON.stringify({ schemaVersion: 1, modules: exports.map((entry) => ({ dir: entry.dir, manifest: entry.manifest })) }, null, 2)}\n`,
  )
  const checklistPath = path.join(outDir, CHECKLIST_REL)
  const previousChecklist = await fs.promises.readFile(checklistPath, 'utf8').catch(() => undefined)
  const merged = mergeChecklist(previousChecklist, loadChecks(), plan.name, (id) => `file:SPEC.md:${specLineFor(id, specText)}`)
  let checklistBackupPath: string | undefined
  if (previousChecklist !== undefined && merged.preserved.length > 0) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    checklistBackupPath = `${checklistPath}.bak-${stamp}`
    await fs.promises.writeFile(checklistBackupPath, previousChecklist, 'utf8')
  }
  files.set(CHECKLIST_REL, merged.body)
  files.set(MAPPING_REL, renderMappingTemplate(plan))

  for (const [rel, body] of files) {
    if (generated.includes(rel)) continue
    const full = path.join(outDir, rel)
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    await fs.promises.writeFile(full, body, 'utf8')
  }
  const all = [...files.keys()].sort()
  await writeOwnership(outDir, all, planSha256)

  // Cards are derived from the same plan: if the project already shipped them,
  // refresh them here instead of leaving a stale tasks/ tree behind.
  let tasksRefreshed: string[] = []
  if (fs.existsSync(path.join(outDir, 'tasks'))) {
    try {
      const refreshed = initTasks(outDir, { overwrite: true })
      if ('ok' in refreshed && refreshed.ok) tasksRefreshed = refreshed.filesWritten ?? []
    } catch {
      tasksRefreshed = []
    }
  }

  return {
    ok: true,
    mode: 'materialize',
    graphRoot: target,
    specMd: specFile,
    packageMd: path.join(exportDir, 'export.md'),
    manifestPath: path.join(exportDir, 'manifest.json'),
    files: all,
    waves: waves.result.waves,
    overlaps: waves.result.overlaps,
    planSha256,
    checklistPreserved: merged.preserved,
    ...(checklistBackupPath === undefined ? {} : { checklistBackupPath }),
    ...(tasksRefreshed.length === 0 ? {} : { tasksRefreshed }),
    warnings: collectWarnings(plan),
  }
}

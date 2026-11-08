// `mode: "materialize"`: compose-plan.json -> spec-graph root + nine-section
// SPEC.md + export/ instruction package. Every judgement about the graph comes
// from `python -m specgraph check|export`; nothing here re-implements it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { CHECKLIST_REL, renderChecklistTemplate } from './checklist-template.js'

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

async function readOwnership(outDir: string): Promise<Set<string>> {
  try {
    const raw = await fs.promises.readFile(path.join(outDir, OWNERSHIP), 'utf8')
    const parsed = JSON.parse(raw) as { generated?: unknown }
    if (!Array.isArray(parsed.generated)) return new Set()
    return new Set(parsed.generated.filter((entry): entry is string => typeof entry === 'string'))
  } catch {
    return new Set()
  }
}

async function writeOwnership(outDir: string, generated: string[]): Promise<void> {
  const file = path.join(outDir, OWNERSHIP)
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const body = { generated: [...generated].sort(), managedBy: 'dsh-impl-gate@0.2' }
  await fs.promises.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
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
  const registered = await readOwnership(outDir)

  // Idempotency: only files registered in ownership.json may be replaced.
  const existing: string[] = []
  for (const root of [target, exportDir]) {
    for (const file of await listFiles(root)) existing.push(toPosix(path.relative(outDir, file)))
  }
  if (await fs.promises.stat(specFile).then((stat) => stat.isFile()).catch(() => false)) {
    existing.push('SPEC.md')
  }
  const conflicts = existing.filter((file) => !registered.has(file)).sort()
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
  files.set('SPEC.md', renderSpecDoc({ plan, waves: waves.result }))

  const generated = [...files.keys()]
  for (const [rel, body] of files) {
    const full = path.join(outDir, rel)
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    await fs.promises.writeFile(full, body, 'utf8')
  }
  // Written before `check` so a failed run can be fixed and re-run in place.
  await writeOwnership(outDir, generated)

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
    return {
      ...failure(
        'GRAPH_INVALID',
        `specgraph check rejected ${target} (exit ${checkOutput.exitCode})`,
        checkOutput.stderr.slice(-4096) || undefined,
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
  files.set('export/export.md', `${exports.map((entry) => entry.md.trimEnd()).join('\n\n---\n\n')}\n`)
  files.set(
    'export/manifest.json',
    `${JSON.stringify({ schemaVersion: 1, modules: exports.map((entry) => ({ dir: entry.dir, manifest: entry.manifest })) }, null, 2)}\n`,
  )
  files.set(CHECKLIST_REL, renderChecklistTemplate(loadChecks(), plan.name))

  for (const [rel, body] of files) {
    if (generated.includes(rel)) continue
    const full = path.join(outDir, rel)
    await fs.promises.mkdir(path.dirname(full), { recursive: true })
    await fs.promises.writeFile(full, body, 'utf8')
  }
  const all = [...files.keys()].sort()
  await writeOwnership(outDir, all)

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
  }
}
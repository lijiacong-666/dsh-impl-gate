// G3: turn a validated compose plan into per-module task cards under
// <outDir>/tasks/. Waves are reused from computeWaves() — never recomputed.
import fs from 'node:fs'
import path from 'node:path'
import { computeWaves } from './waves.js'
import { buildCardsJson, cardPathOf, renderTaskCard, renderTasksDoc } from './cards.js'
import { validatePlan } from '../compose/plan.js'
import type { Plan } from '../compose/plan.js'

export interface InitOptions {
  implRoot?: string
  overwrite?: boolean
}

export interface InitCard {
  moduleId: string
  wave: number
  cardPath: string
}

export interface InitPayload {
  ok: true
  tasksDir: string
  cards: InitCard[]
  waves: Array<{ index: number; modules: string[]; dependsOn: string[] }>
  overlaps: Array<{ a: string; b: string; files: string[] }>
  filesWritten: string[]
}

export interface InitFailure {
  ok: false
  /** Same shape as a failed compose call: {code, message, detail?}. */
  error: { code: string; message: string; detail?: string }
  filesWritten?: string[]
}

function failure(code: string, message: string): InitFailure {
  return { ok: false, error: { code, message } }
}

function relativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => {
      try {
        return fs.statSync(path.join(dir, entry)).isFile()
      } catch {
        return false
      }
    })
    .sort()
}

/** Reads compose-plan.json from outDir; missing or malformed plans never write. */
function readPlan(outDir: string): Plan | InitFailure {
  const planPath = path.join(outDir, 'compose-plan.json')
  let text: string
  try {
    text = fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return failure('PLAN_MISSING', `compose-plan.json not found in ${outDir}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return failure('PLAN_INVALID', `compose-plan.json is not valid JSON: ${(error as Error).message}`)
  }
  const validation = validatePlan(raw)
  if (validation.plan === null) {
    // The plan validator finds cycles before waves can; surface them as the
    // dedicated reason string so callers do not have to parse PLAN_INVALID.
    const cycle = validation.problems.find((problem) => problem.message.startsWith('dependency cycle:'))
    if (cycle !== undefined) return failure('PLAN_HAS_CYCLE', cycle.message)
    const first = validation.problems[0]
    return failure(
      'PLAN_INVALID',
      first === undefined ? 'compose-plan.json failed validation' : `${first.path} ${first.message}`,
    )
  }
  return validation.plan
}

export function initTasks(outDirRaw: string, options: InitOptions = {}): InitPayload | InitFailure {
  const outDir = path.resolve(outDirRaw)
  const plan = readPlan(outDir)
  if ('ok' in plan) return plan

  const outcome = computeWaves(plan)
  if (!outcome.ok) {
    // Waves only fails on a cycle. Keep the path (`A → B → A`) in the message.
    return failure('PLAN_HAS_CYCLE', outcome.message)
  }
  const { waves, overlaps } = outcome.result

  const tasksDir = path.join(outDir, 'tasks')
  const waveByModule = new Map<string, number>()
  for (const wave of waves) for (const id of wave.modules) waveByModule.set(id, wave.index)

  const cards: InitCard[] = []
  const rendered = new Map<string, string>()
  for (const module of plan.modules) {
    const waveIndex = waveByModule.get(module.id)
    if (waveIndex === undefined) return failure('PLAN_INVALID', `module ${module.id} is missing from the wave plan`)
    const wave = waves.find((entry) => entry.index === waveIndex)
    if (wave === undefined) return failure('PLAN_INVALID', `wave ${waveIndex} is missing`)
    const cardPath = cardPathOf(module, wave.index)
    cards.push({ moduleId: module.id, wave: wave.index, cardPath })
    rendered.set(cardPath, renderTaskCard(plan, module, wave, { implRoot: options.implRoot, outDir }))
  }
  cards.sort((a, b) => a.moduleId.localeCompare(b.moduleId))

  rendered.set('TASKS.md', renderTasksDoc(plan, waves, overlaps, cards))
  rendered.set('cards.json', `${JSON.stringify(buildCardsJson(plan, waves, overlaps, cards), null, 2)}\n`)

  const expected = new Set([...rendered.keys()].map((entry) => entry.split('/').join(path.sep)))
  // EVIDENCE.md is written by impl_gate_record into tasks/; it is ours, not a foreign file.
  const ours = new Set(['EVIDENCE.md'])
  const existing = listFiles(tasksDir)
  const unknown = existing.filter((entry) => !expected.has(entry) && !ours.has(entry))
  if (unknown.length > 0) {
    return failure(
      'EXPORT_REFUSED',
      `tasks/ already contains files this tool did not generate: ${unknown.map((entry) => `tasks/${entry}`).join(', ')}`,
    )
  }
  if (options.overwrite !== true) {
    const clash = [...expected].filter((entry) => fs.existsSync(path.join(tasksDir, entry))).sort()
    if (clash.length > 0) {
      return failure(
        'EXPORT_REFUSED',
        `tasks/ files already exist (pass overwrite=true to replace): ${clash.map((entry) => `tasks/${entry}`).join(', ')}`,
      )
    }
  }

  const filesWritten: string[] = []
  for (const relative of [...rendered.keys()].sort()) {
    const target = path.join(tasksDir, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, rendered.get(relative) ?? '')
    filesWritten.push(relativePosix(outDir, target))
  }

  return {
    ok: true,
    tasksDir,
    cards,
    waves,
    overlaps,
    filesWritten: filesWritten.sort(),
  }
}
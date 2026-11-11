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
import { computeWaves, type WavesOutcome, type WavesResult } from '../init/waves.js'
import { loadChecks } from '../checks.js'
import { CHECKLIST_REL, mergeChecklist, specLineFor } from './checklist-template.js'
import { MAPPING_REL, renderMappingTemplate } from './mapping-template.js'
import { initTasks } from '../init/init.js'
import { ALLOWED_RUNNERS, runnerOf } from '../record/record.js'

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
    | 'TYPE_UNUSED'
    | 'AC_HTTP_OUTSIDE_SHELL'
    | 'AC_SHELL_LATER'
    | 'STATUS_DEFAULTED'
    | 'LIST_ORDER_UNDEFINED'
    | 'LIST_PAGINATION_UNDECLARED'
    | 'PAGINATION_MODE_CONFLICT'
    | 'QUERY_PARAM_UNMAPPED'
    | 'PATCH_NULLABLE_AMBIGUOUS'
    | 'BOUNDARY_UNUSED'
    | 'WRITE_NO_VALIDATION_ERROR'
    | 'TYPE_OWNER_NO_SOURCE'
  | 'CONSTRAINT_FIELD_UNKNOWN'
    | 'IN_MEMORY_VS_TABLE'
    | 'TOOLING_UNOWNED'
    | 'AC_STATUS_CONTRADICTION'
    | 'PLAN_TEXT_MOJIBAKE'
    | 'OPEN_QUESTIONS_PENDING'
    | 'AC_TEST_UNRUNNABLE'
  | 'AC_TEST_SELECTOR_OVERLAP'
    | 'QUERY_DEFAULT_UNSTATED'
    | 'AC_FIELD_UNKNOWN'
    | 'UNIT_MISSING'
  | 'ENV_KEY_UNDECLARED'
  | 'UNIT_INCONSISTENT'
  | 'HTTP_NO_HOST'
  | 'HTTP_RES_MISMATCH'
  | 'HTTP_REQ_MISMATCH'
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
  const garbled: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (/\?{3,}|\uFFFD/.test(value)) garbled.push(`${path || '/'}: ${value.slice(0, 60)}`)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}/${index}`))
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) walk(item, `${path}/${key}`)
    }
  }
  walk(plan, '')
  if (garbled.length > 0) {
    out.push({ code: 'PLAN_TEXT_MOJIBAKE', count: garbled.length, items: garbled.slice(0, 10) })
  }
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
  // 0.4.10: numbers without a magnitude force every implementer to guess
  // ("秒还是分钟"). Only well-known magnitude words are checked, to keep it quiet.
  const magnitude = /(duration|weight|height|length|width|depth|distance|volume|amount|price|cost|dose|quantity|capacity|temperature|speed|pace|mass)/i
  // …unless the name already carries the unit (distanceM / weightKg / paceSecPerKm).
  const unitSuffix = /(?:Kg|G|Mg|Ml|L|Km|Cm|Mm|M|S|Ms|Us|Min|Sec|Hour|Day|Pct|Bps|Bytes|Kb|Mb|Gb|Usd|Cny|Cent)$/
  const unitless: string[] = []
  for (const type of plan.types ?? []) {
    for (const field of type.fields ?? []) {
      if (!/\bnumber\b/i.test(field.type)) continue
      if (!magnitude.test(field.name)) continue
      if (unitSuffix.test(field.name)) continue
      if (field.unit !== undefined && field.unit.trim().length > 0) continue
      unitless.push(`${type.name}.${field.name}`)
    }
  }
  if (unitless.length > 0) out.push({ code: 'UNIT_MISSING', count: unitless.length, items: unitless.slice(0, 10) })
  // The same numeric field name in two types must carry the same unit — one DTO saying
  // 「片」 and another saying nothing is exactly how "storage unit" and "input unit"
  // drift apart without anyone noticing.
  const unitByName = new Map<string, { unit: string; where: string }[]>()
  for (const type of plan.types ?? []) {
    for (const field of type.fields ?? []) {
      if (!/\bnumber\b/i.test(field.type)) continue
      const entry = unitByName.get(field.name) ?? []
      entry.push({ unit: field.unit ?? '', where: type.name })
      unitByName.set(field.name, entry)
    }
  }
  const inconsistent: string[] = []
  for (const [name, entries] of unitByName) {
    if (entries.length < 2) continue
    const units = new Set(entries.map((entry) => entry.unit))
    if (units.size < 2) continue
    const shown = entries.map((entry) => `${entry.where}:${entry.unit === '' ? '（无）' : entry.unit}`).join(', ')
    inconsistent.push(`${name} (${shown})`)
  }
  if (inconsistent.length > 0) {
    out.push({ code: 'UNIT_INCONSISTENT', count: inconsistent.length, items: inconsistent.slice(0, 10) })
  }
  // A runtime command that sets NAME=value is declaring an env key; if globals.envKeys
  // never lists it, whoever deploys has to guess where the value comes from.
  const declaredEnv = new Set(plan.globals?.envKeys ?? [])
  const undeclaredEnv = new Set<string>()
  const runtime = plan.runtime ?? {}
  for (const command of [runtime.start, runtime.health, runtime.migrate, runtime.rollback]) {
    if (!command) continue
    for (const match of command.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=/g)) {
      const name = match[1]
      if (!name) continue
      if (!declaredEnv.has(name)) undeclaredEnv.add(name)
    }
  }
  if (undeclaredEnv.size > 0) {
    out.push({ code: 'ENV_KEY_UNDECLARED', count: undeclaredEnv.size, items: [...undeclaredEnv].slice(0, 10) })
  }
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

  // A mutating route without an explicit status is the "was it 200 or 201?" hole:
  // the renderer defaults it, but the default is a guess, not a decision.
  const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])
  const defaulted = (plan.http ?? [])
    .filter((entry) => MUTATING.has(entry.method) && entry.status === undefined)
    .map((entry) => `${entry.method} ${entry.path}`)
  if (defaulted.length > 0) out.push({ code: 'STATUS_DEFAULTED', count: defaulted.length, items: defaulted })

  // A list response with no declared order is the "the test asserts [1,2,3] but the
  // database may return [3,1,2]" hole. Only flag when the response type looks like
  // a collection and nothing mentions ordering.
  const collection = (name: string | undefined): boolean => {
    if (name === undefined || name === 'void' || name === '') return false
    if (name.endsWith('[]')) return true
    if (/(List|Page|Collection)$/.test(name)) return true
    const declared = (plan.types ?? []).find((type) => type.name === name)
    const fields = declared?.fields ?? []
    const arrays = fields.filter((field) => field.type.includes('[]') || field.type.startsWith('Array<'))
    if (arrays.length === 0) return false
    // A payload with one array field is a list only when that field is the payload
    // itself (items/rows/...), not when it merely carries a nested collection.
    return arrays.length === fields.length || arrays.some((field) => /^(items|rows|list|results|data|entries)$/i.test(field.name))
  }
  const orderWords = (text: string): boolean =>
    /排序|升序|降序|order\s*by|sort(ed)?\s*by|orderBy|sortBy/i.test(text)
  // 排序约定常常写在“产出方”模块（例如 M7 的 weeklyAdherence 返回 AdherenceReport），
  // 而不是路由所属的壳模块，所以两边都要看。
  const hasOrderNote = (routeModule: string, res: string | undefined): boolean => {
    const name = res ?? ''
    return (plan.modules ?? []).some((module) => {
      if (!(module.constraints ?? []).some(orderWords)) return false
      if (module.id === routeModule) return true
      return (module.exposes ?? []).some((expose) => name !== '' && expose.signature.includes(`: ${name}`))
    })
  }
  const unordered = (plan.http ?? [])
    .filter((entry) => collection(entry.res))
    .filter((entry) => !(entry.query ?? []).some((param) => /^(sort|order|orderBy|sortBy)$/i.test(param.name)))
    .filter((entry) => !hasOrderNote(entry.module, entry.res))
    .map((entry) => `${entry.method} ${entry.path} → ${entry.res ?? ''}`)
  if (unordered.length > 0) out.push({ code: 'LIST_ORDER_UNDEFINED', count: unordered.length, items: unordered })

  // A response that carries pagination bookkeeping (total / hasMore / nextCursor) but
  // whose route declares no page/limit/cursor parameter: the implementer must invent
  // the contract, and "total" silently means "however many rows there are".
  const PAGE_FIELDS = /^(total|totalCount|hasMore|nextCursor|pageSize)$/i
  const PAGE_PARAMS = /^(page|pageSize|perPage|limit|offset|cursor|after|before)$/i
  const unpaginated = (plan.http ?? [])
    .filter((entry) => {
      const declared = (plan.types ?? []).find((type) => type.name === entry.res)
      if (declared === undefined || declared.kind !== 'object') return false
      const fields = declared.fields ?? []
      if (!fields.some((field) => PAGE_FIELDS.test(field.name))) return false
      return !(entry.query ?? []).some((param) => PAGE_PARAMS.test(param.name))
    })
    .map((entry) => `${entry.method} ${entry.path} returns ${entry.res ?? ''} with pagination fields but declares no page/limit/cursor query`)
  if (unpaginated.length > 0) out.push({ code: 'LIST_PAGINATION_UNDECLARED', count: unpaginated.length, items: unpaginated })

  // Declaring both offset-style and cursor-style pagination on one route means the
  // implementer has to invent precedence (what wins when both are sent?).
  const OFFSET_PARAMS = /^(page|pageSize|perPage|offset|limit)$/i
  const CURSOR_PARAMS = /^(cursor|after|before)$/i
  const mixedPaging = (plan.http ?? [])
    .filter((entry) => {
      const names = (entry.query ?? []).map((param) => param.name)
      return names.some((name) => OFFSET_PARAMS.test(name)) && names.some((name) => CURSOR_PARAMS.test(name))
    })
    .map((entry) => {
      const names = (entry.query ?? []).map((param) => param.name).join(', ')
      return `${entry.method} ${entry.path} mixes offset and cursor pagination (${names})`
    })
  if (mixedPaging.length > 0) out.push({ code: 'PAGINATION_MODE_CONFLICT', count: mixedPaging.length, items: mixedPaging })

  // A query parameter the handler's own parameter type cannot carry: the contract
  // lists `page`, the handler signature takes `MedicineQuery`, and that type has no
  // `page` field — the implementer has to invent a channel (this is exactly the bug
  // two separate review rounds caught by hand).
  const typeIndex = new Map((plan.types ?? []).map((type) => [type.name, type]))
  const paramTypes = (signature: string): string[] => {
    const open = signature.indexOf('(')
    const close = signature.lastIndexOf(')')
    if (open < 0 || close <= open) return []
    return [...signature.slice(open + 1, close).matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1] ?? '')
  }
  const unmapped: string[] = []
  for (const entry of plan.http ?? []) {
    const names = (entry.query ?? []).map((param) => param.name)
    const handler = (entry.handler ?? '').trim()
    if (names.length === 0 || handler === '') continue
    const signatures = (plan.modules ?? [])
      .flatMap((module) => (module.exposes ?? []).map((expose) => expose.signature.trim()))
      .filter((signature) => signature.startsWith(`${handler}(`))
    const carriers = [...new Set(signatures.flatMap(paramTypes))].filter((name) => typeIndex.get(name)?.kind === 'object')
    if (carriers.length === 0) continue
    const known = new Set(carriers.flatMap((name) => (typeIndex.get(name)?.fields ?? []).map((field) => field.name)))
    const missing = names.filter((name) => !known.has(name))
    if (missing.length > 0) {
      unmapped.push(`${entry.method} ${entry.path} declares ${missing.join(', ')} but ${carriers.join('/')} has no such field`)
    }
  }
  if (unmapped.length > 0) out.push({ code: 'QUERY_PARAM_UNMAPPED', count: unmapped.length, items: unmapped })

  // An optional query parameter with no `note` and no sentence in the owning
  // module's constraints (or in globals.conventions) saying what the default is:
  // the implementer has to pick 10/20/50 out of thin air.
  const defaultWords = /缺省|默认|default|上限|最多|最少|从 ?1 ?开始/
  const conventionText = (plan.globals?.conventions ?? []).join('\n')
  const unstatedDefaults: string[] = []
  for (const entry of plan.http ?? []) {
    const params = (entry.query ?? []).filter((param) => param.required !== true)
    if (params.length === 0) continue
    const owner = (plan.modules ?? []).find((module) => module.id === entry.module)
    const text = `${(owner?.constraints ?? []).join('\n')}\n${conventionText}`
    for (const param of params) {
      if (typeof param.note === 'string' && param.note.trim() !== '') continue
      const named = text
        .split(/\n/)
        .some((line) => line.includes(param.name) && defaultWords.test(line))
      if (!named) unstatedDefaults.push(`${entry.method} ${entry.path} → ${param.name} has no default stated`)
    }
  }
  if (unstatedDefaults.length > 0) out.push({ code: 'QUERY_DEFAULT_UNSTATED', count: unstatedDefaults.length, items: unstatedDefaults })

  // A PATCH request type whose every field is nullable cannot express "leave it
  // alone" versus "set it to null": the implementer has to guess.
  const patchTypes = new Set<string>()
  for (const entry of plan.http ?? []) {
    if (entry.method === 'PATCH' && entry.req !== undefined && entry.req !== '') patchTypes.add(entry.req)
  }
  const ambiguousPatch = [...patchTypes].filter((name) => {
    const declared = (plan.types ?? []).find((type) => type.name === name)
    const fields = declared?.fields ?? []
    if (fields.length === 0) return false
    return fields.every((field) => /null/.test(field.type) || field.note === '可选')
  })
  if (ambiguousPatch.length > 0) out.push({ code: 'PATCH_NULLABLE_AMBIGUOUS', count: ambiguousPatch.length, items: ambiguousPatch })

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

  // A type nobody references anywhere is either a leftover from an old design or
  // a shape the author meant to use but forgot to wire in. The corpus has to be
  // wide (handler names, query types, other types' fields) or this becomes noise:
  // `Reminder` is used as `ReminderList`'s element, not named in any signature.
  const typeCorpus = [
    ...plan.modules.flatMap((module) => [
      ...(module.exposes ?? []).map((expose) => expose.signature),
      ...(module.constraints ?? []),
      ...(module.acceptance ?? []).map((item) => item.assertion),
    ]),
    ...(plan.http ?? []).flatMap((route) => [
      route.req ?? '',
      route.res ?? '',
      route.handler ?? '',
      ...(route.query ?? []).map((param) => param.type),
    ]),
    ...(plan.types ?? []).flatMap((type) => (type.fields ?? []).map((field) => field.type)),
  ].join('\n')
  const unusedTypes = (plan.types ?? [])
    .filter((type) => type.kind !== 'external')
    .filter((type) => !new RegExp(`\\b${type.name}\\b`).test(typeCorpus))
    .map((type) => type.name)
  if (unusedTypes.length > 0) {
    out.push({ code: 'TYPE_UNUSED', count: unusedTypes.length, items: unusedTypes })
  }

  // 边界里声明的外部依赖如果全篇再没人提，读者会以为系统真的接了这个依赖，
  // 而实现者只能按 constraints 里的实际写法来（例如声明 sqlite、实现却是内存表）。
  const corpus = [
    plan.stack ?? '',
    ...(plan.goals ?? []),
    ...(plan.nonGoals ?? []),
    ...(plan.globals?.conventions ?? []),
    ...(plan.globals?.forbidden ?? []),
    ...(plan.globals?.nfr ?? []),
    ...(plan.deliverables?.files ?? []).map((file) => `${file.path} ${file.purpose}`),
    ...plan.modules.flatMap((module) => [module.title, module.responsibility ?? '', ...(module.constraints ?? []), ...(module.files ?? [])]),
  ]
    .join('\n')
    .toLowerCase()
  const RUNTIME_LIKE = /^(node(\.?js)?|deno|bun|python|java|go|rust|\.net|jdk|运行时|runtime|浏览器|browser|现代浏览器|fetch|文件系统|本地文件系统|os|stdin|stdout)$/i
  const unusedBoundary = (plan.boundaries ?? [])
    .map((boundary) => boundary.dependency)
    .filter((dependency) => typeof dependency === 'string' && dependency !== '')
    .filter((dependency) => !RUNTIME_LIKE.test(dependency.trim()) && !/浏览器|文件系统|fetch/i.test(dependency))
    // 环境类边界（本机目录、离线运行、单机部署）不是“可被引用的外部依赖”，
    // 它们只约束部署方式，出现与否都不该被当成“声明了却没实现”。
    .filter((dependency) => !/(目录|环境|离线|本机|单机|时区|本地数据|用户数据)/.test(dependency))
    .filter((dependency) => !corpus.includes(dependency.toLowerCase()))
  // eslint-disable-next-line no-control-regex
  if (unusedBoundary.length > 0) {
    out.push({ code: 'BOUNDARY_UNUSED', count: unusedBoundary.length, items: unusedBoundary })
  }

  // 写路由带请求体却没声明任何 4xx：实现者只能自己决定“参数错了回什么”。
  // 只在整份 plan 一个 400/422 都没有时才报——集中式校验（错误码归壳模块）是常见做法，
  // 那种情况下逐路由报警只会变成噪音。
  const anyValidation = (plan.errors ?? []).some((error) => error.status === 400 || error.status === 422)
  const noValidation = anyValidation
    ? []
    : (plan.http ?? [])
        .filter((entry) => ['POST', 'PATCH', 'PUT'].includes(entry.method))
        .filter((entry) => entry.req !== undefined && entry.req !== '' && entry.req !== 'void')
        .map((entry) => `${entry.method} ${entry.path} → ${entry.req ?? ''}`)
  if (noValidation.length > 0) {
    out.push({ code: 'WRITE_NO_VALIDATION_ERROR', count: noValidation.length, items: noValidation })
  }

  // 类型写了归属模块，但该模块的白名单里没有一个源码文件：实现者没有地方“定义并导出”它，
  // 只能写 JSDoc 或者干脆各写一份。
  const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|rs|cs|kt|swift|php|rb)$/i
  const noSource = (plan.types ?? [])
    .filter((type) => type.owner !== undefined && type.owner !== '')
    .filter((type) => {
      const owner = plan.modules.find((module) => module.id === type.owner)
      if (owner === undefined) return false
      const files = owner.files ?? []
      return files.length > 0 && !files.some((file) => SOURCE_FILE.test(file))
    })
    .map((type) => `${type.name} → ${type.owner}`)
  if (noSource.length > 0) {
    out.push({ code: 'TYPE_OWNER_NO_SOURCE', count: noSource.length, items: noSource })
  }

  // 约束里写 `ReminderQuery.medicineId`，但类型字段表里没有这个字段：散文与类型
  // 各说一套，实现者只能猜。这是「只改了散文、没改结构」的典型残留。
  const fieldsOf = new Map((plan.types ?? []).map((type) => [type.name, new Set((type.fields ?? []).map((f) => f.name))]))
  const unknownFields: string[] = []
  const seenField = new Set<string>()
  for (const module of plan.modules) {
    const texts = [...(module.constraints ?? []), ...(module.acceptance ?? []).map((item) => item.assertion)]
    for (const text of texts) {
      for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)\b/g)) {
        const type = match[1] ?? ''
        const field = match[2] ?? ''
        const fields = fieldsOf.get(type)
        if (fields === undefined || fields.has(field)) continue
        const line = `${module.id}: ${type}.${field}`
        if (seenField.has(line)) continue
        seenField.add(line)
        unknownFields.push(line)
      }
    }
  }
  if (unknownFields.length > 0) {
    out.push({ code: 'CONSTRAINT_FIELD_UNKNOWN', count: unknownFields.length, items: unknownFields })
  }

  // 表声明了这个模块负责写，模块自己的说明却说「内存里存着」：实现者只能二选一，
  // 而两边都是文档说的。这类矛盾评审能发现，但最好在生成时就提醒。
  const IN_MEMORY = /内存|进程内|in-?memory|new Map\(/i
  const implicit = (plan.data ?? [])
    .flatMap((table) =>
      (table.rowWriters ?? []).flatMap((writer) => {
        const module = plan.modules.find((entry) => entry.id === writer)
        if (module === undefined) return []
        const texts = [module.title, module.responsibility ?? '', ...(module.constraints ?? [])]
        return texts.some((text) => IN_MEMORY.test(text)) ? [`${table.table} ← ${writer}`] : []
      }),
    )
  if (implicit.length > 0) {
    out.push({ code: 'IN_MEMORY_VS_TABLE', count: implicit.length, items: implicit })
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

  // "returns 201" in an acceptance row while http[] declares 200 leaves the
  // implementer to pick one; the document must answer before code exists.
  // Pair a status with the route mentioned just before it — a single row often
  // covers several routes, and applying one row's status to all of them is noise.
  const contradictions: string[] = []
  const statusSeen = new Set<string>()
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const mentions: Array<{ index: number; key: string; path: string }> = []
      for (const match of item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s，,。）)]*)/g)) {
        const rawPath = match[2]
        if (rawPath === undefined || match.index === undefined) continue
        mentions.push({ index: match.index, key: `${match[1]} ${rawPath}`, path: routePath(rawPath) })
      }
      if (mentions.length === 0) continue
      for (const statusMatch of item.assertion.matchAll(/(?:返回|状态码|status)\D{0,6}([1-5][0-9]{2})/gi)) {
        if (statusMatch.index === undefined) continue
        const assertedStatus = Number(statusMatch[1])
        if (assertedStatus < 200 || assertedStatus > 299) continue
        const before = mentions.filter((mention) => mention.index <= statusMatch.index)
        const nearest = before[before.length - 1]
        if (nearest === undefined) continue
        if (statusMatch.index - nearest.index > 24) continue
        const method = nearest.key.split(' ')[0] ?? ''
        const route = routes.find((entry) => entry.method === method && entry.path === nearest.path)
        if (route === undefined) continue
        const declared = route.status ?? (route.res === 'void' ? 204 : 200)
        if (declared === assertedStatus) continue
        const line = `${module.id}: ${item.id} asserts ${assertedStatus} for ${method} ${nearest.path}; http[] declares ${declared}`
        if (statusSeen.has(line)) continue
        statusSeen.add(line)
        contradictions.push(line)
      }
    }
  }
  if (contradictions.length > 0) {
    out.push({ code: 'AC_STATUS_CONTRADICTION', count: contradictions.length, items: contradictions })
  }

  // An acceptance row that reads `body.x` on a single, unambiguous route whose
  // response type has no field `x`: the implementer writes an assertion that can
  // never pass, or silently changes the contract to match the assertion.
  const fieldHits: string[] = []
  const fieldSeen = new Set<string>()
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const keys = new Set<string>()
      for (const match of item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s，,。）)]*)/g)) {
        const rawPath = match[2]
        if (rawPath === undefined) continue
        keys.add(`${match[1]} ${routePath(rawPath)}`)
      }
      if (keys.size !== 1) continue
      const key = [...keys][0] ?? ''
      const method = key.split(' ')[0] ?? ''
      const routePathOnly = key.slice(method.length + 1)
      const route = routes.find((entry) => entry.method === method && entry.path === routePathOnly)
      if (route === undefined || route.res === undefined || route.res === '' || route.res === 'void') continue
      const declared = typeIndex.get(route.res)
      if (declared === undefined || declared.kind !== 'object') continue
      const known = new Set((declared.fields ?? []).map((field) => field.name))
      // 4xx 的响应是统一错误体，不是成功响应的类型；此时读 body.error/message/... 合法。
      const errorCase = /\bE_[A-Z0-9_]+\b|\b4[0-9]{2}\b/.test(item.assertion)
      const envelope = new Set(['error', 'message', 'code', 'details'])
      for (const read of item.assertion.matchAll(/\bbody\.([A-Za-z0-9_]+)/g)) {
        const field = read[1]
        if (field === undefined || known.has(field)) continue
        if (errorCase && envelope.has(field)) continue
        const line = `${module.id}: ${item.id} reads body.${field} but ${route.res} has no such field`
        if (fieldSeen.has(line)) continue
        fieldSeen.add(line)
        fieldHits.push(line)
      }
    }
  }
  if (fieldHits.length > 0) out.push({ code: 'AC_FIELD_UNKNOWN', count: fieldHits.length, items: fieldHits })
  // 路由被 flows 的步骤调用、或被页面的 calls 引用，也算“有人走过”：
  // 设计文档里 AC 是单元级的时候，路由本来就不会出现在 AC 里。
  const routeKey = (text: string): string => {
    const parts = text.trim().replace(/\s+/g, ' ').split(' ')
    if (parts.length < 2) return text.trim()
    return `${parts[0]?.toUpperCase() ?? ''} ${parts.slice(1).join(' ')}`
  }
  const touched = new Set<string>()
  for (const flow of plan.flows ?? []) {
    for (const step of flow.steps ?? []) {
      const route = (plan.http ?? []).find((entry) => entry.module === step.module && entry.handler === step.action)
      if (route !== undefined) touched.add(`${route.method} ${route.path}`)
    }
  }
  for (const page of plan.ui ?? []) {
    for (const call of page.calls ?? []) touched.add(routeKey(call))
  }
  // 静态资源（脚本、样式、图标）天然不会有业务 AC，也不会进 flows/pages 的 calls：
  // 它们的验收是“页面能加载”，不是逐条路由断言。
  const isStaticAsset = (routePath: string): boolean => /\.(?:js|mjs|css|html|png|svg|ico|woff2?|ttf|map)$/i.test(routePath)
  const uncovered = routes
    .filter((route) => !isStaticAsset(route.path))
    .filter((route) => !asserted.has(`${route.method} ${route.path}`))
    .filter((route) => !touched.has(`${route.method} ${route.path}`))
    .map((route) => `${route.method} ${route.path}`)
  if (uncovered.length > 0) out.push({ code: 'HTTP_ROUTE_UNCOVERED', count: uncovered.length, items: uncovered })

  // Routes without a host: if the plan declares HTTP but no module exposes a server
  // entry point (listen / buildServer / createApp), nobody owns the socket — the
  // implementer has to invent a whole layer and the port/start story stays unwritten.
  const HOST_ENTRY = /\b(listen|startServer|buildServer|createApp)\s*\(/
  const hasHost = plan.modules.some((module) =>
    (module.exposes ?? []).some((entry) => HOST_ENTRY.test(entry.signature)),
  )
  if (routes.length > 0 && !hasHost) {
    out.push({
      code: 'HTTP_NO_HOST',
      count: routes.length,
      items: routes.slice(0, 10).map((route) => `${route.method} ${route.path}`),
    })
  }

  // The declared response type and the handler's return type must agree: a route that
  // declares `WorkItem` while its handler returns `WorkItem[]` is a contract that the
  // caller's code cannot compile against.
  const simpleType = /^([A-Za-z_][A-Za-z0-9_]*)(\[\])?$/
  const resMismatch: string[] = []
  const norm = (value: string): string => value.replace(/\s+/g, '')
  for (const route of plan.http ?? []) {
    const res = (route.res ?? '').trim()
    if (res === 'void' || res === '') continue
    // A registrar (`registerXxxRoutes`) installs many routes and returns nothing; its
    // return type says nothing about any single route's response body.
    if (/^register/i.test(route.handler)) continue
    const module = plan.modules.find((entry) => entry.id === route.module)
    const expose = (module?.exposes ?? []).find((entry) => entry.signature.trim().startsWith(`${route.handler}(`))
    if (!expose) continue
    const afterParams = expose.signature.slice(expose.signature.indexOf('):') + 2).trim()
    const unwrapped = afterParams.replace(/^Promise<(.+)>$/, '$1').trim()
    if (!simpleType.test(res) || !simpleType.test(unwrapped)) continue
    const norm = (value: string): string => value.replace(/\s+/g, '')
    if (norm(res) !== norm(unwrapped)) {
      resMismatch.push(`${route.method} ${route.path} declares ${res}, handler ${route.handler} returns ${unwrapped}`)
    }
  }
  if (resMismatch.length > 0) {
    out.push({ code: 'HTTP_RES_MISMATCH', count: resMismatch.length, items: resMismatch.slice(0, 10) })
  }

  // The mirror of the above for request bodies: a route that declares `req: X` but whose
  // handler takes no parameter (or a different single parameter) cannot receive it.
  const reqMismatch: string[] = []
  for (const route of plan.http ?? []) {
    const req = (route.req ?? '').trim()
    if (req === '' || req === '（无）' || /^register/i.test(route.handler)) continue
    // Only methods with a body have a meaningful `req`; GET/DELETE declaring one is a
    // modelling mistake of its own kind (query params belong in `http[].query`).
    if (!['POST', 'PUT', 'PATCH'].includes(route.method.toUpperCase())) continue
    const module = plan.modules.find((entry) => entry.id === route.module)
    const expose = (module?.exposes ?? []).find((entry) => entry.signature.trim().startsWith(`${route.handler}(`))
    if (!expose) continue
    const inside = expose.signature.slice(expose.signature.indexOf('(') + 1, expose.signature.indexOf('):'))
    const params = inside.split(',').map((part) => part.trim()).filter(Boolean)
    if (params.length !== 1) continue
    const typeOfParam = params[0]?.slice(params[0].indexOf(':') + 1).trim() ?? ''
    if (!simpleType.test(req) || !simpleType.test(typeOfParam)) continue
    if (norm(req) !== norm(typeOfParam)) {
      reqMismatch.push(`${route.method} ${route.path} declares req ${req}, handler ${route.handler} takes ${typeOfParam}`)
    }
  }
  if (reqMismatch.length > 0) {
    out.push({ code: 'HTTP_REQ_MISMATCH', count: reqMismatch.length, items: reqMismatch.slice(0, 10) })
  }

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

  // collectWarnings also runs on partially built plans (tests, drafts), so a
  // plan that cannot be layered simply skips the wave-order warning.
  let waves: WavesOutcome | null = null
  try {
    waves = computeWaves(plan)
  } catch {
    waves = null
  }
  const shell = plan.modules.find((module) => (module.exposes ?? []).some((entry) => /\bbuildServer\s*\(/.test(entry.signature ?? '')))
  if (waves !== null && waves.ok && shell !== undefined) {
    const waveOf = (id: string): number => waves.result.waves.find((wave) => wave.modules.includes(id))?.index ?? 0
    const shellWave = waveOf(shell.id)
    const early: string[] = []
    for (const module of plan.modules) {
      if (module.id === shell.id || waveOf(module.id) === 0 || waveOf(module.id) >= shellWave) continue
      // A module that owns the routes in the assertion can mount its own app in
      // the test and stay self-contained; only cross-module HTTP calls need the
      // shell to be alive.
      const ownRoutes = new Set(
        routes.filter((route) => route.module === module.id).map((route) => `${route.method} ${route.path}`),
      )
      for (const item of module.acceptance ?? []) {
        const mentions = [...item.assertion.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s，,。）)]*)/g)].map(
          (match) => `${match[1] ?? ''} ${match[2] ?? ''}`,
        )
        if (mentions.length === 0) continue
        if (mentions.every((mention) => ownRoutes.has(mention))) continue
        early.push(`${module.id}: ${item.id} runs in wave ${waveOf(module.id)}, shell ${shell.id} is wave ${shellWave}`)
      }
    }
    if (early.length > 0) out.push({ code: 'AC_SHELL_LATER', count: early.length, items: early })
  }

  // Acceptance commands need a workspace manifest before any wave can run
  // them; if no module owns one, the first implementer has to invent it.
  const manifests = ['package.json', 'pyproject.toml', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle']
  const hasCommands = plan.modules.some((module) => (module.acceptance ?? []).some((item) => (item.test ?? '').trim() !== ''))
  const ownsManifest = plan.modules.some((module) =>
    (module.files ?? []).some((file) => manifests.includes(file.split('/').pop()?.toLowerCase() ?? '')),
  )
  if (hasCommands && !ownsManifest) {
    out.push({
      code: 'TOOLING_UNOWNED',
      count: 1,
      items: ['no module owns package.json (or another workspace manifest); acceptance commands cannot run in a clean checkout'],
    })
  }
  // Open questions are the decisions the document has not made yet. They are
  // rendered in appendix A, but nobody reads that during a wave; surface them.
  const questions = plan.openQuestions ?? []
  if (questions.length > 0) {
    out.push({
      code: 'OPEN_QUESTIONS_PENDING',
      count: questions.length,
      items: questions.map((entry, index) => `${index + 1}. ${entry.slice(0, 70)}`),
    })
  }

  // impl_gate_record only executes commands whose first word is a known runner.
  // An AC whose "test" is prose, empty, or starts with an unknown tool produces
  // no evidence at record time — and the implementer usually finds out last.
  const unrun: string[] = []
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const command = (item.test ?? '').trim()
      if (command === '') {
        unrun.push(`${module.id}: ${item.id} has no command`)
        continue
      }
      const runner = runnerOf(command)
      if (runner === null || !ALLOWED_RUNNERS.has(runner)) {
        unrun.push(`${module.id}: ${item.id} starts with "${command.split(/\s+/)[0] ?? ''}"`)
      }
    }
  }
  if (unrun.length > 0) out.push({ code: 'AC_TEST_UNRUNNABLE', count: unrun.length, items: unrun })
  // Two ACs pointing at the same test file with selectors where one is a prefix of the
  // other: `-t "reminder-home"` also runs `reminder-home-limit`, so both rows pass or
  // both fail together. We hit this ourselves on the pillbox (49 → 48 AC).
  const selectorPattern = /(?:-t|--test-name-pattern|--grep)\s+"([^"]+)"/
  const filePattern = /\brun\s+([^\s-][^\s]*)/
  const byFile = new Map<string, Array<{ id: string; selector: string }>>()
  for (const module of plan.modules) {
    for (const item of module.acceptance ?? []) {
      const command = (item.test ?? '').trim()
      const selector = selectorPattern.exec(command)?.[1]
      if (selector === undefined || selector === '') continue
      const file = filePattern.exec(command)?.[1] ?? command
      const key = file.replace(/\\/g, '/')
      const list = byFile.get(key) ?? []
      list.push({ id: `${module.id}: ${item.id}`, selector })
      byFile.set(key, list)
    }
  }
  const overlaps: string[] = []
  for (const [file, entries] of byFile) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = 0; j < entries.length; j += 1) {
        if (i === j) continue
        const a = entries[i]
        const b = entries[j]
        if (a === undefined || b === undefined) continue
        if (a.selector !== b.selector && !b.selector.startsWith(a.selector)) continue
        overlaps.push(`${a.id} selector "${a.selector}" also matches ${b.id} "${b.selector}" (${file})`)
      }
    }
  }
  if (overlaps.length > 0) {
    out.push({ code: 'AC_TEST_SELECTOR_OVERLAP', count: overlaps.length, items: overlaps.slice(0, 10) })
  }
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

  // Implementation files may already live in the project when the plan changes;
  // they are not ours to police. Only a file we are about to write must be
  // unregistered to count as a conflict (checked right before writing).

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
  const conflicts: string[] = []
  for (const rel of generated) {
    const full = path.join(outDir, rel)
    const exists = await fs.promises.stat(full).then((stat) => stat.isFile()).catch(() => false)
    if (exists && !registered.has(rel) && !isRunRecord(rel)) conflicts.push(rel)
  }
  if (conflicts.length > 0) {
    return failure(
      'EXPORT_REFUSED',
      `refusing to overwrite files impl-gate does not own: ${conflicts.sort().join(', ')}`,
      `move them away and retry; owned from the previous run: ${[...registered].sort().join(', ') || '(none)'}`,
    )
  }

  // Resolve and prove the python environment before writing anything, so a
  // missing specgraph package leaves outDir exactly as it was. The conflict
  // check above runs first so it does not depend on the interpreter.
  const environment = buildEnv(config, outDir)
  try {
    await preflightSpecgraph(environment, config.timeoutMs)
  } catch (error) {
    return fromError(error)
  }
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

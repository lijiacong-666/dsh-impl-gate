// compose-plan.json: the only place where content lives.
// This module never invents content. It defines the v1 shape, validates it,
// renders an empty-but-legal template, and computes the slots a model still
// has to fill. All problems carry a JSON Pointer so the model can fix them.

export interface PlanProblem {
  code: string
  path: string
  message: string
}

export interface PlanTypeField {
  name: string
  type: string
  note?: string
  /** 0.4.10: the magnitude a number carries ("分钟", "克"). Rendered, not inferred. */
  unit?: string
}

export interface PlanType {
  name: string
  kind: 'object' | 'enum' | 'union' | 'external'
  fields?: PlanTypeField[]
  values?: string[]
  source?: string
  note?: string
  /** Module id that owns the file this type is defined in (0.3.3). */
  owner?: string
}

export interface PlanError {
  code: string
  status: number
  when: string
  /** Response body shape; may be omitted only when `globals.errorShape` supplies it. */
  shape?: string
  /** Module id that constructs and throws this error (0.3.0: 归属). */
  by?: string
}

export interface PlanHttp {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  module: string
  handler: string
  req?: string
  /** `void` means 204 with no body. */
  res: string
  /** A real request body, as JSON text; rendered verbatim in 4.4. */
  reqExample?: string
  /** A real response body, as JSON text; rendered verbatim in 4.4. */
  resExample?: string
  /** Who may call it: public / session / admin. Absent renders as public. */
  auth?: 'public' | 'session' | 'admin'
  /** Success status code. Absent renders as 204 for `res:"void"`, otherwise 200. */
  status?: number
  /** Response headers that are part of the contract, e.g. `{ "X-Row-Count": "<int>" }`. */
  resHeaders?: Record<string, string>
  /** Explicit query parameters; `required` defaults to false. */
  query?: PlanHttpQuery[]
}

export interface PlanHttpQuery {
  name: string
  type: string
  required?: boolean
  note?: string
}

export interface PlanFlowStep {
  module: string
  /** Must name an expose of that module (first identifier of the signature). */
  action: string
  note?: string
}

export interface PlanFlow {
  id: string
  name: string
  /** What starts it: `POST /auth/login`, `cron: 0 2 * * *`, `user: 点击归档`. */
  trigger: string
  steps: PlanFlowStep[]
  /** Observable outcome when every step succeeds. */
  success: string
  /** Error codes this flow can surface, in the order they can appear. */
  failure?: string[]
}

/** One screen of the product, described at page level only. */
export interface PlanUi {
  /** P1, P2, ... */
  id: string
  title: string
  /** Path as the user sees it, e.g. /login or /ledgers/:id. */
  route: string
  /** Module that owns this page (must exist). */
  module: string
  /** What the page shows, one line per block. */
  shows: string[]
  /** HTTP routes the page calls, written as "POST /login"; must be declared in http[]. */
  calls: string[]
  /** What the page renders when there is no data or a call fails. */
  states?: { empty?: string; error?: string }
  notes?: string
}

export interface PlanRuntime {
  /** TCP port the service listens on; 0 means "pick any" (tests). */
  port?: number
  /** Command that starts the service in a clean checkout. */
  start?: string
  /** Path that returns 200 when the service is healthy. */
  health?: string
  /** Command that applies pending migrations. */
  migrate?: string
  /** What to do when a deploy must be undone. */
  rollback?: string
}

export interface Plan {
  schemaVersion: 1
  name: string
  title: string
  summary: string
  stack: string
  goals: string[]
  nonGoals: string[]
  boundaries: Array<{ dependency: string; purpose: string; version?: string; fallback: string }>
  globals: {
    conventions: string[]
    forbidden: string[]
    envKeys?: string[]
    fieldCase?: 'camel' | 'snake'
    listEnvelope?: boolean
    /** Default response body shape for every `errors[]` entry without its own. */
    errorShape?: string
    /** Non-functional requirements: rate limits, brute-force guard, latency budget, log fields. */
    nfr?: string[]
  }
  data: Array<{
    table: string
    owner: string
    /** Modules allowed to insert/update rows at runtime (owner only creates). */
    rowWriters: string[]
    columns: Array<{ name: string; type: string; constraints?: string[] }>
    indexes?: string[]
    notes?: string
  }>
  modules: Array<{
    id: string
    dir: string
    title: string
    responsibility: string
    exposes: Array<{ kind: 'http' | 'fn' | 'ui'; signature: string; note?: string }>
    requires: Array<{ module: string; item: string; why?: string }>
    constraints: string[]
    files: string[]
    acceptance: Array<{ id: string; assertion: string; test: string; covers?: string }>
    /** Pin this module to a wave; must not be earlier than its dependencies allow. */
    wave?: number
  }>
  types?: PlanType[]
  errors?: PlanError[]
  http?: PlanHttp[]
  /** How the designed system runs: port, start, health, migrate, rollback. */
  runtime?: PlanRuntime
  /** Cross-module call orders: who calls whom, in what order, on which trigger. */
  flows?: PlanFlow[]
  /** Page-level UI: what each screen shows and which declared routes it calls. */
  ui?: PlanUi[]
  openQuestions?: string[]
  deliverables: { tree: string; files: Array<{ path: string; purpose: string }> }
}

export interface PlanValidation {
  plan: Plan | null
  problems: PlanProblem[]
}

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/
const MODULE_ID_RE = /^M[0-9]{1,2}$/
const EXPOSE_KINDS = new Set(['http', 'fn', 'ui'])

const ROOT_KEYS = new Set([
  'schemaVersion',
  'name',
  'title',
  'summary',
  'stack',
  'goals',
  'nonGoals',
  'boundaries',
  'globals',
  'data',
  'modules',
  'types',
  'errors',
  'http',
  'runtime',
  'flows',
  'ui',
  'openQuestions',
  'deliverables',
])
const MODULE_KEYS = new Set([
  'id',
  'dir',
  'title',
  'responsibility',
  'exposes',
  'requires',
  'constraints',
  'files',
  'acceptance',
  'wave',
])
const EXPOSE_KEYS = new Set(['kind', 'signature', 'note'])
const REQUIRE_KEYS = new Set(['module', 'item', 'why'])
const BOUNDARY_KEYS = new Set(['dependency', 'purpose', 'version', 'fallback'])
const COLUMN_KEYS = new Set(['name', 'type', 'constraints'])
const DATA_KEYS = new Set(['table', 'owner', 'rowWriters', 'columns', 'indexes', 'notes'])
const GLOBALS_KEYS = new Set(['conventions', 'forbidden', 'envKeys', 'fieldCase', 'listEnvelope', 'errorShape', 'nfr'])
const DELIVERABLE_KEYS = new Set(['tree', 'files'])
const FILE_KEYS = new Set(['path', 'purpose'])
const ACCEPTANCE_KEYS = new Set(['id', 'assertion', 'test', 'covers'])
const TYPE_KEYS = new Set(['name', 'kind', 'fields', 'values', 'source', 'note', 'owner'])
const TYPE_FIELD_KEYS = new Set(['name', 'type', 'note', 'unit'])
const ERROR_KEYS = new Set(['code', 'status', 'when', 'shape', 'by'])
const HTTP_KEYS = new Set(['method', 'path', 'module', 'handler', 'req', 'res', 'auth', 'reqExample', 'resExample', 'status', 'resHeaders', 'query'])
const HTTP_QUERY_KEYS = new Set(['name', 'type', 'required', 'note'])
const FLOW_KEYS = new Set(['id', 'name', 'trigger', 'steps', 'success', 'failure'])
const RUNTIME_KEYS = new Set(['port', 'start', 'health', 'migrate', 'rollback'])
const FLOW_STEP_KEYS = new Set(['module', 'action', 'note'])
const AUTH_MODES = new Set(['public', 'session', 'admin'])

const TYPE_KINDS = new Set(['object', 'enum', 'union', 'external'])
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const BUILTIN_TYPES = new Set([
  'Promise',
  'Array',
  'ReadonlyArray',
  'Record',
  'Partial',
  'Pick',
  'Omit',
  'Exclude',
  'NonNullable',
  'Date',
  'Error',
  'Map',
  'Set',
  'Uint8Array',
  'Buffer',
])
const TYPE_NAME_RE = /^[A-Z][A-Za-z0-9_]*$/
const TYPE_REF_RE = /\b[A-Z][A-Za-z0-9_]*\b/g
// In a signature only a type position counts: after ":", "<", "|" or ",".
// This keeps old-style bare items such as "Db" legal (D-14) while blind-1's
// annotated types are still reported.
const TYPE_SLOT_REF_RE = /(?::|<|\||,)\s*([A-Z][A-Za-z0-9_]*)/g
const HTTP_METHOD_PREFIX = /^(?:GET|POST|PUT|PATCH|DELETE)\s+/
// A route reference in an acceptance assertion: an upper-case HTTP method,
// whitespace, then a path beginning with "/". The narrow path alphabet keeps
// prose such as "pnpm vitest run tests/x" out of this rule; a bare method with
// no path never matches.
const ROUTE_REF_RE = /\b(GET|POST|PUT|PATCH|DELETE)[ \t]+[“"「『《]?(\/[A-Za-z0-9._~:/?#%&=-]*)/g
const ROUTE_TRAILING_PUNCT = /[,.;:)）;、」』”’》】"'。]+$/u

/**
 * G7.1: acceptance prose often appends a query string, a sentence comma or a
 * closing quote to a route. Only the path is the route; keep param names
 * strict (no fuzzy matching), but normalise the obvious prose punctuation.
 */
function normalizeRouteRef(rawPath: string): string | undefined {
  const cut = rawPath.search(/[?#]/)
  const path = (cut === -1 ? rawPath : rawPath.slice(0, cut)).replace(ROUTE_TRAILING_PUNCT, '')
  if (path.length === 0 || /\s/.test(path)) return undefined
  return path
}

function declaredRouteHint(declared: Set<string>, method: string): string {
  const paths = [...declared]
    .filter((route) => route.startsWith(`${method} `))
    .map((route) => route.slice(method.length + 1))
    .sort()
  if (paths.length === 0) return ''
  const shown = paths.slice(0, 3)
  return `（已声明：${shown.join('、')}${paths.length > shown.length ? ' 等' : ''}）`
}
const ERROR_CODE_RE = /^E_[A-Z0-9_]+$/
const ERROR_REF_RE = /\bE_[A-Z0-9_]+/g
const HANDLER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/

type Json = Record<string, unknown>

/**
 * Recursively drop `_`-prefixed keys (template hints). Used by validation,
 * materialization and rendering so a hint can live at any depth — including
 * inside array elements such as `modules[0].exposes[0]._hint`.
 */
export function stripMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripMeta(entry))
  if (value === null || typeof value !== 'object') return value
  const out: Json = {}
  for (const [key, entry] of Object.entries(value as Json)) {
    if (key.startsWith('_')) continue
    out[key] = stripMeta(entry)
  }
  return out
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pointer(base: string, key: string | number): string {
  const token = String(key).replace(/~/g, '~0').replace(/\//g, '~1')
  return `${base}/${token}`
}

function problem(problems: PlanProblem[], path: string, message: string): void {
  problems.push({ code: 'PLAN_INVALID', path, message })
}

/** Unknown keys are a plan bug, but `_hint`-style keys are template annotations. */
function checkKnownKeys(value: Json, allowed: Set<string>, base: string, problems: PlanProblem[]): void {
  for (const key of Object.keys(value)) {
    if (key.startsWith('_')) continue
    if (!allowed.has(key)) {
      problem(problems, pointer(base, key), `unknown field "${key}" (plan schema v1 is fixed)`)
    }
  }
}

function readString(value: unknown, base: string, problems: PlanProblem[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    problem(problems, base, 'must be a non-empty string')
    return ''
  }
  return value
}

function readStringArray(value: unknown, base: string, problems: PlanProblem[]): string[] {
  if (!Array.isArray(value)) {
    problem(problems, base, 'must be an array of strings')
    return []
  }
  const out: string[] = []
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      problem(problems, pointer(base, index), 'must be a non-empty string')
      return
    }
    out.push(entry)
  })
  return out
}

function readNonEmptyArray(value: unknown, base: string, problems: PlanProblem[], what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    problem(problems, base, `must be a non-empty array (${what})`)
    return []
  }
  return value
}

function isUnsafeRelative(file: string): string | null {
  if (file.trim().length === 0) return 'must be a non-empty path'
  if (/^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('/') || file.startsWith('\\')) {
    return 'must be a relative path'
  }
  const segments = file.split(/[\\/]+/)
  if (segments.includes('..')) return 'must not contain ".."'
  return null
}

function validateExposes(raw: unknown, base: string, problems: PlanProblem[]): Array<{ signature: string; note?: string }> {
  const list = readNonEmptyArray(raw, base, problems, 'at least one exposed item')
  const out: Array<{ signature: string; note?: string }> = []
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    const at = pointer(base, index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, EXPOSE_KEYS, at, problems)
    const kind = entry.kind
    if (typeof kind !== 'string' || !EXPOSE_KINDS.has(kind)) {
      problem(problems, pointer(at, 'kind'), 'must be one of "http", "fn", "ui"')
    }
    const signature = readString(entry.signature, pointer(at, 'signature'), problems)
    if (entry.note !== undefined && (typeof entry.note !== 'string' || entry.note.trim().length === 0)) {
      problem(problems, pointer(at, 'note'), 'must be a non-empty string when present')
    }
    if (signature.length > 0) {
      if (seen.has(signature)) problem(problems, pointer(at, 'signature'), `duplicate signature "${signature}" in this module`)
      seen.add(signature)
    }
    out.push({ signature, note: typeof entry.note === 'string' ? entry.note : undefined })
  })
  return out
}

function validateRequires(
  raw: unknown,
  base: string,
  problems: PlanProblem[],
): Array<{ module: string; item: string }> {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problem(problems, base, 'must be an array')
    return []
  }
  const out: Array<{ module: string; item: string }> = []
  raw.forEach((entry, index) => {
    const at = pointer(base, index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, REQUIRE_KEYS, at, problems)
    const module = readString(entry.module, pointer(at, 'module'), problems)
    const item = readString(entry.item, pointer(at, 'item'), problems)
    if (entry.why !== undefined && typeof entry.why !== 'string') {
      problem(problems, pointer(at, 'why'), 'must be a string when present')
    }
    out.push({ module, item })
  })
  return out
}

function validateModules(
  raw: unknown,
  problems: PlanProblem[],
  goalsCount: number,
): Array<{ id: string; exposes: Array<{ signature: string; note?: string }>; requires: Array<{ module: string; item: string }> }> {
  const list = readNonEmptyArray(raw, '/modules', problems, 'at least one module')
  const out: Array<{
    id: string
    exposes: Array<{ signature: string; note?: string }>
    requires: Array<{ module: string; item: string }>
  }> = []
  const ids = new Set<string>()
  const dirs = new Set<string>()
  const acceptanceIds = new Map<string, string>()

  list.forEach((entry, index) => {
    const at = pointer('/modules', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, MODULE_KEYS, at, problems)
    const id = readString(entry.id, pointer(at, 'id'), problems)
    if (id.length > 0 && !MODULE_ID_RE.test(id)) problem(problems, pointer(at, 'id'), 'must match ^M[0-9]{1,2}$')
    if (id.length > 0) {
      if (ids.has(id)) problem(problems, pointer(at, 'id'), `duplicate module id "${id}"`)
      ids.add(id)
    }
    const dir = readString(entry.dir, pointer(at, 'dir'), problems)
    if (dir.length > 0) {
      const unsafe = isUnsafeRelative(dir)
      if (unsafe !== null) problem(problems, pointer(at, 'dir'), unsafe)
      if (dirs.has(dir)) problem(problems, pointer(at, 'dir'), `duplicate module dir "${dir}"`)
      dirs.add(dir)
    }
    if (entry.wave !== undefined) {
      const wave = entry.wave
      if (typeof wave !== 'number' || !Number.isInteger(wave) || wave < 1) {
        problem(problems, pointer(at, 'wave'), 'must be a positive integer (wave number) when given')
      }
    }
    readString(entry.title, pointer(at, 'title'), problems)
    readString(entry.responsibility, pointer(at, 'responsibility'), problems)
    const exposes = validateExposes(entry.exposes, pointer(at, 'exposes'), problems)
    const requires = validateRequires(entry.requires, pointer(at, 'requires'), problems)
    readNonEmptyArray(entry.constraints, pointer(at, 'constraints'), problems, 'at least one constraint')
    readStringArray(entry.constraints, pointer(at, 'constraints'), problems)
    const files = readNonEmptyArray(entry.files, pointer(at, 'files'), problems, 'at least one file')
    const seenFiles = new Set<string>()
    readStringArray(entry.files, pointer(at, 'files'), problems).forEach((file, fileIndex) => {
      const unsafe = isUnsafeRelative(file)
      if (unsafe !== null) problem(problems, pointer(pointer(at, 'files'), fileIndex), unsafe)
      if (seenFiles.has(file)) {
        problem(problems, pointer(pointer(at, 'files'), fileIndex), `duplicate file "${file}" in this module`)
      }
      seenFiles.add(file)
    })
    if (files.length === 0) {
      // readNonEmptyArray already reported the empty case.
    }

    const acceptanceList = readNonEmptyArray(entry.acceptance, pointer(at, 'acceptance'), problems, 'at least one acceptance item')
    acceptanceList.forEach((item, itemIndex) => {
      const itemAt = pointer(pointer(at, 'acceptance'), itemIndex)
      if (!isRecord(item)) {
        problem(problems, itemAt, 'must be an object')
        return
      }
      checkKnownKeys(item, ACCEPTANCE_KEYS, itemAt, problems)
      const acceptanceId = readString(item.id, pointer(itemAt, 'id'), problems)
      readString(item.assertion, pointer(itemAt, 'assertion'), problems)
      readString(item.test, pointer(itemAt, 'test'), problems)
      if (item.covers !== undefined) {
        const covers = item.covers
        const match = typeof covers === 'string' ? /^G([1-9][0-9]*)$/.exec(covers) : null
        if (match === null) {
          problem(problems, pointer(itemAt, 'covers'), 'must be G<n> with n starting at 1')
        } else if (Number(match[1]) > goalsCount) {
          problem(problems, pointer(itemAt, 'covers'), `covers "${covers}" is outside goals 1..${goalsCount || 1}`)
        }
      }
      if (acceptanceId.length > 0) {
        const previous = acceptanceIds.get(acceptanceId)
        if (previous !== undefined) {
          problem(problems, pointer(itemAt, 'id'), `duplicate acceptance id "${acceptanceId}" (already used in ${previous})`)
        } else {
          acceptanceIds.set(acceptanceId, at)
        }
      }
    })

    out.push({ id, exposes, requires })
  })

  // requires must point at an existing module, an existing exposed item, and stay acyclic.
  list.forEach((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.requires)) return
    entry.requires.forEach((need, needIndex) => {
      if (!isRecord(need)) return
      const targetId = typeof need.module === 'string' ? need.module : ''
      const item = typeof need.item === 'string' ? need.item : ''
      if (targetId.length === 0 || item.length === 0) return
      const targetIndex = list.findIndex(
        (candidate) => isRecord(candidate) && typeof candidate.id === 'string' && candidate.id === targetId,
      )
      if (targetIndex < 0) {
        problem(
          problems,
          pointer(pointer(pointer('/modules', index), 'requires'), needIndex) + '/module',
          `requires.module "${targetId}" does not exist`,
        )
        return
      }
      const target = list[targetIndex]
      const exposes = isRecord(target) && Array.isArray(target.exposes) ? target.exposes : []
      const matches = exposes.some(
        (candidate) =>
          isRecord(candidate) &&
          ((typeof candidate.signature === 'string' && candidate.signature === item) ||
            (typeof candidate.note === 'string' && candidate.note === item)),
      )
      if (!matches) {
        problem(
          problems,
          pointer(pointer(pointer('/modules', index), 'requires'), needIndex) + '/item',
          `requires.item "${item}" does not match any exposes signature/note of ${targetId}`,
        )
      }
    })
  })

  const cycle = findCycle(out)
  if (cycle !== null) {
    problem(problems, '/modules', `dependency cycle: ${cycle.join(' → ')}`)
  }
  return out
}

function findCycle(modules: Array<{ id: string; requires: Array<{ module: string }> }>): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const module of modules) {
    if (module.id.length === 0) continue
    adjacency.set(
      module.id,
      module.requires.map((need) => need.module).filter((id) => id.length > 0 && id !== module.id),
    )
  }
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (!adjacency.has(next)) continue
      const seen = state.get(next) ?? 0
      if (seen === 1) {
        const start = stack.indexOf(next)
        return [...stack.slice(start), next]
      }
      if (seen === 0) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }

  for (const id of adjacency.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id)
      if (found !== null) return found
    }
  }
  return null
}

/** Declared types; returns their names in declaration order. */
function validateTypes(raw: unknown, problems: PlanProblem[]): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problem(problems, '/types', 'must be an array')
    return []
  }
  const names: string[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = pointer('/types', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, TYPE_KEYS, at, problems)
    const name = readString(entry.name, pointer(at, 'name'), problems)
    if (name.length > 0) {
      if (!TYPE_NAME_RE.test(name)) problem(problems, pointer(at, 'name'), 'must be PascalCase (^[A-Z][A-Za-z0-9_]*$)')
      if (seen.has(name)) problem(problems, pointer(at, 'name'), `duplicate type name "${name}"`)
      seen.add(name)
      names.push(name)
    }
    const kind = entry.kind
    if (typeof kind !== 'string' || !TYPE_KINDS.has(kind)) {
      problem(problems, pointer(at, 'kind'), 'must be one of "object", "enum", "union", "external"')
      return
    }
    if (entry.note !== undefined && typeof entry.note !== 'string') {
      problem(problems, pointer(at, 'note'), 'must be a string when present')
    }
    if (entry.owner !== undefined && (typeof entry.owner !== 'string' || !/^M[0-9]+$/.test(entry.owner))) {
      problem(problems, pointer(at, 'owner'), 'must be a module id like "M1"')
    }
    if (kind === 'object') {
      if (entry.values !== undefined) problem(problems, pointer(at, 'values'), 'is only allowed for enum/union')
      if (entry.source !== undefined) problem(problems, pointer(at, 'source'), 'is only allowed for external')
      const fields = readNonEmptyArray(entry.fields, pointer(at, 'fields'), problems, 'object types need at least one field')
      fields.forEach((field, fieldIndex) => {
        const fieldAt = pointer(pointer(at, 'fields'), fieldIndex)
        if (!isRecord(field)) {
          problem(problems, fieldAt, 'must be an object')
          return
        }
        checkKnownKeys(field, TYPE_FIELD_KEYS, fieldAt, problems)
        readString(field.name, pointer(fieldAt, 'name'), problems)
        readString(field.type, pointer(fieldAt, 'type'), problems)
        if (field.note !== undefined && typeof field.note !== 'string') {
          problem(problems, pointer(fieldAt, 'note'), 'must be a string when present')
        }
        if (field.unit !== undefined) {
          if (typeof field.unit !== 'string' || field.unit.trim().length === 0) {
            problem(problems, pointer(fieldAt, 'unit'), 'must be a non-empty string when present')
          }
        }
      })
      return
    }
    if (entry.fields !== undefined) problem(problems, pointer(at, 'fields'), 'is only allowed for object')
    if (kind === 'external') {
      if (entry.values !== undefined) problem(problems, pointer(at, 'values'), 'is only allowed for enum/union')
      readString(entry.source, pointer(at, 'source'), problems)
      return
    }
    if (entry.source !== undefined) problem(problems, pointer(at, 'source'), 'is only allowed for external')
    const values = readNonEmptyArray(entry.values, pointer(at, 'values'), problems, 'enum/union need at least one value')
    readStringArray(values, pointer(at, 'values'), problems)
  })
  return names
}

/** Declared error catalog; returns the codes. `defaultShape` comes from globals.errorShape. */
function validateErrors(
  raw: unknown,
  modulesRaw: unknown,
  problems: PlanProblem[],
  defaultShape: string | undefined,
): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problem(problems, '/errors', 'must be an array')
    return []
  }
  const moduleIds = new Set(
    (Array.isArray(modulesRaw) ? modulesRaw : [])
      .map((candidate) => (isRecord(candidate) && typeof candidate.id === 'string' ? candidate.id : ''))
      .filter((id) => id.length > 0),
  )
  const codes: string[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = pointer('/errors', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, ERROR_KEYS, at, problems)
    const code = readString(entry.code, pointer(at, 'code'), problems)
    if (code.length > 0) {
      if (!ERROR_CODE_RE.test(code)) problem(problems, pointer(at, 'code'), 'must match ^E_[A-Z0-9_]+$')
      if (seen.has(code)) problem(problems, pointer(at, 'code'), `duplicate error code "${code}"`)
      seen.add(code)
      codes.push(code)
    }
    if (typeof entry.status !== 'number' || !Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599) {
      problem(problems, pointer(at, 'status'), 'must be an integer HTTP status between 100 and 599')
    }
    readString(entry.when, pointer(at, 'when'), problems)
    if (entry.shape !== undefined) {
      if (typeof entry.shape !== 'string' || entry.shape.trim().length === 0) {
        problem(problems, pointer(at, 'shape'), 'must be a non-empty string')
      }
    } else if (defaultShape === undefined) {
      // D-15: one catalog-level default may replace per-code bodies, but the
      // rendered SPEC must never contain a bare "—" in 4.3.
      problem(problems, pointer(at, 'shape'), 'must be a non-empty string')
    }
    if (entry.by !== undefined) {
      const by = readString(entry.by, pointer(at, 'by'), problems)
      if (by.length > 0) {
        if (!MODULE_ID_RE.test(by)) problem(problems, pointer(at, 'by'), 'must look like "M1"')
        else if (!moduleIds.has(by)) problem(problems, pointer(at, 'by'), `module "${by}" does not exist`)
      }
    }
  })
  return codes
}

/** HTTP surface: module/handler must exist, method+path are unique, paths start with "/". */
function validateTypeOwners(raw: unknown, modulesRaw: unknown, problems: PlanProblem[]): void {
  if (!Array.isArray(raw) || !Array.isArray(modulesRaw)) return
  const ids = new Set(
    modulesRaw.filter((entry): entry is Json => isRecord(entry) && typeof entry.id === 'string').map((entry) => String(entry.id)),
  )
  raw.forEach((entry, index) => {
    if (!isRecord(entry) || typeof entry.owner !== 'string' || entry.owner.length === 0) return
    if (!ids.has(entry.owner)) {
      problem(problems, pointer(pointer('/types', index), 'owner'), `module "${entry.owner}" does not exist`)
    }
  })
}

function validateHttp(raw: unknown, modulesRaw: unknown, typeNames: Set<string>, problems: PlanProblem[]): void {
  if (raw === undefined) return
  if (!Array.isArray(raw)) {
    problem(problems, '/http', 'must be an array')
    return
  }
  const moduleList = Array.isArray(modulesRaw) ? modulesRaw : []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = pointer('/http', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, HTTP_KEYS, at, problems)
    const method = entry.method
    if (typeof method !== 'string' || !HTTP_METHODS.has(method)) {
      problem(problems, pointer(at, 'method'), 'must be one of GET, POST, PUT, PATCH, DELETE')
    }
    const routePath = readString(entry.path, pointer(at, 'path'), problems)
    if (routePath.length > 0 && !routePath.startsWith('/')) {
      problem(problems, pointer(at, 'path'), 'must start with "/"')
    }
    const moduleId = readString(entry.module, pointer(at, 'module'), problems)
    const handler = readString(entry.handler, pointer(at, 'handler'), problems)
    if (entry.auth !== undefined) {
      if (typeof entry.auth !== 'string' || !AUTH_MODES.has(entry.auth)) {
        problem(problems, pointer(at, 'auth'), 'must be one of public, session, admin')
      }
    }
    if (moduleId.length > 0) {
      const target = moduleList.find(
        (candidate): candidate is Json => isRecord(candidate) && candidate.id === moduleId,
      )
      if (target === undefined) {
        problem(problems, pointer(at, 'module'), `module "${moduleId}" does not exist`)
      } else {
        const exposes = Array.isArray(target.exposes) ? target.exposes : []
        const httpExposes = exposes.filter((expose) => isRecord(expose) && expose.kind === 'http')
        if (httpExposes.length === 0) {
          problem(problems, pointer(at, 'module'), `module "${moduleId}" has no kind:"http" expose`)
        } else if (handler.length > 0) {
          const matches = httpExposes.some((expose) => {
            const signature = isRecord(expose) && typeof expose.signature === 'string' ? expose.signature : ''
            const leading = HANDLER_RE.exec(signature.trim())?.[0] ?? ''
            return leading === handler
          })
          if (!matches) {
            problem(
              problems,
              pointer(at, 'handler'),
              `handler "${handler}" does not match the leading identifier of any kind:"http" signature of ${moduleId}`,
            )
          }
        }
      }
    }
    if (method !== undefined && typeof method === 'string' && routePath.length > 0) {
      const key = `${method} ${routePath}`
      if (seen.has(key)) problem(problems, pointer(at, 'path'), `duplicate route "${key}"`)
      seen.add(key)
    }
    for (const field of ['req', 'res'] as const) {
      const value = entry[field]
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        problem(problems, pointer(at, field), 'must be a non-empty type name')
      } else if (typeof value === 'string' && BUILTIN_TYPES.has(value) && !typeNames.has(value)) {
        problem(problems, pointer(at, field), `${field} type "${value}" must be declared in types`)
      }
    }
    readString(entry.res, pointer(at, 'res'), problems)
    const status = entry.status
    if (status !== undefined) {
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
        problem(problems, pointer(at, 'status'), 'must be an integer between 100 and 599')
      } else if (typeof entry.res === 'string') {
        if (entry.res.trim() === 'void' && status !== 204) {
          problem(problems, pointer(at, 'status'), 'a void response must use status 204')
        } else if (entry.res.trim() !== 'void' && status === 204) {
          problem(problems, pointer(at, 'status'), 'status 204 needs res "void"')
        }
      }
    }
    if (entry.resHeaders !== undefined) {
      const headers = entry.resHeaders
      if (!isRecord(headers)) {
        problem(problems, pointer(at, 'resHeaders'), 'must be an object of header name to value')
      } else {
        for (const [name, value] of Object.entries(headers)) {
          if (name.trim().length === 0) problem(problems, pointer(at, 'resHeaders'), 'header name must not be empty')
          if (typeof value !== 'string' || value.trim().length === 0) {
            problem(problems, pointer(at, 'resHeaders'), `header "${name}" must be a non-empty string`)
          }
        }
      }
    }
    if (entry.query !== undefined) {
      const params = entry.query
      if (!Array.isArray(params)) {
        problem(problems, pointer(at, 'query'), 'must be an array of {name, type, required?}')
      } else {
        params.forEach((param, paramIndex) => {
          const paramAt = pointer(pointer(at, 'query'), paramIndex)
          if (!isRecord(param)) {
            problem(problems, paramAt, 'must be an object')
            return
          }
          checkKnownKeys(param, HTTP_QUERY_KEYS, paramAt, problems)
          const name = readString(param.name, pointer(paramAt, 'name'), problems)
          if (name.length > 0 && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            problem(problems, pointer(paramAt, 'name'), 'must be a plain identifier')
          }
          const paramType = readString(param.type, pointer(paramAt, 'type'), problems)
          if (paramType.length > 0 && /^[A-Z]/.test(paramType) && !typeNames.has(paramType)) {
            problem(problems, pointer(paramAt, 'type'), `unknown type "${paramType}"`)
          }
          if (param.required !== undefined && typeof param.required !== 'boolean') {
            problem(problems, pointer(paramAt, 'required'), 'must be a boolean')
          }
          if (param.note !== undefined && typeof param.note !== 'string') {
            problem(problems, pointer(paramAt, 'note'), 'must be a string when present')
          }
        })
      }
    }
    for (const field of ['reqExample', 'resExample'] as const) {
      const value = entry[field]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.trim().length === 0) {
        problem(problems, pointer(at, field), 'must be a non-empty JSON string')
        continue
      }
      try {
        JSON.parse(value)
      } catch {
        problem(problems, pointer(at, field), 'must be valid JSON text (quote keys and strings)')
      }
    }
  })
}

function normalizeRoute(text: string): string {
  const match = /^([A-Za-z]+)\s+(.+)$/.exec(text.trim().replace(/\s+/g, ' '))
  if (match === null) return text.trim()
  return `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`
}

function validateUi(raw: unknown, modulesRaw: unknown, httpRaw: unknown, problems: PlanProblem[]): void {
  if (raw === undefined) return
  if (!Array.isArray(raw)) {
    problems.push({ code: 'UI_PAGE_INVALID', path: '/ui', message: 'must be an array' })
    return
  }
  const modules = new Set(
    Array.isArray(modulesRaw)
      ? modulesRaw.map((entry) => (typeof entry === 'object' && entry !== null ? String((entry as { id?: unknown }).id ?? '') : ''))
      : [],
  )
  const routes = new Set<string>()
  if (Array.isArray(httpRaw)) {
    for (const entry of httpRaw) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as { method?: unknown; path?: unknown }
      routes.add(normalizeRoute(`${String(record.method ?? '')} ${String(record.path ?? '')}`))
    }
  }
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = `/ui/${index}`
    if (typeof entry !== 'object' || entry === null) {
      problems.push({ code: 'UI_PAGE_INVALID', path: at, message: 'must be an object' })
      return
    }
    const page = entry as Record<string, unknown>
    const id = typeof page.id === 'string' ? page.id.trim() : ''
    if (!/^P[0-9]{1,2}$/.test(id)) problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/id`, message: 'must look like "P1"' })
    else if (seen.has(id)) problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/id`, message: `duplicate page id "${id}"` })
    else seen.add(id)
    if (typeof page.title !== 'string' || page.title.trim() === '') {
      problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/title`, message: 'must be a non-empty string' })
    }
    const route = typeof page.route === 'string' ? page.route.trim() : ''
    if (!route.startsWith('/')) problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/route`, message: 'must start with "/"' })
    const owner = typeof page.module === 'string' ? page.module.trim() : ''
    if (!modules.has(owner)) problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/module`, message: `module "${owner}" does not exist` })
    if (!Array.isArray(page.shows) || page.shows.length === 0) {
      problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/shows`, message: 'must be a non-empty array of strings' })
    }
    if (!Array.isArray(page.calls)) {
      problems.push({ code: 'UI_PAGE_INVALID', path: `${at}/calls`, message: 'must be an array (use [] for a page with no backend call)' })
    } else {
      page.calls.forEach((call, callIndex) => {
        const text = typeof call === 'string' ? call.trim().replace(/\s+/g, ' ') : ''
        if (!routes.has(normalizeRoute(text))) {
          problems.push({
            code: 'UI_PAGE_INVALID',
            path: `${at}/calls/${callIndex}`,
            message: `page calls undeclared route "${String(call)}"; declare it in http[] first`,
          })
        }
      })
    }
  })
}

function validateFlows(raw: unknown, modulesRaw: unknown, errorCodes: Set<string>, problems: PlanProblem[]): void {
  if (raw === undefined) return
  if (!Array.isArray(raw)) {
    problem(problems, '/flows', 'must be an array when present')
    return
  }
  const modules = Array.isArray(modulesRaw) ? modulesRaw : []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    const at = pointer('/flows', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, FLOW_KEYS, at, problems)
    const id = readString(entry.id, pointer(at, 'id'), problems)
    if (id.length > 0) {
      if (!/^F[0-9]{1,2}$/.test(id)) problem(problems, pointer(at, 'id'), 'must match ^F[0-9]{1,2}$')
      if (seen.has(id)) problem(problems, pointer(at, 'id'), `duplicate flow id "${id}"`)
      seen.add(id)
    }
    readString(entry.name, pointer(at, 'name'), problems)
    readString(entry.trigger, pointer(at, 'trigger'), problems)
    readString(entry.success, pointer(at, 'success'), problems)
    const steps = readNonEmptyArray(entry.steps, pointer(at, 'steps'), problems, 'at least one step')
    steps.forEach((step, stepIndex) => {
      const stepAt = `${pointer(at, 'steps')}/${stepIndex}`
      if (!isRecord(step)) {
        problem(problems, stepAt, 'must be an object')
        return
      }
      checkKnownKeys(step, FLOW_STEP_KEYS, stepAt, problems)
      const moduleId = readString(step.module, `${stepAt}/module`, problems)
      const action = readString(step.action, `${stepAt}/action`, problems)
      if (moduleId.length === 0) return
      const target = modules.find((candidate): candidate is Json => isRecord(candidate) && candidate.id === moduleId)
      if (target === undefined) {
        problem(problems, `${stepAt}/module`, `module "${moduleId}" does not exist`)
        return
      }
      if (action.length === 0) return
      const exposes = Array.isArray(target.exposes) ? target.exposes : []
      const matches = exposes.some((expose) => {
        const signature = isRecord(expose) && typeof expose.signature === 'string' ? expose.signature : ''
        return (HANDLER_RE.exec(signature.trim())?.[0] ?? '') === action
      })
      if (!matches) {
        problem(
          problems,
          `${stepAt}/action`,
          `action "${action}" does not match the leading identifier of any signature of ${moduleId}`,
        )
      }
    })
    if (entry.failure !== undefined) {
      const codes = readStringArray(entry.failure, `${at}/failure`, problems)
      codes.forEach((code, codeIndex) => {
        if (!errorCodes.has(code)) {
          problem(problems, `${at}/failure/${codeIndex}`, `error code "${code}" is not declared in errors`)
        }
      })
    }
  })
}

/**
 * Rule 1: every capitalised identifier in a signature, an http req/res or a
 * type field must be a declared type or a built-in. Reports every unknown
 * reference once, in first-appearance order.
 */
function validateTypeClosure(raw: Json, typeNames: Set<string>, problems: PlanProblem[]): void {
  const refs: Array<{ text: string; path: string; mode: 'signature' | 'plain' }> = []
  const modules = Array.isArray(raw.modules) ? raw.modules : []
  modules.forEach((module, moduleIndex) => {
    if (!isRecord(module) || !Array.isArray(module.exposes)) return
    module.exposes.forEach((expose, exposeIndex) => {
      if (!isRecord(expose) || typeof expose.signature !== 'string') return
      refs.push({
        text: expose.signature.replace(HTTP_METHOD_PREFIX, ''),
        path: `${pointer(pointer('/modules', moduleIndex), 'exposes')}/${exposeIndex}/signature`,
        mode: 'signature',
      })
    })
  })
  const http = Array.isArray(raw.http) ? raw.http : []
  http.forEach((entry, index) => {
    if (!isRecord(entry)) return
    for (const field of ['req', 'res'] as const) {
      if (typeof entry[field] === 'string') {
        refs.push({ text: entry[field] as string, path: `${pointer('/http', index)}/${field}`, mode: 'plain' })
      }
    }
  })
  const types = Array.isArray(raw.types) ? raw.types : []
  types.forEach((type, typeIndex) => {
    if (!isRecord(type) || !Array.isArray(type.fields)) return
    type.fields.forEach((field, fieldIndex) => {
      if (!isRecord(field) || typeof field.type !== 'string') return
      refs.push({
        text: field.type,
        path: `${pointer(pointer('/types', typeIndex), 'fields')}/${fieldIndex}/type`,
        mode: 'plain',
      })
    })
  })

  const reported = new Set<string>()
  for (const ref of refs) {
    const pattern = ref.mode === 'signature' ? TYPE_SLOT_REF_RE : TYPE_REF_RE
    // Generic parameters are declared by the signature itself: `runInTransaction<T>(…)`
    // must not be reported as an undefined type named "T" (D-24).
    const declared = new Set<string>()
    if (ref.mode === 'signature') {
      for (const generic of ref.text.matchAll(/<\s*([A-Z][0-9]?(?:\s*,\s*[A-Z][0-9]?)*)\s*>/g)) {
        const captured = generic[1]
        if (captured === undefined) continue
        for (const name of captured.split(',')) declared.add(name.trim())
      }
    }
    for (const match of ref.text.matchAll(pattern)) {
      const name = ref.mode === 'signature' ? match[1] : match[0]
      if (name === undefined) continue
      if (declared.has(name)) continue
      if (typeNames.has(name) || BUILTIN_TYPES.has(name) || reported.has(name)) continue
      reported.add(name)
      problem(problems, ref.path, `undefined type reference "${name}" at ${ref.path}`)
    }
  }
}

/** Rule 2: E_ codes mentioned by constraints or acceptance assertions must be declared. */
function validateErrorRefs(modulesRaw: unknown, errorCodes: Set<string>, problems: PlanProblem[]): void {
  const modules = Array.isArray(modulesRaw) ? modulesRaw : []
  modules.forEach((module, moduleIndex) => {
    if (!isRecord(module)) return
    const at = pointer('/modules', moduleIndex)
    if (Array.isArray(module.constraints)) {
      module.constraints.forEach((constraint, index) => {
        if (typeof constraint !== 'string') return
        for (const match of constraint.matchAll(ERROR_REF_RE)) {
          if (!errorCodes.has(match[0])) {
            const path = `${pointer(at, 'constraints')}/${index}`
            problem(problems, path, `undefined error code "${match[0]}" at ${path}`)
          }
        }
      })
    }
    if (Array.isArray(module.acceptance)) {
      module.acceptance.forEach((item, index) => {
        if (!isRecord(item) || typeof item.assertion !== 'string') return
        for (const match of item.assertion.matchAll(ERROR_REF_RE)) {
          if (!errorCodes.has(match[0])) {
            const path = `${pointer(pointer(at, 'acceptance'), index)}/assertion`
            problem(problems, path, `undefined error code "${match[0]}" at ${path}`)
          }
        }
      })
    }
  })
}

/** Rule 4: every table has exactly one existing owner module. */
function validateTableOwners(dataRaw: unknown, modulesRaw: unknown, problems: PlanProblem[]): void {
  const moduleIds = moduleIdsOf(modulesRaw)
  const data = Array.isArray(dataRaw) ? dataRaw : []
  data.forEach((entry, index) => {
    if (!isRecord(entry)) return
    const at = pointer('/data', index)
    const owner = readString(entry.owner, pointer(at, 'owner'), problems)
    if (owner.length > 0 && !moduleIds.has(owner)) {
      problem(problems, pointer(at, 'owner'), `owner "${owner}" is not a module id`)
    }
  })
}

/**
 * Rule 6 (0.3.0): a table is only creatable if its owner carries a migration
 * file. compose.md promised this since 0.1 but nothing checked it: blind runs
 * produced owners whose whitelist was pure TypeScript, so the table could
 * never exist and every downstream query was empty.
 */
function validateMigrationFiles(dataRaw: unknown, modulesRaw: unknown, problems: PlanProblem[]): void {
  const filesById = new Map<string, string[]>()
  if (Array.isArray(modulesRaw)) {
    for (const module of modulesRaw) {
      if (!isRecord(module) || typeof module.id !== 'string' || module.id.length === 0) continue
      const files = Array.isArray(module.files)
        ? module.files.filter((file): file is string => typeof file === 'string')
        : []
      filesById.set(module.id, files)
    }
  }
  const data = Array.isArray(dataRaw) ? dataRaw : []
  data.forEach((entry, index) => {
    if (!isRecord(entry)) return
    const owner = typeof entry.owner === 'string' ? entry.owner : ''
    if (owner.length === 0 || !filesById.has(owner)) return
    const files = filesById.get(owner) ?? []
    const hasMigration = files.some((file) => /(^|\/)migrations?\/[^/]+\.sql$/i.test(file))
    if (hasMigration) return
    const table = typeof entry.table === 'string' ? entry.table : ''
    const at = pointer(pointer('/data', index), 'owner')
    problem(
      problems,
      at,
      `owner module "${owner}" of table "${table}" has no migration file; add a "migrations/*.sql" path to its files`,
    )
  })
}

function moduleIdsOf(modulesRaw: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(modulesRaw)) return ids
  for (const module of modulesRaw) {
    if (isRecord(module) && typeof module.id === 'string' && module.id.length > 0) ids.add(module.id)
  }
  return ids
}

/**
 * Rule 5: a table is not usable just because someone can CREATE it. Every
 * table needs at least one module that inserts/updates rows at runtime, and
 * every name in rowWriters must be a declared module id.
 */
function validateRowWriters(dataRaw: unknown, modulesRaw: unknown, problems: PlanProblem[]): void {
  const moduleIds = moduleIdsOf(modulesRaw)
  const data = Array.isArray(dataRaw) ? dataRaw : []
  data.forEach((entry, index) => {
    if (!isRecord(entry)) return
    const at = pointer('/data', index)
    const table = typeof entry.table === 'string' ? entry.table : ''
    const writers = entry.rowWriters
    if (!Array.isArray(writers) || writers.length === 0) {
      problem(problems, pointer(at, 'rowWriters'), 'must list at least one module id')
      return
    }
    writers.forEach((writer, writerIndex) => {
      const writerAt = pointer(pointer(at, 'rowWriters'), writerIndex)
      if (typeof writer !== 'string' || writer.trim().length === 0) {
        problem(problems, writerAt, 'must be a non-empty module id')
        return
      }
      if (!moduleIds.has(writer)) {
        problem(problems, writerAt, `unknown module "${writer}" in rowWriters of table "${table}" at ${writerAt}`)
      }
    })
  })
}

/**
 * Rule 5b (G8): a NOT NULL column without a default must be writable. The
 * blind runs produced `bookings.employee_id not null` while the write
 * signature was `createBooking(input: BookingInput)` and `BookingInput` had no
 * `employeeId`: structurally closed, unimplementable.
 *
 * The lookup is deliberately heuristic (D-16): snake_case → camelCase, then a
 * same-named field in an object-typed parameter of a writer signature, or a
 * same-named parameter itself. Nested input types are not expanded, and
 * Omit/Partial wrappers stay strict instead of exempting the column.
 */
const NOT_NULL_EXEMPT_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at'])

interface SignatureParam {
  name: string
  type: string
}

function toCamelCase(name: string): string {
  return name.replace(/_+([A-Za-z0-9])/g, (_match: string, char: string) => char.toUpperCase())
}

/** Parameter list without the outermost parentheses; undefined when not function-shaped (D-14). */
function parameterListOf(signature: string): string | undefined {
  const open = signature.indexOf('(')
  if (open < 0) return undefined
  let depth = 0
  for (let index = open; index < signature.length; index += 1) {
    const char = signature[index]
    if (char === '(') depth += 1
    else if (char === ')') {
      depth -= 1
      if (depth === 0) return signature.slice(open + 1, index)
    }
  }
  return undefined
}

/** Split at top-level commas so `Record<string, string>` stays one parameter. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of input) {
    if (char === '<' || char === '(' || char === '[' || char === '{') depth += 1
    else if (char === '>' || char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current.length > 0) parts.push(current)
  return parts
}

function parseSignatureParams(signature: string): SignatureParam[] {
  const body = parameterListOf(signature.replace(HTTP_METHOD_PREFIX, '').trim())
  if (body === undefined) return []
  const params: SignatureParam[] = []
  for (const chunk of splitTopLevel(body)) {
    const text = chunk.trim()
    if (text.length === 0) continue
    const colon = text.indexOf(':')
    const name = (colon === -1 ? text : text.slice(0, colon)).replace(/[?\s]+$/u, '').trim()
    if (name.length === 0) continue
    params.push({ name, type: colon === -1 ? '' : text.slice(colon + 1).trim() })
  }
  return params
}

/**
 * G9: bulk writers carry rows as `rows: BookingRow[]`, and nullable inputs as
 * `BookingRow | null`. Normalize both to the bare type name so its fields
 * expand. Multi-level arrays (`Name[][]`) and unions of several objects stay
 * unexpanded on purpose (D-16: heuristic, may under-report, never fabricates).
 */
function elementTypeName(type: string): string {
  let text = type.trim()
  const parts = text.split('|').map((part) => part.trim())
  if (parts.length === 2) {
    const nonNull = parts.filter((part) => part !== 'null' && part !== 'undefined')
    const only = nonNull.length === 1 ? nonNull[0] : undefined
    if (only !== undefined) text = only
  }
  const generic = /^Array<(.+)>$/u.exec(text)
  if (generic !== null && generic[1] !== undefined) {
    const inner = generic[1].trim()
    if (inner.endsWith('[]')) return inner
    text = inner
  }
  if (!text.endsWith('[]')) return text
  return text.slice(0, -2).trim()
}

function objectTypeFields(typesRaw: unknown): Map<string, Set<string>> {
  const fields = new Map<string, Set<string>>()
  if (!Array.isArray(typesRaw)) return fields
  for (const type of typesRaw) {
    if (!isRecord(type) || typeof type.name !== 'string' || type.kind !== 'object') continue
    const names = new Set<string>()
    if (Array.isArray(type.fields)) {
      for (const field of type.fields) {
        if (isRecord(field) && typeof field.name === 'string' && field.name.length > 0) names.add(field.name)
      }
    }
    fields.set(type.name, names)
  }
  return fields
}

/** Every field name a set of writer modules can accept as input. */
function writeFieldNames(
  modules: unknown[],
  writerIds: string[],
  objectFields: Map<string, Set<string>>,
): Set<string> {
  const names = new Set<string>()
  const writers = new Set(writerIds)
  for (const module of modules) {
    if (!isRecord(module) || typeof module.id !== 'string' || !writers.has(module.id)) continue
    const exposes = Array.isArray(module.exposes) ? module.exposes : []
    for (const expose of exposes) {
      if (!isRecord(expose) || typeof expose.signature !== 'string') continue
      for (const param of parseSignatureParams(expose.signature)) {
        names.add(param.name)
        const declared = objectFields.get(elementTypeName(param.type))
        if (declared !== undefined) for (const field of declared) names.add(field)
      }
    }
  }
  return names
}

function validateNotNullColumns(
  dataRaw: unknown,
  modulesRaw: unknown,
  typesRaw: unknown,
  problems: PlanProblem[],
): void {
  const data = Array.isArray(dataRaw) ? dataRaw : []
  const modules = Array.isArray(modulesRaw) ? modulesRaw : []
  const objectFields = objectTypeFields(typesRaw)
  data.forEach((entry, dataIndex) => {
    if (!isRecord(entry)) return
    const at = pointer('/data', dataIndex)
    const writers = Array.isArray(entry.rowWriters)
      ? entry.rowWriters.filter(
          (writer): writer is string => typeof writer === 'string' && writer.trim().length > 0,
        )
      : []
    const writeFields = writeFieldNames(modules, writers, objectFields)
    const columns = Array.isArray(entry.columns) ? entry.columns : []
    columns.forEach((column, columnIndex) => {
      if (!isRecord(column) || typeof column.name !== 'string') return
      const name = column.name
      if (name.length === 0 || NOT_NULL_EXEMPT_COLUMNS.has(name.toLowerCase())) return
      const constraints = Array.isArray(column.constraints)
        ? column.constraints.filter((constraint): constraint is string => typeof constraint === 'string')
        : []
      const text = constraints.join(' ').toLowerCase()
      if (!text.includes('not null') || text.includes('default')) return
      const field = toCamelCase(name)
      if (writeFields.has(field)) return
      const writerList = writers.length > 0 ? writers.join(', ') : 'none'
      problem(
        problems,
        pointer(pointer(at, 'columns'), columnIndex),
        `not-null column "${name}" has no input field "${field}" in write signatures of rowWriters (${writerList})`,
      )
    })
  })
}

/**
 * Rule 6: an acceptance assertion may name a route only after `http` declares
 * it. Matching is method + path, exact; prose like "pnpm vitest run" has no
 * leading "/" and is ignored.
 */
function validateAcceptanceRoutes(modulesRaw: unknown, httpRaw: unknown, problems: PlanProblem[]): void {
  const declared = new Set<string>()
  if (Array.isArray(httpRaw)) {
    for (const route of httpRaw) {
      if (!isRecord(route)) continue
      if (typeof route.method === 'string' && typeof route.path === 'string') {
        declared.add(`${route.method} ${route.path}`)
      }
    }
  }
  const modules = Array.isArray(modulesRaw) ? modulesRaw : []
  modules.forEach((module, moduleIndex) => {
    if (!isRecord(module) || !Array.isArray(module.acceptance)) return
    const at = pointer(pointer('/modules', moduleIndex), 'acceptance')
    module.acceptance.forEach((item, itemIndex) => {
      if (!isRecord(item) || typeof item.assertion !== 'string') return
      const itemAt = pointer(at, itemIndex)
      const reported = new Set<string>()
      for (const match of item.assertion.matchAll(ROUTE_REF_RE)) {
        const method = match[1]
        const rawPath = match[2]
        if (method === undefined || rawPath === undefined) continue
        const path = normalizeRouteRef(rawPath)
        if (path === undefined) continue
        const route = `${method} ${path}`
        if (declared.has(route) || reported.has(route)) continue
        reported.add(route)
        problem(
          problems,
          pointer(itemAt, 'assertion'),
          `acceptance references undeclared route "${route}" at ${itemAt}${declaredRouteHint(declared, method)}`,
        )
      }
    })
  })
}

export function validatePlan(rawInput: unknown): PlanValidation {
  const problems: PlanProblem[] = []
  const raw = stripMeta(rawInput)
  if (!isRecord(raw)) {
    return { plan: null, problems: [{ code: 'PLAN_INVALID', path: '', message: 'plan must be a JSON object' }] }
  }
  checkKnownKeys(raw, ROOT_KEYS, '', problems)

  if (raw.schemaVersion !== 1) problem(problems, '/schemaVersion', 'must be 1')
  const name = readString(raw.name, '/name', problems)
  if (name.length > 0 && !NAME_RE.test(name)) {
    problem(problems, '/name', 'must match ^[a-z][a-z0-9-]{1,40}$ (used as the output directory name)')
  }
  readString(raw.title, '/title', problems)
  readString(raw.summary, '/summary', problems)
  readString(raw.stack, '/stack', problems)

  const goals = readStringArray(readNonEmptyArray(raw.goals, '/goals', problems, 'at least one goal'), '/goals', problems)
  const nonGoals = readStringArray(
    readNonEmptyArray(raw.nonGoals, '/nonGoals', problems, 'at least one non-goal'),
    '/nonGoals',
    problems,
  )

  const boundaryList = readNonEmptyArray(raw.boundaries, '/boundaries', problems, 'at least one boundary')
  boundaryList.forEach((entry, index) => {
    const at = pointer('/boundaries', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, BOUNDARY_KEYS, at, problems)
    readString(entry.dependency, pointer(at, 'dependency'), problems)
    readString(entry.purpose, pointer(at, 'purpose'), problems)
    readString(entry.fallback, pointer(at, 'fallback'), problems)
    if (entry.version !== undefined && typeof entry.version !== 'string') {
      problem(problems, pointer(at, 'version'), 'must be a string when present')
    }
  })

  if (raw.runtime !== undefined) {
    if (!isRecord(raw.runtime)) {
      problem(problems, '/runtime', 'must be an object when present')
    } else {
      checkKnownKeys(raw.runtime, RUNTIME_KEYS, '/runtime', problems)
      const port = raw.runtime.port
      if (port !== undefined) {
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
          problem(problems, '/runtime/port', 'must be an integer between 0 and 65535')
        }
      }
      for (const field of ['start', 'health', 'migrate', 'rollback'] as const) {
        const value = raw.runtime[field]
        if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
          problem(problems, pointer('/runtime', field), 'must be a non-empty string when present')
        }
      }
    }
  }

  let defaultErrorShape: string | undefined
  if (!isRecord(raw.globals)) {
    problem(problems, '/globals', 'must be an object')
  } else {
    checkKnownKeys(raw.globals, GLOBALS_KEYS, '/globals', problems)
    readStringArray(raw.globals.conventions, '/globals/conventions', problems)
    readStringArray(raw.globals.forbidden, '/globals/forbidden', problems)
    if (raw.globals.nfr !== undefined) readStringArray(raw.globals.nfr, '/globals/nfr', problems)
    if (raw.globals.envKeys !== undefined) readStringArray(raw.globals.envKeys, '/globals/envKeys', problems)
    if (raw.globals.fieldCase !== undefined && raw.globals.fieldCase !== 'camel' && raw.globals.fieldCase !== 'snake') {
      problem(problems, '/globals/fieldCase', 'must be "camel" or "snake"')
    }
    if (raw.globals.listEnvelope !== undefined && typeof raw.globals.listEnvelope !== 'boolean') {
      problem(problems, '/globals/listEnvelope', 'must be a boolean')
    }
    if (raw.globals.errorShape !== undefined) {
      if (typeof raw.globals.errorShape !== 'string' || raw.globals.errorShape.trim().length === 0) {
        problem(problems, '/globals/errorShape', 'must be a non-empty string when present')
      } else {
        defaultErrorShape = raw.globals.errorShape
      }
    }
  }

  const dataList = readNonEmptyArray(raw.data, '/data', problems, 'at least one table')
  const tables = new Set<string>()
  dataList.forEach((entry, index) => {
    const at = pointer('/data', index)
    if (!isRecord(entry)) {
      problem(problems, at, 'must be an object')
      return
    }
    checkKnownKeys(entry, DATA_KEYS, at, problems)
    const table = readString(entry.table, pointer(at, 'table'), problems)
    if (table.length > 0) {
      if (tables.has(table)) problem(problems, pointer(at, 'table'), `duplicate table "${table}"`)
      tables.add(table)
    }
    const columns = readNonEmptyArray(entry.columns, pointer(at, 'columns'), problems, 'at least one column')
    columns.forEach((column, columnIndex) => {
      const columnAt = pointer(pointer(at, 'columns'), columnIndex)
      if (!isRecord(column)) {
        problem(problems, columnAt, 'must be an object')
        return
      }
      checkKnownKeys(column, COLUMN_KEYS, columnAt, problems)
      readString(column.name, pointer(columnAt, 'name'), problems)
      readString(column.type, pointer(columnAt, 'type'), problems)
      if (column.constraints !== undefined) readStringArray(column.constraints, pointer(columnAt, 'constraints'), problems)
    })
    if (entry.indexes !== undefined) readStringArray(entry.indexes, pointer(at, 'indexes'), problems)
    if (entry.notes !== undefined && typeof entry.notes !== 'string') {
      problem(problems, pointer(at, 'notes'), 'must be a string when present')
    }
  })

  validateModules(raw.modules, problems, goals.length)

  const typeNames = validateTypes(raw.types, problems)
  const errorCodes = validateErrors(raw.errors, raw.modules, problems, defaultErrorShape)
  validateTableOwners(raw.data, raw.modules, problems)
  validateRowWriters(raw.data, raw.modules, problems)
  validateMigrationFiles(raw.data, raw.modules, problems)
  validateNotNullColumns(raw.data, raw.modules, raw.types, problems)
  validateHttp(raw.http, raw.modules, new Set(typeNames), problems)
  validateTypeOwners(raw.types, raw.modules, problems)
  validateFlows(raw.flows, raw.modules, new Set(errorCodes), problems)
  validateUi(raw.ui, raw.modules, raw.http, problems)
  validateAcceptanceRoutes(raw.modules, raw.http, problems)
  validateTypeClosure(raw, new Set(typeNames), problems)
  validateErrorRefs(raw.modules, new Set(errorCodes), problems)
  if (raw.openQuestions !== undefined) readStringArray(raw.openQuestions, '/openQuestions', problems)

  if (!isRecord(raw.deliverables)) {
    problem(problems, '/deliverables', 'must be an object')
  } else {
    checkKnownKeys(raw.deliverables, DELIVERABLE_KEYS, '/deliverables', problems)
    readString(raw.deliverables.tree, '/deliverables/tree', problems)
    const files = readNonEmptyArray(raw.deliverables.files, '/deliverables/files', problems, 'at least one deliverable file')
    const seen = new Set<string>()
    files.forEach((entry, index) => {
      const at = pointer('/deliverables/files', index)
      if (!isRecord(entry)) {
        problem(problems, at, 'must be an object')
        return
      }
      checkKnownKeys(entry, FILE_KEYS, at, problems)
      const filePath = readString(entry.path, pointer(at, 'path'), problems)
      readString(entry.purpose, pointer(at, 'purpose'), problems)
      if (filePath.length > 0) {
        const unsafe = isUnsafeRelative(filePath)
        if (unsafe !== null) problem(problems, pointer(at, 'path'), unsafe)
        if (seen.has(filePath)) problem(problems, pointer(at, 'path'), `duplicate deliverable path "${filePath}"`)
        seen.add(filePath)
      }
    })
  }

  if (goals.length === 0 && raw.goals !== undefined) {
    // readNonEmptyArray/readStringArray already reported the precise cause.
  }
  return { plan: problems.length === 0 ? (raw as unknown as Plan) : null, problems }
}

/** Empty-but-legal scaffold written by `mode: "plan"`; `_hint` keys are ignored later. */
export function emptyPlan(input: { name?: string; stack?: string }): Json {
  const name = input.name !== undefined && NAME_RE.test(input.name) ? input.name : 'my-app'
  return {
    schemaVersion: 1,
    _hint: '由 impl_gate_compose 生成的空槽模板。补全 modules/data/boundaries/deliverables 后调用 mode:"materialize"。',
    name,
    title: '',
    summary: '',
    stack: input.stack ?? '',
    goals: [],
    nonGoals: [],
    boundaries: [],
    globals: { conventions: [], forbidden: [], envKeys: [], fieldCase: 'camel', listEnvelope: false },
    data: [],
    types: [],
    errors: [],
    http: [],
    openQuestions: [],
    modules: [
      {
        id: 'M1',
        dir: '',
        title: '',
        responsibility: '',
        exposes: [],
        requires: [],
        constraints: [],
        files: [],
        acceptance: [],
        _hint: '至少保留一个模块；id 形如 M1，dir 是 outDir/<name>/ 下的相对目录。',
      },
    ],
    deliverables: { tree: '', files: [] },
  }
}

/**
 * Slots the model still has to fill, in two levels:
 *   "plan: title, summary, stack, goals, data, deliverables"
 *   "M1: dir, responsibility, exposes, constraints, files, acceptance"
 * `nonGoals` and `boundaries` are optional in v1 and therefore never reported.
 */
export function missingSlots(rawInput: unknown): string[] {
  const raw = stripMeta(rawInput)
  const out: string[] = []
  const rec = isRecord(raw) ? raw : {}

  const planMissing: string[] = []
  if (typeof rec.title !== 'string' || rec.title.trim().length === 0) planMissing.push('title')
  if (typeof rec.summary !== 'string' || rec.summary.trim().length === 0) planMissing.push('summary')
  if (typeof rec.stack !== 'string' || rec.stack.trim().length === 0) planMissing.push('stack')
  if (!Array.isArray(rec.goals) || rec.goals.length === 0) planMissing.push('goals')
  if (!Array.isArray(rec.data) || rec.data.length === 0) planMissing.push('data')
  const deliverables = isRecord(rec.deliverables) ? rec.deliverables : {}
  const tree = typeof deliverables.tree === 'string' ? deliverables.tree.trim() : ''
  const files = Array.isArray(deliverables.files) ? deliverables.files : []
  if (tree.length === 0 || files.length === 0) planMissing.push('deliverables')
  if (planMissing.length > 0) out.push(`plan: ${planMissing.join(', ')}`)

  const modules = Array.isArray(rec.modules) ? rec.modules : []
  if (modules.length === 0) {
    out.push('plan: modules（至少 1 个）')
    return out
  }
  modules.forEach((module, index) => {
    const id = isRecord(module) && typeof module.id === 'string' && module.id.length > 0 ? module.id : `#${index}`
    const missing: string[] = []
    if (!isRecord(module)) {
      out.push(`${id}: dir, responsibility, exposes, constraints, files, acceptance`)
      return
    }
    if (typeof module.dir !== 'string' || module.dir.length === 0) missing.push('dir')
    if (typeof module.responsibility !== 'string' || module.responsibility.length === 0) missing.push('responsibility')
    if (!Array.isArray(module.exposes) || module.exposes.length === 0) missing.push('exposes')
    if (!Array.isArray(module.constraints) || module.constraints.length === 0) missing.push('constraints')
    if (!Array.isArray(module.files) || module.files.length === 0) missing.push('files')
    if (!Array.isArray(module.acceptance) || module.acceptance.length === 0) missing.push('acceptance')
    if (missing.length > 0) out.push(`${id}: ${missing.join(', ')}`)
  })
  return out
}
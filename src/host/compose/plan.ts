// compose-plan.json: the only place where content lives.
// This module never invents content. It defines the v1 shape, validates it,
// renders an empty-but-legal template, and computes the slots a model still
// has to fill. All problems carry a JSON Pointer so the model can fix them.

export interface PlanProblem {
  code: string
  path: string
  message: string
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
  globals: { conventions: string[]; forbidden: string[]; envKeys?: string[] }
  data: Array<{
    table: string
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
    acceptance: Array<{ id: string; assertion: string; test: string }>
  }>
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
])
const EXPOSE_KEYS = new Set(['kind', 'signature', 'note'])
const REQUIRE_KEYS = new Set(['module', 'item', 'why'])
const BOUNDARY_KEYS = new Set(['dependency', 'purpose', 'version', 'fallback'])
const COLUMN_KEYS = new Set(['name', 'type', 'constraints'])
const DATA_KEYS = new Set(['table', 'columns', 'indexes', 'notes'])
const GLOBALS_KEYS = new Set(['conventions', 'forbidden', 'envKeys'])
const DELIVERABLE_KEYS = new Set(['tree', 'files'])
const FILE_KEYS = new Set(['path', 'purpose'])
const ACCEPTANCE_KEYS = new Set(['id', 'assertion', 'test'])

type Json = Record<string, unknown>

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

export function validatePlan(raw: unknown): PlanValidation {
  const problems: PlanProblem[] = []
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

  if (!isRecord(raw.globals)) {
    problem(problems, '/globals', 'must be an object')
  } else {
    checkKnownKeys(raw.globals, GLOBALS_KEYS, '/globals', problems)
    readStringArray(raw.globals.conventions, '/globals/conventions', problems)
    readStringArray(raw.globals.forbidden, '/globals/forbidden', problems)
    if (raw.globals.envKeys !== undefined) readStringArray(raw.globals.envKeys, '/globals/envKeys', problems)
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

  validateModules(raw.modules, problems)

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
    globals: { conventions: [], forbidden: [], envKeys: [] },
    data: [],
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

/** Slots the model still has to fill, per module, e.g. `M3: exposes, acceptance`. */
export function missingSlots(raw: unknown): string[] {
  const modules = isRecord(raw) && Array.isArray(raw.modules) ? raw.modules : []
  const out: string[] = []
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
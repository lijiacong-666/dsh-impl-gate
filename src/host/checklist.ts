// Parses the delivered checklist (<implRoot>/.impl-gate/checklist.md).
// The gate never writes this file; it only reads and validates the four
// columns the user fixed in Step 3: id | status | evidence | reason.
import fs from 'node:fs'

export type ChecklistStatus = 'PASS' | 'FAIL' | 'NOT-RUN'

export interface ChecklistRow {
  id: string
  status: string
  evidence: string
  reason: string
}

export interface ChecklistParse {
  path: string
  provided: boolean
  rows: Map<string, ChecklistRow>
  duplicatedIds: string[]
  uncovered: Set<string>
  hasUncoveredSection: boolean
  errors: string[]
}

/** §5 NOT-RUN reason codes plus the two deviations registered in Step 1.5. */
export const NOT_RUN_REASONS: ReadonlySet<string> = new Set([
  'MISSING_INSTRUCTION_PACKAGE',
  'CHECKLIST_NOT_PROVIDED',
  'IMPL_ROOT_NOT_PROVIDED',
  'LANGUAGE_UNSUPPORTED',
  'GIT_UNAVAILABLE',
  'SLOW_CHECK_DISABLED',
  'NETWORK_BLOCK_UNSUPPORTED',
  'SCHEMA_UNAVAILABLE',
  'D4_GRAPH_INVALID',
  'GUI_REQUIRES_MANUAL_CHECK',
  'NOT_IMPLEMENTED',
  'MANUAL_REVIEW_REQUIRED',
  'MAPPING_TABLE_NOT_PROVIDED',
])

export const CHECKLIST_STATUSES: ReadonlySet<string> = new Set(['PASS', 'FAIL', 'NOT-RUN'])

function splitRow(line: string): string[] {
  const trimmed = line.trim()
  const cells = trimmed.split('|')
  if (trimmed.startsWith('|')) cells.shift()
  if (trimmed.endsWith('|')) cells.pop()
  return cells.map((cell) => cell.trim())
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

export function parseChecklist(text: string, filePath: string): ChecklistParse {
  const rows = new Map<string, ChecklistRow>()
  const duplicatedIds: string[] = []
  const errors: string[] = []
  const uncovered = new Set<string>()
  let hasUncoveredSection = false
  let inUncovered = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('#')) {
      inUncovered = /未覆盖/.test(line)
      if (inUncovered) hasUncoveredSection = true
      continue
    }
    if (inUncovered) {
      for (const token of line.split(/[\s,，、|]+/)) {
        if (/^[ABMQ]\d+$/.test(token)) uncovered.add(token)
      }
      continue
    }
    if (!line.startsWith('|')) continue
    const cells = splitRow(line)
    if (cells.length < 4 || isSeparator(cells)) continue
    const [id, status, evidence, reason] = cells
    if (id === undefined || id.toLowerCase() === 'id') continue
    if (id.length === 0) continue
    if (rows.has(id)) duplicatedIds.push(id)
    rows.set(id, { id, status: status ?? '', evidence: evidence ?? '', reason: reason ?? '' })
  }

  for (const row of rows.values()) {
    if (!CHECKLIST_STATUSES.has(row.status)) {
      errors.push(`${row.id}: status "${row.status}" is not one of PASS/FAIL/NOT-RUN`)
    }
    if (!/^(command|file):\s*\S/.test(row.evidence)) {
      errors.push(`${row.id}: evidence must start with "command:" or "file:"`)
    }
    if (row.status === 'NOT-RUN') {
      if (row.reason.length === 0) errors.push(`${row.id}: NOT-RUN requires a reason`)
      else if (!NOT_RUN_REASONS.has(row.reason)) errors.push(`${row.id}: reason "${row.reason}" is not a §5 code`)
    } else if (row.reason.length > 0) {
      errors.push(`${row.id}: reason is only allowed on NOT-RUN`)
    }
  }
  if (duplicatedIds.length > 0) errors.unshift(`duplicate ids: ${duplicatedIds.join(', ')}`)

  return { path: filePath, provided: true, rows, duplicatedIds, uncovered, hasUncoveredSection, errors }
}

export function loadChecklist(filePath: string): ChecklistParse {
  try {
    const text = fs.readFileSync(filePath, 'utf8')
    return parseChecklist(text, filePath)
  } catch {
    return {
      path: filePath,
      provided: false,
      rows: new Map(),
      duplicatedIds: [],
      uncovered: new Set(),
      hasUncoveredSection: false,
      errors: [],
    }
  }
}

export interface ChecklistAudit {
  notRun: Set<string>
  /** NOT-RUN rows that the 「未覆盖」 section forgot to list. */
  onlyInReport: string[]
  /** Ids listed under 「未覆盖」 that are not NOT-RUN rows. */
  onlyInSection: string[]
  /** NOT-RUN rows exist but the section itself is missing. */
  sectionMissingButNeeded: boolean
}

/** A4's symmetric set comparison, kept pure so it can be unit tested. */
export function auditChecklist(list: ChecklistParse): ChecklistAudit {
  const notRun = new Set(
    [...list.rows.values()].filter((row) => row.status === 'NOT-RUN').map((row) => row.id),
  )
  return {
    notRun,
    onlyInReport: [...notRun].filter((id) => !list.uncovered.has(id)),
    onlyInSection: [...list.uncovered].filter((id) => !notRun.has(id)),
    sectionMissingButNeeded: notRun.size > 0 && !list.hasUncoveredSection,
  }
}
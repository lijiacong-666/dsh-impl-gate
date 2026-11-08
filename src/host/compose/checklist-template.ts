// Design-stage checklist skeleton. `materialize` writes this next to SPEC.md so
// the 32 ids stop living only inside the gate: an implementer gets the exact row
// shape (id | status | evidence | reason) and the 「未覆盖」 section that A4 checks.
//
// Every row starts as NOT-RUN / NOT_IMPLEMENTED on purpose — nothing has been
// verified yet. A2 (row set), A3 (evidence prefixes) and A4 (notRun ≡ uncovered)
// can already be decided by the gate; the rest stay NOT-RUN until evidence exists.
//
// Re-running materialize must NOT erase work: rows whose status is PASS or FAIL
// are carried over from the previous file (with their evidence), and the file is
// backed up before being rewritten.

import { parseChecklist } from '../checklist.js'
import type { CheckItem } from '../checks.js'

export const CHECKLIST_REL = '.impl-gate/checklist.md'

export interface ChecklistMerge {
  body: string
  /** Rows carried over because their status was PASS or FAIL. */
  preserved: string[]
}

const SECTION_BY_GROUP: Record<string, string> = { A: '## 3', B: '## 6', M: '## 4', Q: '## 8' }

/** Line (1-based) of the SPEC section a check belongs to; falls back to line 1. */
export function specLineFor(id: string, specText: string): number {
  const heading = SECTION_BY_GROUP[id.charAt(0).toUpperCase()]
  if (heading === undefined) return 1
  const lines = specText.split(/\r?\n/)
  const index = lines.findIndex((line) => line.startsWith(heading))
  return index < 0 ? 1 : index + 1
}

export function renderChecklistTemplate(items: CheckItem[], name: string, evidence?: (id: string) => string): string {
  const lines: string[] = []
  lines.push('# 验收勾选表')
  lines.push('')
  lines.push(`- 项目：${name}`)
  lines.push(`- 生成：由 impl_gate_compose 的 materialize 步骤按 checks/impl-gate.checks.json 生成，共 ${items.length} 条`)
  lines.push('- 改 plan 后重新 materialize 只替换 NOT-RUN 行；已填 PASS/FAIL 的证据会原样保留')
  lines.push('- 只允许三态：PASS / FAIL / NOT-RUN；PASS 与 FAIL 的 evidence 必须以 `command:` 或 `file:` 开头')
  lines.push('')
  lines.push('| id | status | evidence | reason |')
  lines.push('|----|--------|----------|--------|')
  for (const item of items) {
    lines.push(`| ${item.id} | NOT-RUN | ${evidence === undefined ? 'file:SPEC.md:1' : evidence(item.id)} | NOT_IMPLEMENTED |`)
  }
  lines.push('')
  lines.push('## 未覆盖')
  lines.push('')
  lines.push('以下条目当前没有结论，必须逐条补证据或写明原因：')
  lines.push('')
  lines.push(items.map((item) => item.id).join('、'))
  lines.push('')
  return lines.join('\n')
}

/**
 * Rebuild the checklist from the current checks, keeping every row the user has
 * already decided (PASS/FAIL). Unknown or deleted ids are dropped; new ids get
 * the NOT-RUN row from the template.
 */
export function mergeChecklist(previous: string | undefined, items: CheckItem[], name: string, evidence?: (id: string) => string): ChecklistMerge {
  if (previous === undefined || previous.trim() === '') {
    return { body: renderChecklistTemplate(items, name, evidence), preserved: [] }
  }
  const parsed = parseChecklist(previous, CHECKLIST_REL)
  const kept = new Map<string, string>()
  const preserved: string[] = []
  for (const [id, row] of parsed.rows) {
    if (row.status === 'PASS' || row.status === 'FAIL') {
      kept.set(id, `| ${id} | ${row.status} | ${row.evidence} | ${row.reason} |`)
      preserved.push(id)
    }
  }

  const lines: string[] = []
  lines.push('# 验收勾选表')
  lines.push('')
  lines.push(`- 项目：${name}`)
  lines.push(`- 生成：由 impl_gate_compose 的 materialize 步骤按 checks/impl-gate.checks.json 生成，共 ${items.length} 条`)
  lines.push('- 改 plan 后重新 materialize 只替换 NOT-RUN 行；已填 PASS/FAIL 的证据会原样保留')
  lines.push('- 只允许三态：PASS / FAIL / NOT-RUN；PASS 与 FAIL 的 evidence 必须以 `command:` 或 `file:` 开头')
  lines.push('')
  lines.push('| id | status | evidence | reason |')
  lines.push('|----|--------|----------|--------|')
  const uncovered: string[] = []
  for (const item of items) {
    const carried = kept.get(item.id)
    if (carried !== undefined) {
      lines.push(carried)
    } else {
      lines.push(`| ${item.id} | NOT-RUN | ${evidence === undefined ? 'file:SPEC.md:1' : evidence(item.id)} | NOT_IMPLEMENTED |`)
      uncovered.push(item.id)
    }
  }
  lines.push('')
  lines.push('## 未覆盖')
  lines.push('')
  lines.push('以下条目当前没有结论，必须逐条补证据或写明原因：')
  lines.push('')
  lines.push(uncovered.length === 0 ? '（无）' : uncovered.join('、'))
  lines.push('')
  return { body: lines.join('\n'), preserved: preserved.filter((id) => items.some((item) => item.id === id)) }
}
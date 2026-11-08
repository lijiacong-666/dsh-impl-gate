// Design-stage checklist skeleton. `materialize` writes this next to SPEC.md so
// the 32 ids stop living only inside the gate: an implementer gets the exact row
// shape (id | status | evidence | reason) and the 「未覆盖」 section that A4 checks.
//
// Every row starts as NOT-RUN / NOT_IMPLEMENTED on purpose — nothing has been
// verified yet. A2 (row set), A3 (evidence prefixes) and A4 (notRun ≡ uncovered)
// can already be decided by the gate; the rest stay NOT-RUN until evidence exists.

import type { CheckItem } from '../checks.js'

export const CHECKLIST_REL = '.impl-gate/checklist.md'

export function renderChecklistTemplate(items: CheckItem[], name: string): string {
  const lines: string[] = []
  lines.push('# 验收勾选表')
  lines.push('')
  lines.push(`- 项目：${name}`)
  lines.push(`- 生成：由 impl_gate_compose 的 materialize 步骤按 checks/impl-gate.checks.json 生成，共 ${items.length} 条`)
  lines.push('- 改 plan 后重新 materialize 会覆盖本文件（它登记在 ownership.json 里）')
  lines.push('- 只允许三态：PASS / FAIL / NOT-RUN；PASS 与 FAIL 的 evidence 必须以 `command:` 或 `file:` 开头')
  lines.push('')
  lines.push('| id | status | evidence | reason |')
  lines.push('|----|--------|----------|--------|')
  for (const item of items) {
    lines.push(`| ${item.id} | NOT-RUN | file:SPEC.md:1 | NOT_IMPLEMENTED |`)
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
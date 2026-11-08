// Design-stage requirement mapping. B1 needs every need id (`### N1` in a
// module's `## 需要`) covered by a row here; without this file the gate can only
// say MAPPING_TABLE_NOT_PROVIDED. Ids are per-module (`N1`…), exactly like the
// rendered spec.md, so the rows are derived from the same plan.

import type { Plan } from './plan.js'

export const MAPPING_REL = '.impl-gate/mapping.md'

export function renderMappingTemplate(plan: Plan): string {
  const lines: string[] = []
  lines.push('# 需求 → 模块 映射表')
  lines.push('')
  lines.push(`- 项目：${plan.name}`)
  lines.push('- 由 impl_gate_compose 的 materialize 步骤按 plan 的 requires 生成；改 plan 后重新 materialize 会覆盖')
  lines.push('- 需求 ID 与各模块 `spec.md` 的 `## 需要` 小节一一对应（每个模块内部从 N1 起）')
  lines.push('')
  lines.push('| 需求ID | 模块 | 条目 |')
  lines.push('|--------|------|------|')
  for (const module of plan.modules) {
    module.requires.forEach((need, index) => {
      lines.push(`| N${index + 1} | ${module.dir} | ${oneLine(need.item)} |`)
    })
  }
  lines.push('')
  return lines.join('\n')
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}
// SPEC-DRAFT.md: a nine-section skeleton generated from the plan template.
// Drafts contain no invented content: every section says which plan field it
// will render, and every module lists the slots that are still empty.

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, fallback = '（待填）'): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : []
}

function moduleSlot(module: Json, field: string): string {
  const value = module[field]
  const empty =
    value === undefined ||
    (typeof value === 'string' && value.trim().length === 0) ||
    (Array.isArray(value) && value.length === 0)
  if (empty) return `<!-- TODO: ${field} -->`
  if (Array.isArray(value)) return `（当前 ${value.length} 条，materialize 时展开）`
  return `（已填，materialize 时展开）`
}

export function renderDraft(input: { plan: unknown; requirement?: string }): string {
  const plan = isRecord(input.plan) ? input.plan : {}
  const modules = Array.isArray(plan.modules) ? plan.modules.filter(isRecord) : []
  const lines: string[] = []

  lines.push(`# ${text(plan.title, text(plan.name, '未命名系统'))} · SPEC（草稿）`)
  lines.push('')
  lines.push(`> 需求：${text(input.requirement, '（未提供）')}`)
  lines.push('> 本文件由 impl_gate_compose 生成；请补齐 compose-plan.json 后重新 materialize。')
  lines.push('>')
  lines.push('> 这一份只是骨架：每节注明数据来自 plan 的哪个字段，模块小节里的 `<!-- TODO: … -->` 是还没填的槽位。')
  lines.push('')

  lines.push('## 1 目标与非目标')
  lines.push('> 数据来源：`summary` + `goals` + `nonGoals`。')
  lines.push('')
  lines.push(text(plan.summary, '<!-- TODO: summary -->'))
  lines.push('')
  lines.push(`- 目标：${stringList(plan.goals).length > 0 ? `（当前 ${stringList(plan.goals).length} 条）` : '<!-- TODO: goals -->'}`)
  lines.push(
    `- 非目标：${stringList(plan.nonGoals).length > 0 ? `（当前 ${stringList(plan.nonGoals).length} 条）` : '<!-- TODO: nonGoals -->'}`,
  )
  lines.push('')

  lines.push('## 2 系统边界')
  lines.push('> 数据来源：`boundaries`；表格四列为依赖 / 用途 / 版本 / 不可用时怎么办。')
  lines.push('')
  lines.push(Array.isArray(plan.boundaries) && plan.boundaries.length > 0 ? '（已填，materialize 时展开为表格）' : '<!-- TODO: boundaries -->')
  lines.push('')

  lines.push('## 3 模块清单')
  lines.push('> 数据来源：`modules`；每个模块一个 `### M<id>` 小节。')
  lines.push('')
  if (modules.length === 0) {
    lines.push('<!-- TODO: modules -->')
    lines.push('')
  }
  for (const module of modules) {
    const id = text(module.id, 'M?')
    lines.push(`### ${id} ${text(module.title, '（标题待填）')}`)
    lines.push(`- 目录：${text(module.dir, '<!-- TODO: dir -->')}`)
    lines.push(`- 职责：${text(module.responsibility, '<!-- TODO: responsibility -->')}`)
    lines.push(`- 提供（exposes）：${moduleSlot(module, 'exposes')}`)
    lines.push(`- 需要（requires）：${moduleSlot(module, 'requires')}`)
    lines.push(`- 约束（constraints）：${moduleSlot(module, 'constraints')}`)
    lines.push(`- 文件（files）：${moduleSlot(module, 'files')}`)
    lines.push(`- 验收（acceptance）：${moduleSlot(module, 'acceptance')}`)
    lines.push('')
  }

  lines.push('## 4 数据结构')
  lines.push('> 数据来源：`data`；每张表列出字段与类型，并附上 `indexes`、`notes`。')
  lines.push('')
  lines.push(Array.isArray(plan.data) && plan.data.length > 0 ? '（已填，materialize 时展开）' : '<!-- TODO: data -->')
  lines.push('')

  lines.push('## 5 模块连线')
  lines.push('> 数据来源：`requires` → `graph.toml` 的 link；表格列为谁调谁 / 传什么 / 失败处理。')
  lines.push('')
  lines.push('（materialize 时由 link 关系生成）')
  lines.push('')

  lines.push('## 6 验收标准')
  lines.push('> 数据来源：每个模块的 `acceptance`；表格列为编号 / 断言 / 最低测试。')
  lines.push('')
  lines.push('（materialize 时由 acceptance 生成）')
  lines.push('')

  lines.push('## 7 实施波次')
  lines.push('> 数据来源：由 link 的最长路径计算（与 impl_gate_init 共用同一函数）。')
  lines.push('')
  lines.push('（materialize 时生成）')
  lines.push('')

  lines.push('## 8 全局约定')
  lines.push('> 数据来源：`globals` + `stack` + `envKeys`。')
  lines.push('')
  const globals = isRecord(plan.globals) ? plan.globals : {}
  lines.push(`- 技术栈：${text(plan.stack, '<!-- TODO: stack -->')}`)
  lines.push(`- 约定：${stringList(globals.conventions).length > 0 ? `（当前 ${stringList(globals.conventions).length} 条）` : '<!-- TODO: conventions -->'}`)
  lines.push(`- 禁止：${stringList(globals.forbidden).length > 0 ? `（当前 ${stringList(globals.forbidden).length} 条）` : '<!-- TODO: forbidden -->'}`)
  lines.push(`- 环境变量：${stringList(globals.envKeys).length > 0 ? '（已填）' : '<!-- TODO: envKeys（可选） -->'}`)
  lines.push('')

  lines.push('## 9 交付清单')
  lines.push('> 数据来源：`deliverables.tree` + `deliverables.files`；表格列为路径 / 用途。')
  lines.push('')
  const deliverables = isRecord(plan.deliverables) ? plan.deliverables : {}
  lines.push(`- 目录树：${text(deliverables.tree, '<!-- TODO: deliverables.tree -->')}`)
  lines.push(
    `- 文件：${Array.isArray(deliverables.files) && deliverables.files.length > 0 ? `（当前 ${deliverables.files.length} 条）` : '<!-- TODO: deliverables.files -->'}`,
  )
  lines.push('')
  lines.push('---')
  lines.push('补齐 compose-plan.json 后，用 `impl_gate_compose(mode: "materialize")` 生成正式 SPEC.md。')
  lines.push('')

  return lines.join('\n')
}
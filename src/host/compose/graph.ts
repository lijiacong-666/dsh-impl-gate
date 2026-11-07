// Renders spec-graph artifacts from a validated plan.
// The shape follows examples/05-用户中心 and examples/01-最小可过 exactly:
// spec.md has `## 提供 / ## 需要 / ## 约束` with `### <ID> <title>` items, and
// graph.toml carries only `[[link]]` entries (`satisfies = [{ need, expose }]`).
// No `[[node]]` / top-level metadata is invented: spec-graph 0.9.2 discovers
// nodes from folders and ignores anything else.

import type { Plan } from './plan.js'

type Module = Plan['modules'][number]

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function exposeId(index: number): string {
  return `E${index + 1}`
}

function needId(index: number): string {
  return `N${index + 1}`
}

function constraintId(index: number): string {
  return `C${index + 1}`
}

/** Index of the exposed item that `item` refers to, or -1. */
export function findExposeIndex(provider: Module, item: string): number {
  return provider.exposes.findIndex((expose) => expose.signature === item)
}

export function renderModuleSpec(plan: Plan, module: Module): string {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]))
  const lines: string[] = [
    '---',
    `name: ${module.dir}`,
    'kind: module',
    '---',
    '',
    '## 提供',
    '',
  ]

  module.exposes.forEach((expose, index) => {
    lines.push(`### ${exposeId(index)} ${oneLine(expose.signature)}`)
    lines.push(`- 名称：${oneLine(expose.signature)}`)
    if (expose.note !== undefined) lines.push(`- 语义：${oneLine(expose.note)}`)
    lines.push('')
  })

  lines.push('## 需要', '')
  if (module.requires.length === 0) {
    lines.push('（无。）', '')
  } else {
    module.requires.forEach((need, index) => {
      const provider = byId.get(need.module)
      const exposeIndex = provider === undefined ? -1 : findExposeIndex(provider, need.item)
      lines.push(`### ${needId(index)} ${oneLine(need.item)}`)
      lines.push(`- 名称：${oneLine(need.item)}`)
      if (need.why !== undefined) lines.push(`- 语义：${oneLine(need.why)}`)
      lines.push(`- 满足于：[[${provider?.dir ?? need.module}#提供/${exposeId(exposeIndex < 0 ? 0 : exposeIndex)}]]`)
      lines.push('')
    })
  }

  lines.push('## 约束', '')
  module.constraints.forEach((constraint, index) => {
    lines.push(`### ${constraintId(index)} ${oneLine(constraint)}`)
    lines.push(`- 规则：${oneLine(constraint)}`)
    lines.push('')
  })

  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * One `[[link]]` per (from, to) pair, preserving requirement order so that
 * `need = "N<i>"` always matches the N ids rendered in the module's spec.md.
 */
export function renderGraphToml(plan: Plan): string {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]))
  const groups = new Map<string, { from: string; to: string; satisfies: Array<{ need: string; expose: string }> }>()

  for (const module of plan.modules) {
    module.requires.forEach((need, index) => {
      const provider = byId.get(need.module)
      if (provider === undefined) return
      const exposeIndex = findExposeIndex(provider, need.item)
      if (exposeIndex < 0) return
      const key = `${module.dir}\u0000${provider.dir}`
      const group = groups.get(key) ?? { from: module.dir, to: provider.dir, satisfies: [] }
      group.satisfies.push({ need: needId(index), expose: exposeId(exposeIndex) })
      groups.set(key, group)
    })
  }

  const lines: string[] = ['# 由 dsh-impl-gate 从 compose-plan.json 生成；改契约请改 plan 后重跑 materialize。']
  for (const group of groups.values()) {
    lines.push('', '[[link]]', `from = "${group.from}"`, `to = "${group.to}"`, 'satisfies = [')
    for (const entry of group.satisfies) {
      lines.push(`  { need = "${entry.need}", expose = "${entry.expose}" },`)
    }
    lines.push(']')
  }
  return `${lines.join('\n')}\n`
}

export function moduleOutputDir(plan: Plan, module: Module): string {
  return `${plan.name}/${module.dir}`
}
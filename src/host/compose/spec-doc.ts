// Nine-section SPEC.md renderer. Section order and numbering are part of the
// contract with downstream task cards: never drop a section, render `（无）`.

import type { Plan } from './plan.js'
import type { WavesResult } from '../init/waves.js'
import { findExposeIndex } from './graph.js'
import { renderTypeBlock } from './type-doc.js'

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function listOrNone(items: string[]): string[] {
  return items.length === 0 ? ['（无）'] : items.map((item) => `- ${cell(item)}`)
}

function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ['（无）']
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.map((value) => cell(value)).join(' | ')} |`)
  return lines
}

export interface SpecDocInput {
  plan: Plan
  waves: WavesResult
}

export function renderSpecDoc(input: SpecDocInput): string {
  const { plan, waves } = input
  const byId = new Map(plan.modules.map((module) => [module.id, module]))
  const lines: string[] = [`# ${plan.title}`, '', `> ${plan.summary}`, '']

  // 1
  lines.push('## 1 目标与非目标', '', '### 目标', ...listOrNone(plan.goals), '', '### 非目标', ...listOrNone(plan.nonGoals), '')

  // 2
  lines.push('## 2 系统边界', '')
  lines.push(...table(
    ['依赖', '用途', '版本', '降级'],
    plan.boundaries.map((boundary) => [boundary.dependency, boundary.purpose, boundary.version ?? '—', boundary.fallback]),
  ))
  lines.push('', `技术栈：${plan.stack.length > 0 ? cell(plan.stack) : '（无）'}`, '')

  // 3
  lines.push('## 3 模块清单', '')
  lines.push(...table(
    ['模块', '目录', '职责', '提供（签名）', '需要', '文件白名单'],
    plan.modules.map((module) => [
      module.id,
      module.dir,
      module.responsibility,
      module.exposes.map((expose) => expose.signature).join('<br>'),
      module.requires.map((need) => need.item).join('<br>') || '（无）',
      module.files.join('<br>'),
    ]),
  ))
  lines.push('')

  // 4
  lines.push('## 4 数据结构', '', '### 4.1 表', '')
  if (plan.data.length === 0) {
    lines.push('（无）', '')
  } else {
    for (const entry of plan.data) {
      lines.push(`#### ${entry.table}`)
      lines.push(...table(
        ['字段', '类型', '约束', '建表模块'],
        entry.columns.map((column) => [column.name, column.type, (column.constraints ?? []).join('<br>') || '—', entry.owner]),
      ))
      if (entry.indexes !== undefined && entry.indexes.length > 0) lines.push('', `索引：${entry.indexes.join('<br>')}`)
      if (entry.notes !== undefined) lines.push('', `说明：${entry.notes}`)
      lines.push('')
    }
  }

  lines.push('### 4.2 类型', '')
  const types = plan.types ?? []
  if (types.length === 0) {
    lines.push('（无）', '')
  } else {
    for (const type of types) {
      lines.push(...renderTypeBlock(type), '')
    }
  }

  lines.push('### 4.3 错误码', '')
  const errors = plan.errors ?? []
  if (errors.length === 0) {
    lines.push('（无）', '')
  } else {
    lines.push(...table(
      ['码', '状态码', '触发条件', '响应体'],
      errors.map((error) => [error.code, String(error.status), error.when, error.shape ?? '—']),
    ), '')
  }

  lines.push('### 4.4 接口面', '')
  const http = plan.http ?? []
  if (http.length === 0) {
    lines.push('（无）', '')
  } else {
    lines.push(...table(
      ['方法', '路径', '处理模块', '请求', '响应'],
      http.map((route) => [route.method, route.path, route.module, route.req ?? '（无）', route.res]),
    ), '')
  }

  // 5
  lines.push('## 5 模块连线', '')
  const links: string[][] = []
  for (const module of plan.modules) {
    module.requires.forEach((need) => {
      const provider = byId.get(need.module)
      if (provider === undefined) return
      const exposeIndex = findExposeIndex(provider, need.item)
      const provided = exposeIndex < 0 ? need.item : provider.exposes[exposeIndex]?.signature ?? need.item
      links.push([module.dir, provider.dir, need.item, provided])
    })
  }
  if (links.length === 0) {
    lines.push('（无跨模块依赖）', '')
  } else {
    lines.push(...table(['从', '到', '需要条目（原文）', '提供条目（原文）'], links), '')
  }

  // 6
  lines.push('## 6 验收标准', '')
  const acceptance: string[][] = []
  for (const module of plan.modules) {
    module.acceptance.forEach((item, index) => {
      acceptance.push([`AC-${module.id}-${index + 1}`, module.id, item.assertion, item.test, item.covers ?? '—'])
    })
  }
  lines.push(...table(['编号', '模块', '断言', '证据', '覆盖目标'], acceptance), '')

  // 7
  lines.push('## 7 实施波次', '')
  const waveRows: string[][] = []
  for (const wave of waves.waves) {
    for (const moduleId of wave.modules) {
      waveRows.push([`第 ${wave.index} 波`, moduleId, '是', wave.dependsOn.length === 0 ? '（无）' : wave.dependsOn.join('<br>')])
    }
  }
  lines.push(...table(['波次', '模块', '可并行', '前置'], waveRows), '')

  // 8
  lines.push('## 8 全局约定', '', '### 约定', ...listOrNone(plan.globals.conventions), '')
  lines.push('### 禁止', ...listOrNone(plan.globals.forbidden), '')
  lines.push('### 环境变量', ...listOrNone(plan.globals.envKeys ?? []), '')
  const fieldCase = plan.globals.fieldCase ?? 'camel'
  const envelope = plan.globals.listEnvelope === true ? '是' : '否'
  const errorShape = plan.errors?.[0]?.shape ?? '（无）'
  lines.push(
    '### 接口约定',
    '',
    `- 字段命名：${fieldCase}`,
    `- 列表包裹：${envelope}`,
    `- 错误体形状：${cell(errorShape)}`,
    '',
  )

  // 9
  lines.push('## 9 交付清单', '')
  const tree = plan.deliverables.tree.trim()
  lines.push('```text', tree.length > 0 ? plan.deliverables.tree.trimEnd() : '（无）', '```', '')
  lines.push(...table(['文件', '用途'], plan.deliverables.files.map((file) => [file.path, file.purpose])), '')

  lines.push('## 附录 A 未决问题', '')
  lines.push(...listOrNone(plan.openQuestions ?? []), '')

  lines.push('> 本文由 dsh-impl-gate 从 compose-plan.json 生成，改契约请改 plan 后重跑 materialize。')
  return `${lines.join('\n')}\n`
}
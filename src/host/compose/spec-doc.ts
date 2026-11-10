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

const FK_RE = /^references:\s*([A-Za-z0-9_]+)\(id\)$/

/**
 * G7: map each referenced table to the owners of the tables that reference it
 * (self-references excluded). A table only read through a foreign key must
 * still name its runtime writers, so 4.1 prints them when the referencing
 * module is not one of them.
 */
function referencedByOwners(plan: Plan): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const entry of plan.data) {
    for (const column of entry.columns ?? []) {
      for (const constraint of column.constraints ?? []) {
        const match = FK_RE.exec(constraint.trim())
        const target = match?.[1]
        if (target === undefined || target === entry.table) continue
        const set = owners.get(target) ?? new Set<string>()
        set.add(entry.owner)
        owners.set(target, set)
      }
    }
  }
  return owners
}

export function renderSpecDoc(input: SpecDocInput): string {
  const { plan, waves } = input
  const byId = new Map(plan.modules.map((module) => [module.id, module]))
  const lines: string[] = [`# ${plan.title}`, '', `> ${plan.summary}`, '']

  // 1
  const goalLines =
    plan.goals.length === 0
      ? ['（无）']
      : plan.goals.map((goal, index) => `- **G${index + 1}** ${goal}`)
  lines.push('## 1 目标与非目标', '', '### 目标', ...goalLines, '', '### 非目标', ...listOrNone(plan.nonGoals), '')

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

  // 3.1: constraints are contract, not commentary. Blind reviews missed lock
  // keys and error-construction rules that only existed in plan.constraints.
  lines.push('### 3.1 模块约束', '')
  lines.push(...table(
    ['模块', '约束'],
    plan.modules.map((module) => [module.id, (module.constraints ?? []).join('<br>') || '（无）']),
  ))
  lines.push('')

  // 4
  lines.push('## 4 数据结构', '', '### 4.1 表', '')
  if (plan.data.length === 0) {
    lines.push('（无）', '')
  } else {
    const referencedBy = referencedByOwners(plan)
    for (const entry of plan.data) {
      lines.push(`#### ${entry.table}`)
      const writers = Array.isArray(entry.rowWriters) ? entry.rowWriters : []
      // G10: every table names its runtime writers in the table itself. The
      // G7 prose line below stays as a cross-reference for foreign keys.
      lines.push(...table(
        ['字段', '类型', '约束', '建表模块', '运行时写入方'],
        entry.columns.map((column) => [
          column.name,
          column.type,
          (column.constraints ?? []).join('<br>') || '—',
          entry.owner,
          writers.length > 0 ? writers.join(', ') : '（无）',
        ]),
      ))
      // G7: the owner creates the table; rowWriters insert/update at runtime.
      // If a table is referenced by a module that does not write it, name the
      // writers so the implementer knows who creates the rows.
      const referencingOwners = referencedBy.get(entry.table)
      if (
        writers.length > 0 &&
        referencingOwners !== undefined &&
        (writers.length !== referencingOwners.size || writers.some((moduleId) => !referencingOwners.has(moduleId)))
      ) {
        lines.push('', `写入方：${writers.join(', ')}`)
      }
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
      ['码', '状态码', '归属模块', '触发条件', '响应体'],
      errors.map((error) => [
        error.code,
        String(error.status),
        error.by ?? '（未指定）',
        error.when,
        error.shape ?? plan.globals.errorShape ?? '—',
      ]),
    ), '')
  }

  lines.push('### 4.4 接口面', '')
  const http = plan.http ?? []
  if (http.length === 0) {
    lines.push('（无）', '')
  } else {
    lines.push(...table(
      ['方法', '路径', '处理模块', '处理函数', '鉴权', '状态码', '请求', '响应'],
      http.map((route) => [
        route.method,
        route.path,
        route.module,
        `${route.handler}()`,
        route.auth ?? 'public',
        String(route.status ?? (route.res.trim() === 'void' ? 204 : 200)),
        route.req ?? '（无）',
        route.res.trim() === 'void' ? '204（无响应体）' : route.res,
      ]),
    ), '')
    const withHeaders = http.filter((route) => route.resHeaders !== undefined)
    if (withHeaders.length > 0) {
      lines.push('响应头（契约的一部分）：', '')
      for (const route of withHeaders) {
        const pairs = Object.entries(route.resHeaders ?? {}).map(([name, value]) => `${name}: ${value}`)
        lines.push(`- ${route.method} ${route.path} — ${pairs.join('；')}`)
      }
      lines.push('')
    }
    const withQuery = http.filter((route) => (route.query ?? []).length > 0)
    if (withQuery.length > 0) {
      lines.push('查询参数（契约的一部分）：', '')
      for (const route of withQuery) {
        const params = (route.query ?? []).map(
          (param) => `${param.name}（${param.type}，${param.required === true ? '必填' : '可选'}）${param.note !== undefined ? ` — ${param.note}` : ''}`,
        )
        lines.push(`- ${route.method} ${route.path} — ${params.join('、')}`)
      }
      lines.push('')
    }
    const documented = http.filter((route) => route.reqExample !== undefined || route.resExample !== undefined)
    for (const route of documented) {
      lines.push(`#### ${route.method} ${route.path} 示例`, '')
      const bodyless = route.method === 'GET' || route.method === 'DELETE'
      if (route.reqExample !== undefined) {
        lines.push(bodyless ? '查询参数示例：' : '请求体：', '', '```json', route.reqExample.trim(), '```', '')
      }
      if (route.resExample !== undefined) {
        lines.push('响应体：', '', '```json', route.resExample.trim(), '```', '')
      }
    }
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

  const flows = plan.flows ?? []
  if (flows.length > 0) {
    lines.push('### 5.1 关键流程（时序）', '')
    lines.push('每一步都只能通过目标模块 `## 3` 里列出的签名调用；顺序即调用顺序。', '')
    for (const flow of flows) {
      lines.push(`#### ${flow.id} ${flow.name}`, '')
      lines.push(`- 触发：${flow.trigger}`)
      lines.push(`- 成功结果：${flow.success}`)
      if (flow.failure !== undefined && flow.failure.length > 0) {
        lines.push(`- 失败可能：${flow.failure.join('、')}`)
      }
      lines.push('')
      flow.steps.forEach((step, index) => {
        const owner = byId.get(step.module)
        const dir = owner === undefined ? step.module : owner.dir
        const note = step.note === undefined || step.note.length === 0 ? '' : `　— ${step.note}`
        lines.push(`${index + 1}. \`${dir}\`：${step.action}${note}`)
      })
      lines.push('')
    }
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
  const covered = new Set<number>()
  for (const module of plan.modules) {
    for (const item of module.acceptance) {
      const match = item.covers === undefined ? null : /^G([1-9][0-9]*)$/.exec(item.covers)
      if (match !== null) covered.add(Number(match[1]))
    }
  }
  const uncovered = plan.goals.map((_, index) => index + 1).filter((goal) => !covered.has(goal))
  if (plan.goals.length > 0 && uncovered.length > 0) {
    lines.push(`覆盖缺口：${uncovered.map((goal) => `G${goal}`).join('、')} 没有验收断言对应的 \`covers\`，开工会上需补。`, '')
  }

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
  const errorShape = plan.globals.errorShape ?? plan.errors?.[0]?.shape ?? '（无）'
  lines.push(
    '### 接口约定',
    '',
    `- 字段命名：${fieldCase}`,
    `- 列表包裹：${envelope}`,
    `- 错误体形状：${cell(errorShape)}`,
    '- 错误对象：抛出的值必须是 `instanceof Error`，带 `code: string`（取自 §4.3）与可选 `details: unknown`；不要另造裸对象',
    '',
  )

  const runtime = plan.runtime ?? {}
  const runtimeRows: string[][] = []
  if (runtime.port !== undefined) runtimeRows.push(['端口', String(runtime.port)])
  if (runtime.start !== undefined) runtimeRows.push(['启动', runtime.start])
  if (runtime.health !== undefined) runtimeRows.push(['健康检查', runtime.health])
  if (runtime.migrate !== undefined) runtimeRows.push(['迁移', runtime.migrate])
  if (runtime.rollback !== undefined) runtimeRows.push(['回滚', runtime.rollback])
  lines.push('### 8.1 运行与部署', '')
  if (runtimeRows.length === 0) {
    lines.push('（未声明；实现者需在开工会上确认端口、启动命令、健康检查与迁移方式）', '')
  } else {
    lines.push(...table(['项', '内容'], runtimeRows), '')
  }

  const nfr = plan.globals.nfr ?? []
  lines.push('### 8.2 非功能要求', '')
  lines.push(...listOrNone(nfr), '')

  // 9
  lines.push('## 9 交付清单', '')
  const tree = plan.deliverables.tree.trim()
  lines.push('```text', tree.length > 0 ? plan.deliverables.tree.trimEnd() : '（无）', '```', '')
  lines.push(...table(['文件', '用途'], plan.deliverables.files.map((file) => [file.path, file.purpose])), '')

  const pages = plan.ui ?? []
  lines.push('## 10 界面（页面级）', '')
  if (pages.length === 0) {
    lines.push('（未声明；需要界面时在 plan 里加 ui[]，写明每页展示什么、调用哪条已声明路由）', '')
  } else {
    lines.push(
      ...table(
        ['页面', '路由', '归属模块', '调用'],
        pages.map((page) => [`${page.id} ${page.title}`, page.route, page.module, page.calls.length === 0 ? '（无）' : page.calls.join('；')]),
      ),
      '',
    )
    for (const page of pages) {
      const details: string[] = []
      details.push(`展示：${page.shows.join('；')}`)
      if (page.states?.empty !== undefined) details.push(`空态：${page.states.empty}`)
      if (page.states?.error !== undefined) details.push(`错误态：${page.states.error}`)
      if (page.notes !== undefined) details.push(`备注：${page.notes}`)
      lines.push(`- **${page.id} ${page.title}**（${page.route}）：${details.join('　')}`)
    }
    lines.push('')
  }

  lines.push('## 附录 A 未决问题', '')
  lines.push(...listOrNone(plan.openQuestions ?? []), '')

  lines.push('> 本文由 dsh-impl-gate 从 compose-plan.json 生成，改契约请改 plan 后重跑 materialize。')
  return `${lines.join('\n')}\n`
}
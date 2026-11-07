// G3: deterministic per-module task cards built only from compose-plan.json.
// No timestamps, no ordering that depends on the filesystem, no invented content.
import type { Plan } from '../compose/plan.js'
import type { Wave, WaveOverlap } from './waves.js'

type Module = Plan['modules'][number]

export interface CardTarget {
  moduleId: string
  wave: number
  cardPath: string
}

export interface CardRenderOptions {
  implRoot?: string
  outDir?: string
}

const NONE = '（无）'

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** `wave-1/M1-shared.md`; nested dirs are flattened with `-`. */
export function cardPathOf(module: Module, wave: number): string {
  const flat = module.dir.split(/[\\/]+/).filter(Boolean).join('-')
  return `wave-${wave}/${module.id}-${flat}.md`
}

function withPrefix(file: string, implRoot?: string): string {
  const root = (implRoot ?? '').trim().replace(/[\\/]+$/, '')
  return root.length === 0 ? file : `${root}/${file}`
}

function rootText(options: CardRenderOptions): string {
  const implRoot = (options.implRoot ?? '').trim().replace(/[\\/]+$/, '')
  if (implRoot.length > 0) return implRoot
  const outDir = (options.outDir ?? '').trim().replace(/[\\/]+$/, '')
  return outDir.length > 0 ? `本任务包所在目录 ${outDir}` : '本任务包所在目录'
}

function exposeText(provider: Module | undefined, item: string): string {
  if (provider === undefined) return item
  const found = provider.exposes.find((expose) => expose.signature === item || expose.note === item)
  return found?.signature ?? item
}

/** One card, nine fixed sections in fixed order. Empty sections say （无）. */
export function renderTaskCard(plan: Plan, module: Module, wave: Wave, options: CardRenderOptions = {}): string {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]))
  const lines: string[] = [
    `# ${module.title}（${module.id} · ${module.dir}）`,
    `> 波次 ${wave.index}；前置：${wave.dependsOn.length > 0 ? wave.dependsOn.join('、') : '无'}；卡片由 dsh-impl-gate 从 compose-plan.json 生成，改需求请改 plan 重跑，不要手改本卡。`,
    '',
    '## 1 你负责什么',
    '',
    module.responsibility,
    '',
    '## 2 文件白名单',
    '',
    '只允许新建或修改以下文件，越界即失败：',
    '',
    `以下路径相对 ${rootText(options)}。往 graphRoot 里写文件视为失败：契约目录只读，实现产物只放 ${rootText(options)}。`,
    '',
  ]
  if (module.files.length === 0) {
    lines.push(`- ${NONE}`)
  } else {
    for (const file of module.files) lines.push(`- ${withPrefix(file, options.implRoot)}`)
  }
  lines.push('', '## 3 你要提供的契约', '')
  if (module.exposes.length === 0) {
    lines.push(NONE, '', '本模块不对外提供契约。')
  } else {
    lines.push('每条一行，签名必须与文本完全一致（下游按此调用）：', '')
    for (const expose of module.exposes) lines.push(`- \`${expose.signature}\``)
  }
  lines.push('', '## 4 你依赖的契约', '')
  if (module.requires.length === 0) {
    lines.push(NONE, '', '本模块可独立开工。')
  } else {
    lines.push('| 来自 | 条目 | 它的签名 | 怎么用 |', '|---|---|---|---|')
    for (const need of module.requires) {
      const provider = byId.get(need.module)
      const from = provider === undefined ? need.module : `${provider.id}/${provider.dir}`
      lines.push(`| ${from} | ${need.item} | ${exposeText(provider, need.item)} | 按签名调用，不要复制其实现 |`)
    }
  }
  lines.push('', '## 5 约束', '')
  if (module.constraints.length === 0) {
    lines.push(`- ${NONE}`)
  } else {
    for (const constraint of module.constraints) lines.push(`- ${constraint}`)
  }
  lines.push('', '## 6 验收断言', '')
  const globalAcceptance = (plan as Plan & { acceptance?: Array<{ id?: string; assertion?: string }> }).acceptance ?? []
  if (module.acceptance.length === 0 && globalAcceptance.length === 0) {
    lines.push(NONE)
  } else {
    lines.push('| 编号 | 断言 |', '|---|---|')
    module.acceptance.forEach((entry, index) => {
      lines.push(`| AC-${module.id}-${index + 1} | ${entry.assertion} |`)
    })
    globalAcceptance.forEach((entry, index) => {
      lines.push(`| AC-G-${index + 1} | ${entry.assertion ?? ''} |`)
    })
  }
  lines.push(
    '',
    '## 7 完成标准',
    '',
    '- 上面的断言全部能用命令行或脚本复现；',
    '- 至少一条证据是“实际执行的命令 + 输出”，不允许只写“已实现”；',
    '- 你写的文件全部落在第 2 节白名单内。',
    '',
    '## 8 回报格式',
    '',
    '按五段写：做了什么 / 证据（命令+输出） / 结论 / 未决问题 / 下一步。',
    '',
    '## 9 禁止',
    '',
    '- 不修改其他模块的文件、不修改 graphRoot 下的契约文件；',
    '- 不新增白名单外的文件（含临时脚本，需放 /tmp 或仓库根 _probe）；',
    '- 不往 graphRoot 或 tasks/ 目录里写实现代码。',
    '- 不把验收断言改成更容易通过的形式；断言写错了，回报里提出，不要私自改。',
    '',
  )
  return lines.join('\n')
}

function bulletList(values: string[]): string[] {
  if (values.length === 0) return [`- ${NONE}`]
  return values.map((value) => `- ${value}`)
}

/** The tasks/ control board. Waves come straight from computeWaves(). */
export function renderTasksDoc(plan: Plan, waves: Wave[], overlaps: WaveOverlap[], cards: CardTarget[]): string {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]))
  const cardByModule = new Map(cards.map((card) => [card.moduleId, card.cardPath]))
  const lines: string[] = [
    `# ${plan.title} · 任务卡`,
    '',
    '## 0 怎么用',
    '',
    '按波次推进；同波次可并行；每波全部 PASS 再进下一波。',
    '',
    '## 1 波次表',
    '',
    '| 波次 | 可并行模块 | 卡片 | 前置波次 |',
    '|---|---|---|---|',
  ]
  for (const wave of waves) {
    const links = wave.modules
      .map((id) => {
        const cardPath = cardByModule.get(id) ?? ''
        return `[${cardPath.split('/').pop() ?? id}](${cardPath})`
      })
      .join('<br>')
    lines.push(`| ${wave.index} | ${wave.modules.join('<br>')} | ${links} | ${wave.dependsOn.length > 0 ? wave.dependsOn.join('、') : '无'} |`)
  }
  lines.push('', '## 2 并行分组', '')
  for (const wave of waves) {
    const mode = wave.modules.length === 1 ? '（独立）' : '（可并行）'
    lines.push(`- 波次 ${wave.index}：${wave.modules.join('、')}${mode}`)
  }
  if (overlaps.length > 0) {
    lines.push('')
    for (const overlap of overlaps) {
      for (const file of overlap.files) {
        lines.push(`${overlap.a} 与 ${overlap.b} 都写 ${file} —— 必须串行或拆分文件`)
      }
    }
  }
  lines.push('', '## 3 全局约定', '', '### conventions', '')
  lines.push(...bulletList(plan.globals.conventions))
  lines.push('', '### forbidden', '')
  lines.push(...bulletList(plan.globals.forbidden))
  lines.push('', '### envKeys', '')
  lines.push(...bulletList(plan.globals.envKeys ?? []))
  lines.push('', '## 4 验收汇总', '', '| 模块 | 断言数 | 卡片 |', '|---|---|---|')
  for (const module of plan.modules) {
    const cardPath = cardByModule.get(module.id) ?? ''
    lines.push(`| ${module.id} ${oneLine(module.title)} | ${module.acceptance.length} | [${cardPath.split('/').pop() ?? module.id}](${cardPath}) |`)
  }
  lines.push('', '## 5 生成说明', '', '> 由 compose-plan.json 生成；重跑会覆盖本目录。', '')
  // Keep the control board honest: every card target must point at a real module.
  for (const card of cards) {
    if (!byId.has(card.moduleId)) throw new Error(`card for unknown module ${card.moduleId}`)
  }
  return lines.join('\n')
}

export interface CardsJson {
  schemaVersion: 1
  planName: string
  waves: Array<{
    index: number
    modules: Array<{ id: string; dir: string; title: string; cardPath: string; files: string[] }>
  }>
  overlaps: WaveOverlap[]
}

/** Machine-readable manifest; key order is fixed by construction. */
export function buildCardsJson(plan: Plan, waves: Wave[], overlaps: WaveOverlap[], cards: CardTarget[]): CardsJson {
  const byId = new Map(plan.modules.map((entry) => [entry.id, entry]))
  const cardByModule = new Map(cards.map((card) => [card.moduleId, card.cardPath]))
  return {
    schemaVersion: 1,
    planName: plan.name,
    waves: waves.map((wave) => ({
      index: wave.index,
      modules: wave.modules.map((id) => {
        const module = byId.get(id)
        if (module === undefined) throw new Error(`wave references unknown module ${id}`)
        return {
          id: module.id,
          dir: module.dir,
          title: module.title,
          cardPath: cardByModule.get(id) ?? '',
          files: [...module.files],
        }
      }),
    })),
    overlaps,
  }
}
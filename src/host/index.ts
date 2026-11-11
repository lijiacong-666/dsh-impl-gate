// Host entry: runs in the DSH Node process. Bundled to lib/index.js as ESM.
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildTools } from './tools.js'

export { buildTools } from './tools.js'
// Exported for unit tests that must not spawn specgraph (A4 set rules).
export { auditChecklist, parseChecklist } from './checklist.js'
// Exported for unit tests of the cached-run selectors (report / verify_contract).
export { buildReport, buildVerifyContract, coverageStatement, reportMarkdown, rememberRun, runCheck, buildCompose, buildInit, composeReview, reviewSummary, compareReviewAndEvidence, distributionReadiness, implementationEvidence } from './tools.js'
// Exported for unit tests of the compose plan schema (G1) without a host.
export { emptyPlan, missingSlots, validatePlan, stripMeta } from './compose/plan.js'
export { renderDraft } from './compose/draft.js'
export { renderGraphToml, renderModuleSpec, findExposeIndex } from './compose/graph.js'
export { renderSpecDoc } from './compose/spec-doc.js'
export { isRunRecord, materializePlan } from './compose/materialize.js'
export { collectWarnings } from './compose/materialize.js'
export { recordReview } from './review/review.js'
export { recordAcceptance, renderEvidenceDoc, runnerOf, AC_EVIDENCE_REL, TASKS_EVIDENCE_REL } from './record/record.js'
export type { ReviewPayload, ReviewVerdict, ReviewStatus } from './review/review.js'
// Exported for unit tests of the B5/Q10 edge cases (need-free modules, broken graph).
export { checkB5 } from './assertions/delivery.js'
export { checkQ10 } from './assertions/q10.js'

export type { EvidenceItem, EvidenceStatus, RecordOptions, RecordOutcome, RecordPayload, RecordSummary } from './record/record.js'
export { renderChecklistTemplate, mergeChecklist, CHECKLIST_REL } from './compose/checklist-template.js'
export { renderMappingTemplate, MAPPING_REL } from './compose/mapping-template.js'
export { loadChecks, checksFilePath } from './checks.js'
export { resolveSpecgraphEnv, preflightSpecgraph, findSpecgraphHome } from './specgraph.js'
export { computeWaves } from './init/waves.js'
export { initTasks } from './init/init.js'
export { renderTaskCard, renderTasksDoc, buildCardsJson, cardPathOf } from './init/cards.js'
// Exported for unit tests of the Step 5 replay gate (no config toggle needed).
export { makeReplayCheck, parseReplayEvidence } from './assertions/exec.js'
// Exported for unit tests of A2/A3 checklist validation.
export { checkA2, checkA3 } from './assertions/input.js'

export const name = __PLUGIN_NAME__

// `tools` is the only service this plugin needs; everything else is optional.
export const inject: string[] = ['tools']

export interface Config {
  enabled: boolean
  specgraphCommand: string
  pythonPath: string
  specgraphCwd: string
  timeoutMs: number
  implRoot: string
  allowCommandReplay: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('Enable the plugin.'),
  specgraphCommand: z.string().default('python -m specgraph').description('specgraph 命令；默认 python -m specgraph。'),
  pythonPath: z.string().default('').description('替换命令首个 python 词元；为空表示用 PATH 里的 python。'),
  specgraphCwd: z.string().default('').description('运行 specgraph 子进程的工作目录；源码方式安装时指向 spec-graph 仓库。'),
  timeoutMs: z.number().default(30000).description('单次 specgraph 调用超时（毫秒）。'),
  implRoot: z.string().default('').description('实现根目录缺省值；为空时使用 graphRoot。'),
  allowCommandReplay: z
    .boolean()
    .default(false)
    .description('是否允许按证据命令重放 M/Q 断言（Step 5，默认关闭）。'),
})

interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
  execute: (args: unknown) => Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: { register(tool: RegisteredTool): (() => void) | void }
  }
}

export function apply(ctx: Context, config: Config) {
  if (!config.enabled) return

  const deps = {
    config: {
      specgraphCommand: config.specgraphCommand,
      pythonPath: config.pythonPath,
      specgraphCwd: config.specgraphCwd,
      timeoutMs: config.timeoutMs,
      implRoot: config.implRoot,
      allowCommandReplay: config.allowCommandReplay,
    },
  }

  ctx.effect(() => {
    const disposers = buildTools(deps).map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
  })
}

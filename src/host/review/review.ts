// Review trace: reviewers judge each module "can we start?" and the judgement
// has to survive the conversation it happened in.
//
// The file is append-only by round: `.impl-gate/review.json`
// `{ schemaVersion: 1, rounds: [{ round, reviewer, at, verdicts, summary }] }`.
// Nothing here writes SPEC.md or the graph; a review is evidence, not content.

import fs from 'node:fs'
import path from 'node:path'

import { validatePlan, type Plan } from '../compose/plan.js'

export type ReviewStatus = 'ready' | 'clarify' | 'blocked'

export interface ReviewVerdict {
  module: string
  status: ReviewStatus
  note?: string
  blocking?: string[]
}

export interface ReviewPayload {
  ok: true
  reviewPath: string
  round: number
  ready: number
  clarify: number
  blocked: number
  blocking: number
  total: number
}

export interface ReviewFailure {
  ok: false
  error: { code: string; message: string; detail?: string }
}

export type ReviewOutcome = ReviewPayload | ReviewFailure

export interface ReviewInput {
  reviewer: string
  round?: number
  verdicts: ReviewVerdict[]
}

interface StoredRound {
  round: number
  reviewer: string
  at: string
  verdicts: ReviewVerdict[]
  summary: { ready: number; clarify: number; blocked: number; blocking: number }
}

interface StoredFile {
  schemaVersion: 1
  rounds: StoredRound[]
}

const REVIEW_REL = path.join('.impl-gate', 'review.json')

function failure(code: string, message: string, detail?: string): ReviewFailure {
  const out: ReviewFailure = { ok: false, error: { code, message } }
  if (detail !== undefined) out.error.detail = detail
  return out
}

function readPlan(outDir: string): Plan | ReviewFailure {
  const planPath = path.join(outDir, 'compose-plan.json')
  let text: string
  try {
    text = fs.readFileSync(planPath, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return failure('PLAN_MISSING', `compose-plan.json not found in ${outDir}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return failure('PLAN_INVALID', `compose-plan.json is not valid JSON: ${(error as Error).message}`)
  }
  const validation = validatePlan(raw)
  if (validation.plan === null) {
    const first = validation.problems[0]
    return failure('PLAN_INVALID', first === undefined ? 'compose-plan.json failed validation' : `${first.path} ${first.message}`)
  }
  return validation.plan
}

function readStored(reviewPath: string): StoredFile {
  try {
    const text = fs.readFileSync(reviewPath, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text) as Partial<StoredFile>
    if (Array.isArray(parsed.rounds)) return { schemaVersion: 1, rounds: parsed.rounds as StoredRound[] }
  } catch {
    // missing or corrupt: start a fresh file, the caller sees the new round only
  }
  return { schemaVersion: 1, rounds: [] }
}

const STATUSES = new Set<ReviewStatus>(['ready', 'clarify', 'blocked'])

/** Appends one review round; never rewrites earlier rounds. */
export function recordReview(outDirRaw: string, input: ReviewInput): ReviewOutcome {
  const outDir = path.resolve(outDirRaw)
  if (!fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) {
    return failure('E_ROOT_MISSING', `outDir does not exist: ${outDir}`)
  }

  const plan = readPlan(outDir)
  if ('ok' in plan) return plan

  const reviewer = (input.reviewer ?? '').trim()
  if (reviewer === '') return failure('REVIEW_INVALID', 'reviewer must be a non-empty string')

  const verdicts = input.verdicts ?? []
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    return failure('REVIEW_INVALID', 'verdicts must list at least one module')
  }

  const known = new Set(plan.modules.map((module) => module.id))
  const seen = new Set<string>()
  for (const [index, verdict] of verdicts.entries()) {
    const module = typeof verdict.module === 'string' ? verdict.module.trim() : ''
    if (!known.has(module)) {
      return failure('REVIEW_MODULE_UNKNOWN', `verdict ${index} names module "${module}", which is not in compose-plan.json`)
    }
    if (seen.has(module)) return failure('REVIEW_INVALID', `module "${module}" appears twice in one round`)
    seen.add(module)
    if (!STATUSES.has(verdict.status)) {
      return failure('REVIEW_INVALID', `verdict ${index} status must be ready, clarify or blocked`)
    }
  }

  const reviewPath = path.join(outDir, REVIEW_REL)
  const stored = readStored(reviewPath)
  const nextRound = input.round ?? stored.rounds.length + 1
  if (stored.rounds.some((entry) => entry.round === nextRound)) {
    return failure('REVIEW_ROUND_EXISTS', `round ${nextRound} already recorded; pass a new round number`)
  }

  const summary = {
    ready: verdicts.filter((entry) => entry.status === 'ready').length,
    clarify: verdicts.filter((entry) => entry.status === 'clarify').length,
    blocked: verdicts.filter((entry) => entry.status === 'blocked').length,
    blocking: verdicts.reduce((sum, entry) => sum + (entry.blocking?.length ?? 0), 0),
  }

  stored.rounds.push({
    round: nextRound,
    reviewer,
    at: new Date().toISOString(),
    verdicts: verdicts.map((entry) => ({
      module: entry.module.trim(),
      status: entry.status,
      ...(entry.note === undefined ? {} : { note: entry.note }),
      ...(entry.blocking === undefined ? {} : { blocking: entry.blocking }),
    })),
    summary,
  })
  stored.rounds.sort((a, b) => a.round - b.round)

  try {
    fs.mkdirSync(path.dirname(reviewPath), { recursive: true })
    fs.writeFileSync(reviewPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  } catch (error) {
    return failure('REVIEW_WRITE_FAILED', `could not write ${reviewPath}: ${(error as Error).message}`)
  }

  return {
    ok: true,
    reviewPath,
    round: nextRound,
    total: plan.modules.length,
    ...summary,
  }
}
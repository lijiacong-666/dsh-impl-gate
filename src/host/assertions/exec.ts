// Step 5 replay gate for M/Q items: judgeable only by re-running the evidence
// command. Default OFF (D-09); when ON, at most five commands per run, cwd pinned
// to implRoot, timeout 120s, first token limited to python/pnpm/node.
import { basename } from 'node:path'

import { splitCommand } from '../specgraph.js'
import type { Assertion, AssertionOutcome } from './types.js'

const REPLAY_TIMEOUT_MS = 120_000
const REPLAY_LIMIT = 5

const ALLOWED = [/^python(\d+(\.\d+)*)?(\.exe)?$/i, /^pnpm(\.cmd|\.exe)?$/i, /^node(\.exe)?$/i]

function firstTokenAllowed(token: string): boolean {
  return ALLOWED.some((pattern) => pattern.test(basename(token)))
}

interface ParsedEvidence {
  command: string
  exitCode: number
}

export function parseReplayEvidence(evidence: string): ParsedEvidence | undefined {
  const match = /^command:\s*(.+?)(?:;\s*exit:\s*(-?\d+))?\s*$/s.exec(evidence)
  if (!match) return undefined
  const command = match[1] ?? ''
  return { command: command.trim(), exitCode: match[2] === undefined ? 0 : Number(match[2]) }
}

export function makeReplayCheck(id: string): Assertion {
  return async (ctx): Promise<AssertionOutcome> => {
    if (!ctx.allowCommandReplay) {
      return { status: 'NOT-RUN', reason: 'EXEC_DISABLED', evidence: `allowCommandReplay=false; id=${id}` }
    }
    const row = ctx.checklist.rows.get(id)
    if (!row) {
      return { status: 'NOT-RUN', reason: 'CHECKLIST_NOT_PROVIDED', evidence: `no checklist row for ${id}` }
    }
    const parsed = parseReplayEvidence(row.evidence)
    if (!parsed) {
      return { status: 'NOT-RUN', reason: 'EVIDENCE_TOKEN_UNSPECIFIED', evidence: `row ${id} evidence is not a command` }
    }
    if (/<[^>]+>/.test(parsed.command)) {
      return {
        status: 'NOT-RUN',
        reason: 'EVIDENCE_TOKEN_UNSPECIFIED',
        evidence: `row ${id} command contains a <placeholder>; skipped`,
      }
    }
    const argv = splitCommand(parsed.command)
    const first = argv[0]
    if (first === undefined || !firstTokenAllowed(first)) {
      return {
        status: 'NOT-RUN',
        reason: 'EVIDENCE_TOKEN_UNSPECIFIED',
        evidence: `row ${id} first token not allowed: ${argv[0] ?? '(empty)'}`,
      }
    }
    if (ctx.replayBudget.remaining <= 0) {
      return {
        status: 'NOT-RUN',
        reason: 'EXEC_DISABLED',
        evidence: `skipped=replay_budget_exhausted limit=${REPLAY_LIMIT}`,
      }
    }
    ctx.replayBudget.remaining -= 1
    try {
      const out = await ctx.runImpl(argv)
      const head = (out.stdout || out.stderr).trim().split(/\r?\n/)[0]?.slice(0, 200) ?? ''
      if (out.exitCode === parsed.exitCode) {
        return { status: 'PASS', evidence: `cmd=${parsed.command}; expected=${parsed.exitCode}; actual=${out.exitCode}` }
      }
      return {
        status: 'FAIL',
        evidence: `cmd=${parsed.command}; exit_db=${parsed.exitCode}; run_again=${out.exitCode}; combined_head=${out.stderr || head}`,
      }
    } catch (error) {
      const err = error as Error & { code?: string }
      if (err.code === 'E_TIMEOUT' || /timeout|did not finish within/i.test(err.message)) {
        return {
          status: 'FAIL',
          evidence: `cmd=${parsed.command}; expected=${parsed.exitCode}; timeout=${REPLAY_TIMEOUT_MS}ms; spawn_error=${err.message}`,
        }
      }
      return {
        status: 'FAIL',
        evidence: `cmd=${parsed.command}; expected=${parsed.exitCode}; spawn_error=${err.message}`,
      }
    }
  }
}

export const replayMeta = { timeoutMs: REPLAY_TIMEOUT_MS, limit: REPLAY_LIMIT }
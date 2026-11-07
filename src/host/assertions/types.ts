// One assertion implementation = one entry in the mapping table.
// Every id in checks/impl-gate.checks.json must have a landing here; ids whose
// landing is still a stub are reported as NOT-RUN with NOT_IMPLEMENTED.
import type { CheckItem } from '../checks.js'
import type { ChecklistParse } from '../checklist.js'
import type { RunOutput } from '../specgraph.js'

export type AssertionStatus = 'PASS' | 'FAIL' | 'NOT-RUN'

export interface AssertionOutcome {
  status: AssertionStatus
  evidence: string
  reason?: string
}

export interface AssertionContext {
  graphRoot: string
  implRoot: string
  slow: boolean
  timeoutMs: number
  checks: CheckItem[]
  checklist: ChecklistParse
  preGraphHashes: Record<string, string>
  /** Auto-detected specgraph source root (D-06); '' when specgraphCwd is set or nothing was found. */
  specgraphHome: string
  /** Step 5 gate: only replay evidence commands when explicitly enabled (D-09). */
  allowCommandReplay: boolean
  /** Shared across one run: at most five replayed commands (Step 5 rule). */
  replayBudget: { remaining: number }
  run: (args: string[]) => Promise<RunOutput>
  runArgv: (argv: string[]) => Promise<RunOutput>
  /** Runs a command with cwd pinned to implRoot and the 120s replay timeout. */
  runImpl: (argv: string[]) => Promise<RunOutput>
  hashGraph: () => Promise<Record<string, string>>
  newTempDir: (prefix: string) => Promise<string>
}

export type Assertion = (ctx: AssertionContext) => Promise<AssertionOutcome>
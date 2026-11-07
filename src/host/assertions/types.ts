// One assertion implementation = one entry in the mapping table.
// Every id in checks/impl-gate.checks.json must have a landing here; ids whose
// landing is still a stub are reported as NOT-RUN with NOT_IMPLEMENTED.
import type { CheckItem } from '../checks.js'
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
  run: (args: string[]) => Promise<RunOutput>
  newTempDir: (prefix: string) => Promise<string>
}

export type Assertion = (ctx: AssertionContext) => Promise<AssertionOutcome>
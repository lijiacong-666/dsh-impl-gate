// Q10 退出码契约 — 0 = pass, 1 = errors in the graph, 2 = usage error.
// Three runs: the real graph, a deliberately broken temp copy, and a bad flag.
import fs from 'node:fs'
import path from 'node:path'
import type { Assertion, AssertionContext, AssertionOutcome } from './types.js'

async function firstSpecFile(root: string): Promise<string | null> {
  const walk = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > 6) return null
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    const spec = entries.find((entry) => entry.isFile() && entry.name === 'spec.md')
    if (spec !== undefined) return path.join(dir, 'spec.md')
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const found = await walk(path.join(dir, entry.name), depth + 1)
      if (found !== null) return found
    }
    return null
  }
  return walk(root, 0)
}

export const checkQ10: Assertion = async (ctx: AssertionContext): Promise<AssertionOutcome> => {
  const observations: string[] = []
  const tempRoot = await ctx.newTempDir('impl-gate-q10-')
  try {
    const valid = await ctx.run(['check', ctx.graphRoot, '--json'])
    observations.push(`valid_exit=${valid.exitCode} expected=0`)

    const broken = path.join(tempRoot, 'broken')
    await fs.promises.cp(ctx.graphRoot, broken, { recursive: true })
    const victim = await firstSpecFile(broken)
    if (victim === null) {
      return { status: 'FAIL', evidence: 'broken_copy_has_no_spec.md_to_remove' }
    }
    await fs.promises.rm(victim, { force: true })
    const invalid = await ctx.run(['check', broken, '--json'])
    observations.push(`broken_exit=${invalid.exitCode} expected=1`)

    const usage = await ctx.run(['check', '--definitely-not-a-flag'])
    observations.push(`usage_exit=${usage.exitCode} expected=2`)

    const ok = valid.exitCode === 0 && invalid.exitCode === 1 && usage.exitCode === 2
    return { status: ok ? 'PASS' : 'FAIL', evidence: observations.join(' ') }
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true })
  }
}
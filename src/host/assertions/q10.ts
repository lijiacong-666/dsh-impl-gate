// Q10 退出码契约 — 0 = pass, 1 = errors in the graph, 2 = usage error.
// Three runs: the real graph, a deliberately broken temp copy, and a bad flag.
import fs from 'node:fs'
import path from 'node:path'
import type { Assertion, AssertionContext, AssertionOutcome } from './types.js'

export const checkQ10: Assertion = async (ctx: AssertionContext): Promise<AssertionOutcome> => {
  const observations: string[] = []
  const tempRoot = await ctx.newTempDir('impl-gate-q10-')
  try {
    const valid = await ctx.run(['check', ctx.graphRoot, '--json'])
    observations.push(`valid_exit=${valid.exitCode} expected=0`)

    const broken = path.join(tempRoot, 'broken')
    await fs.promises.cp(ctx.graphRoot, broken, { recursive: true })
    // 删 spec.md 在单节点图上不一定制造错误（没有 spec.md 的目录会被跳过），
    // 所以直接把 graph.toml 写成非法 TOML：保证解析失败、退出码 1。
    await fs.promises.writeFile(path.join(broken, 'graph.toml'), '[[link]\n', 'utf8')
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
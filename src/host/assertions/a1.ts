// A1 输入成对校验 — instruction package md and manifest describe the same
// module set and the same contract item ids.
// Missing package: export once into a temp directory (B Step 2), then compare.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Assertion, AssertionContext, AssertionOutcome } from './types.js'

interface PackagePair {
  mdFile: string
  jsonFile: string
}

interface ParsedMd {
  modules: Set<string>
  items: Set<string>
}

interface ParsedManifest {
  modules: Set<string>
  items: Set<string>
}

function setDiff(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort()
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

async function findNodeDirs(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 6) return
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    if (rel.length > 0 && entries.some((entry) => entry.isFile() && entry.name === 'spec.md')) {
      found.push(rel)
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      await walk(path.join(dir, entry.name), rel.length > 0 ? `${rel}/${entry.name}` : entry.name, depth + 1)
    }
  }
  await walk(root, '', 0)
  return found.sort()
}

/** Reads the pair of files an `export --out` run produced. */
async function findPair(outDir: string): Promise<PackagePair | null> {
  let entries: string[]
  try {
    entries = await fs.promises.readdir(outDir)
  } catch {
    return null
  }
  const mdFile = entries.find((name) => name.endsWith('指令包.md'))
  const jsonFile = entries.find((name) => name.endsWith('manifest.json'))
  if (mdFile === undefined || jsonFile === undefined) return null
  return { mdFile: path.join(outDir, mdFile), jsonFile: path.join(outDir, jsonFile) }
}

export function parseInstructionMd(md: string): ParsedMd {
  const modules = new Set<string>()
  const items = new Set<string>()

  const title = /^# 实现指令包 · (.+)$/m.exec(md)
  if (title?.[1] !== undefined) modules.add(title[1].trim())
  for (const match of md.matchAll(/由 `([^`]+)` 的/g)) {
    if (match[1] !== undefined) modules.add(match[1].trim())
  }

  // "### E1 支付受理" headings: the target contract's own items.
  for (const match of md.matchAll(/^### ([A-Z]\d+)\b/gm)) {
    if (match[1] !== undefined) items.add(match[1])
  }
  // ```text fenced blocks: provider contract fragments and the constraint recap.
  for (const block of md.matchAll(/```text\r?\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? '').split(/\r?\n/)) {
      const item = /^([A-Z]\d+)\s/.exec(line)
      if (item?.[1] !== undefined) items.add(item[1])
    }
  }
  return { modules, items }
}

interface ManifestLike {
  name?: unknown
  target?: unknown
  contract?: unknown
  dependencies?: unknown
}

export function parseManifest(raw: string): ParsedManifest {
  const manifest = JSON.parse(raw) as ManifestLike
  const modules = new Set<string>()
  const items = new Set<string>()

  for (const value of [manifest.name, manifest.target]) {
    if (typeof value === 'string' && value.length > 0) modules.add(value)
  }
  const contract = (manifest.contract ?? {}) as Record<string, unknown>
  for (const key of ['exposes', 'needs', 'constraints']) {
    const section = contract[key]
    if (!Array.isArray(section)) continue
    for (const item of section as Array<{ id?: unknown }>) {
      if (typeof item?.id === 'string') items.add(item.id)
    }
  }
  const dependencies = Array.isArray(manifest.dependencies) ? (manifest.dependencies as Array<Record<string, unknown>>) : []
  for (const dependency of dependencies) {
    for (const key of ['provider_name', 'provider', 'link_to']) {
      const value = dependency[key]
      if (typeof value === 'string' && value.length > 0) modules.add(value)
    }
    const expose = dependency.expose as { id?: unknown } | undefined
    if (typeof expose?.id === 'string') items.add(expose.id)
    const constraints = dependency.provider_constraints
    if (Array.isArray(constraints)) {
      for (const item of constraints as Array<{ id?: unknown }>) {
        if (typeof item?.id === 'string') items.add(item.id)
      }
    }
  }
  return { modules, items }
}

function describePair(rel: string, md: ParsedMd, manifest: ParsedManifest, mdText: string, jsonText: string): {
  ok: boolean
  line: string
} {
  const moduleDiffA = setDiff(md.modules, manifest.modules)
  const moduleDiffB = setDiff(manifest.modules, md.modules)
  const itemDiffA = setDiff(md.items, manifest.items)
  const itemDiffB = setDiff(manifest.items, md.items)
  const ok = moduleDiffA.length === 0 && moduleDiffB.length === 0 && itemDiffA.length === 0 && itemDiffB.length === 0
  const parts = [
    `node=${rel}`,
    `modules=${md.modules.size}/${manifest.modules.size}`,
    `items=${md.items.size}/${manifest.items.size}`,
    `md_sha256=${sha256(mdText)}`,
    `manifest_sha256=${sha256(jsonText)}`,
  ]
  if (!ok) {
    parts.push(
      `modules_only_md=[${moduleDiffA.join(',')}]`,
      `modules_only_manifest=[${moduleDiffB.join(',')}]`,
      `items_only_md=[${itemDiffA.join(',')}]`,
      `items_only_manifest=[${itemDiffB.join(',')}]`,
    )
  }
  return { ok, line: parts.join(' ') }
}

export const checkA1: Assertion = async (ctx: AssertionContext): Promise<AssertionOutcome> => {
  const nodes = await findNodeDirs(ctx.graphRoot)
  if (nodes.length === 0) {
    return { status: 'NOT-RUN', evidence: '', reason: 'MISSING_INSTRUCTION_PACKAGE' }
  }

  const tempRoot = await ctx.newTempDir('impl-gate-a1-')
  const lines: string[] = []
  const problems: string[] = []
  try {
    for (const [index, rel] of nodes.entries()) {
      const outDir = path.join(tempRoot, `pkg-${index}`)
      const result = await ctx.run(['export', rel, '--root', ctx.graphRoot, '--out', outDir])
      if (result.exitCode !== 0) {
        problems.push(`node=${rel} export_exit=${result.exitCode} stderr=${result.stderr.trim().slice(-300)}`)
        continue
      }
      const pair = await findPair(outDir)
      if (pair === null) {
        problems.push(`node=${rel} export_produced_no_package_pair`)
        continue
      }
      const [mdText, jsonText] = await Promise.all([
        fs.promises.readFile(pair.mdFile, 'utf8'),
        fs.promises.readFile(pair.jsonFile, 'utf8'),
      ])
      const md = parseInstructionMd(mdText)
      const manifest = parseManifest(jsonText)
      const described = describePair(rel, md, manifest, mdText, jsonText)
      lines.push(described.line)
      if (!described.ok) problems.push(described.line)
    }
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true })
  }

  if (problems.length > 0) {
    return { status: 'FAIL', evidence: problems.join(' | ') }
  }
  return { status: 'PASS', evidence: `${lines.join(' | ')} specgraph_home=${ctx.specgraphHome || 'configured'}` }
}
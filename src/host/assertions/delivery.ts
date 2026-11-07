// B-group assertions (delivery discipline). Step 5 boundary (user m01090):
// B1/B2/B5/B7 are mechanically judgeable; B3/B4/B6 are fixed NOT-RUN.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Assertion, AssertionContext, AssertionOutcome } from './types.js'

const NOT_RUN = (reason: string, evidence: string): AssertionOutcome => ({ status: 'NOT-RUN', evidence, reason })

async function walkSpecs(root: string, depth = 0): Promise<Array<{ node: string; file: string }>> {
  if (depth > 6) return []
  const entries = await readdir(root, { withFileTypes: true })
  const found: Array<{ node: string; file: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const dir = join(root, entry.name)
    const specFile = join(dir, 'spec.md')
    try {
      await stat(specFile)
      found.push({ node: entry.name, file: specFile })
    } catch {
      /* not a node */
    }
    found.push(...(await walkSpecs(dir, depth + 1)))
  }
  return found
}

/** All `### Nx` ids under every `## 需要` section in the graph. */
async function collectNeeds(root: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const spec of await walkSpecs(root)) {
    const text = await readFile(spec.file, 'utf8')
    const section = text.split(/^## /m).find((part) => part.startsWith('需要'))
    if (!section) continue
    for (const match of section.matchAll(/^###\s+(N\d+)\b/gm)) {
      const id = match[1]
      if (id !== undefined) ids.add(id)
    }
  }
  return [...ids].sort()
}

function tableCells(line: string): string[] {
  return line.split('|').slice(1, -1).map((cell) => cell.trim())
}

interface MappingRow {
  need: string
  module: string
  item: string
}

async function readMapping(path: string): Promise<MappingRow[] | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  const headerIndex = lines.findIndex((line) => line.includes('|') && /需求\s*ID/i.test(line) && line.includes('模块'))
  if (headerIndex < 0) return []
  const headerLine = lines[headerIndex]
  if (headerLine === undefined) return []
  const header = tableCells(headerLine)
  const needIndex = header.findIndex((cell) => /需求\s*ID/i.test(cell))
  const moduleIndex = header.findIndex((cell) => cell.includes('模块'))
  const itemIndex = header.findIndex((cell) => cell.includes('条目'))
  const rows: MappingRow[] = []
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) continue
    const cells = tableCells(line)
    rows.push({
      need: cells[needIndex] ?? '',
      module: cells[moduleIndex] ?? '',
      item: cells[itemIndex] ?? '',
    })
  }
  return rows
}

const mappingPath = (ctx: AssertionContext) => join(ctx.implRoot, '.impl-gate', 'mapping.md')

export const checkB1: Assertion = async (ctx) => {
  const rows = await readMapping(mappingPath(ctx))
  if (rows === undefined) {
    return NOT_RUN('MAPPING_TABLE_NOT_PROVIDED', `missing: ${mappingPath(ctx)}`)
  }
  const needs = await collectNeeds(ctx.graphRoot)
  const covered = new Set(rows.map((row) => row.need))
  const missing = needs.filter((id) => !covered.has(id))
  const extra = [...covered].filter((id) => id !== '' && !needs.includes(id))
  if (missing.length > 0) {
    return {
      status: 'FAIL',
      evidence: `mapping=${mappingPath(ctx)} needs=${needs.length} covered=${needs.length - missing.length} missing=${missing.join(',') || '-'}`,
    }
  }
  return {
    status: 'PASS',
    evidence: `mapping=${mappingPath(ctx)} needs=${needs.length} covered=${needs.length} extra=${extra.length}`,
  }
}

export const checkB2: Assertion = async (ctx) => {
  if (!ctx.checklist.provided) {
    return NOT_RUN('CHECKLIST_NOT_PROVIDED', `missing: ${ctx.checklist.path}`)
  }
  const known = new Set(ctx.checks.map((item) => item.id))
  const declared = [...ctx.checklist.rows.keys()]
  const extra = declared.filter((id) => !known.has(id))
  if (extra.length > 0) {
    return {
      status: 'FAIL',
      evidence: `checklist_ids=${declared.length} checks_ids=${known.size} extra=${extra.join(',')}`,
    }
  }
  return {
    status: 'PASS',
    evidence: `checklist_ids=${declared.length} checks_ids=${known.size} extra=0`,
  }
}

export const checkB3: Assertion = async () =>
  NOT_RUN('EVIDENCE_TOKEN_UNSPECIFIED', '需人工检索测试名/注释中的 N/E/C 编号，工具不做语义检索（D-10）')

export const checkB5: Assertion = async (ctx) => {
  const rows = await readMapping(mappingPath(ctx))
  if (rows === undefined) {
    return NOT_RUN('MAPPING_TABLE_NOT_PROVIDED', `missing: ${mappingPath(ctx)}`)
  }
  const modules = new Set((await walkSpecs(ctx.graphRoot)).map((spec) => spec.node))
  const emptyCells = rows.filter((row) => row.module === '' || row.item === '')
  const unknown = rows.filter((row) => row.module !== '' && !modules.has(row.module)).map((row) => row.module)
  const seen = new Set(rows.map((row) => row.module).filter(Boolean))
  if (rows.length === 0 || emptyCells.length > 0 || unknown.length > 0) {
    return {
      status: 'FAIL',
      evidence: `rows=${rows.length} modules=${seen.size} empty_cells=${emptyCells.length} unknown=${unknown.join(',') || '-'}`,
    }
  }
  return {
    status: 'PASS',
    evidence: `rows=${rows.length} modules=${seen.size} per_module_min=1 empty_cells=0`,
  }
}

export const checkB6: Assertion = async () =>
  NOT_RUN('HUMAN_PROCESS_REQUIRED', '“失败即停”是流程约束，工具只产出结论；由人检查交付说明（D-10）')

export const checkB7: Assertion = async (ctx) => {
  if (!ctx.checklist.provided) {
    return NOT_RUN('CHECKLIST_NOT_PROVIDED', `missing: ${ctx.checklist.path}`)
  }
  const failed = [...ctx.checklist.rows.values()].filter((row) => row.status === 'FAIL')
  const missing = failed.filter((row) => !/repro\s*:/i.test(row.evidence)).map((row) => row.id)
  if (missing.length > 0) {
    return {
      status: 'FAIL',
      evidence: `fail_rows=${failed.length} with_repro=${failed.length - missing.length} missing=${missing.join(',')}`,
    }
  }
  return {
    status: 'PASS',
    evidence: `fail_rows=${failed.length} with_repro=${failed.length} missing=0`,
  }
}

export const checkB4: Assertion = async () => NOT_RUN('MANUAL_REVIEW_REQUIRED', '裁决记录由人工维护（B4 manual）')

// Loads the 32 IMPL-GATE assertions from checks/impl-gate.checks.json.
// The JSON file is the only source of the assertion list: no array of ids is
// ever hard-coded here (§8 forbid: "32 条只能来自 checks/impl-gate.checks.json").
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type CheckMode = 'auto' | 'manual' | 'notrun'
export type CheckRuntime = 'fast' | 'slow'

export interface CheckItem {
  id: string
  group: string
  title: string
  mode: CheckMode
  runtime: CheckRuntime
  requires: string[]
  notRunReason: string
  command: string
  assert: string
}

export interface ChecksFile {
  version: string
  items: CheckItem[]
}

// lib/index.js sits at <package>/lib/index.js, so the checks file is one level up.
export function checksFilePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'checks', 'impl-gate.checks.json')
}

export function loadChecks(): CheckItem[] {
  const file = checksFilePath()
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${file}: ${(error as Error).message}`)
  }
  const items = (parsed as ChecksFile | undefined)?.items
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${file} has no items array`)
  }
  return items
}
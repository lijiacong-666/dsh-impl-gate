// A5 support: SHA256 over the contract files that must never change during a
// gate run (`spec.md` everywhere under graphRoot, plus `graph.toml`).
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TARGET_NAMES = new Set(['spec.md', 'graph.toml'])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-dev', '.impl-gate'])

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 12) return
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, depth + 1, out)
    } else if (entry.isFile() && TARGET_NAMES.has(entry.name)) {
      out.push(full)
    }
  }
}

export async function hashContractFiles(root: string): Promise<Record<string, string>> {
  const files: string[] = []
  await walk(root, 0, files)
  const hashes: Record<string, string> = {}
  for (const file of files) {
    try {
      const digest = createHash('sha256').update(await fs.promises.readFile(file)).digest('hex')
      hashes[path.relative(root, file).split(path.sep).join('/')] = digest.slice(0, 16)
    } catch {
      hashes[path.relative(root, file).split(path.sep).join('/')] = 'unreadable'
    }
  }
  return hashes
}
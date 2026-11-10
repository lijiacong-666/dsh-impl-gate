// B5: a graph whose modules have no needs must not fail just because mapping has no rows.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkB5 } from '../lib/index.js'

function fixture(mappingRows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impl-gate-b5-'))
  const graphRoot = path.join(root, 'graph')
  fs.mkdirSync(path.join(root, '.impl-gate'), { recursive: true })
  fs.mkdirSync(path.join(graphRoot, 'core'), { recursive: true })
  fs.writeFileSync(
    path.join(graphRoot, 'core', 'spec.md'),
    '# core\n\n## 提供\n\n### E1\n- `doWork(): void`\n\n## 需要\n\n（无）\n\n## 约束\n\n（无）\n',
  )
  const rows = mappingRows.map((row) => `| ${row.need} | ${row.module} | ${row.item} |`).join('\n')
  fs.writeFileSync(
    path.join(root, '.impl-gate', 'mapping.md'),
    `# 映射表\n\n| 需求ID | 模块 | 条目 |\n|---|---|---|\n${rows}\n`,
  )
  return { root, graphRoot }
}

test('B5 passes when the graph has no needs and mapping has no rows', async () => {
  const { root, graphRoot } = fixture([])
  const outcome = await checkB5({ implRoot: root, graphRoot })
  assert.equal(outcome.status, 'PASS')
})

test('B5 still fails on an empty module cell', async () => {
  const { root, graphRoot } = fixture([{ need: 'N1', module: '', item: '' }])
  const outcome = await checkB5({ implRoot: root, graphRoot })
  assert.equal(outcome.status, 'FAIL')
})
// 0.4.9: the reviewer prompt ships with the compose result instead of being
// re-assembled by every caller.
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { composeReview } from '../lib/index.js'

const review = composeReview(path.join('C:', 'proj', 'demo'))

test('prompt names the SPEC path and forbids reading the plan', () => {
  assert.match(review.prompt, /demo[\\/]SPEC\.md/)
  assert.match(review.prompt, /不要读 compose-plan\.json/)
})

test('prompt states the three verdicts and the evidence format', () => {
  assert.match(review.prompt, /可开工 \/ 需澄清 \/ 不可开工/)
  assert.match(review.prompt, /SPEC\.md:<行号>/)
})

test('prompt sets the pass line and the way back', () => {
  assert.match(review.prompt, /blocked = 0 且 blocking = 0/)
  assert.match(review.prompt, /impl_gate_review/)
  assert.match(review.prompt, /outDir = .*demo/)
})

test('prompt is stable for the same outDir', () => {
  assert.equal(composeReview(path.join('C:', 'proj', 'demo')).prompt, review.prompt)
})
test('prompt carries the twelve silence questions that machines cannot answer', () => {
  for (const marker of ['单位', '缺省值', '排序', '状态码', 'UTC', '事务', '幂等', '长度上限', '批量', '空态', '测试命令']) {
    assert.match(review.prompt, new RegExp(marker))
  }
  const numbered = review.prompt.split('\n').filter((line) => /^\d+\. /.test(line))
  assert.equal(numbered.length, 12)
})
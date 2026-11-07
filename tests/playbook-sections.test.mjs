// G11.5: the two playbooks must keep the sections the review loop depends on.
// This is a documentation guard only; it never imports runtime code.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const compose = fs.readFileSync(path.join(root, 'playbooks', 'compose.md'), 'utf8')
const review = fs.readFileSync(path.join(root, 'playbooks', 'review.md'), 'utf8')

const CONTRADICTIONS = [
  '跨包外键 × 波次',
  '非 HTTP 模块没有错误构造通道',
  '检查顺序让错误码不可达',
  '数组参数不展开',
  '`default` 掩盖必填列',
  '同一字段两个名字',
  '白名单缺 §9 要求的文件',
  '旧注释与表结构相反',
]

test('compose.md has the eight contradiction subsections in order', () => {
  const headings = [...compose.matchAll(/^### (\d+)\. (.+)$/gm)].map((match) => match[2].trim())
  assert.deepEqual(headings, CONTRADICTIONS)
})

test('each contradiction entry keeps the four fixed lines', () => {
  const blocks = compose.split(/^### \d+\. /m).slice(1)
  assert.equal(blocks.length, 8)
  for (const block of blocks) {
    const body = block.split(/^## /m)[0]
    for (const label of ['**现象**', '**为什么**', '**改法**', '**判定**']) {
      assert.ok(body.includes(label), `missing ${label} in ${block.split('\n')[0]}`)
    }
  }
})

test('review.md defines blocking and ask', () => {
  assert.match(review, /^## blocking 与 ask$/m)
  assert.match(review, /\*\*blocking（不可开工）\*\*/)
  assert.match(review, /\*\*ask（需澄清）\*\*/)
  assert.match(review, /^### blocking 正例/m)
})

test('review.md makes blocking = 0 the pass line and limits full reviews to three rounds', () => {
  assert.match(review, /通过线：\*\*blocking = 0\*\*/)
  assert.match(review, /最多 3 轮全量评审/)
  assert.match(review, /第 4 轮起不再重做全模块/)
})
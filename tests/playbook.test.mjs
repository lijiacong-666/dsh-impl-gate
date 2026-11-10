import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { validatePlan } from '../lib/index.js'

const root = path.resolve(import.meta.dirname, '..')
const composePath = path.join(root, 'playbooks', 'compose.md')
const examplePath = path.join(root, 'playbooks', 'examples', 'login.md')

const SECTIONS = [
  '什么时候用',
  '五步流程',
  '怎么写 compose-plan.json',
  '类型、错误码与接口面',
  '怎么判断 SPEC.md 够不够',
  '高频自相矛盾清单',
  '自洽性',
  'materialize 的 warnings 怎么读',
  '怎么分发',
  '怎么回收',
  '怎么回填实现证据',
  '常见坑',
]

test('both playbook files exist and are packaged', () => {
  assert.equal(fs.existsSync(composePath), true)
  assert.equal(fs.existsSync(examplePath), true)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('playbooks/compose.md'))
  assert.ok(pkg.files.includes('playbooks/examples/login.md'))
})

test('compose.md has the nine fixed headings in order', () => {
  const text = fs.readFileSync(composePath, 'utf8')
  const headings = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim())
  assert.deepEqual(headings, SECTIONS)
})

test('compose.md contains no unfinished markers', () => {
  const text = fs.readFileSync(composePath, 'utf8')
  assert.equal(/TODO|待补/.test(text), false)
})

test('the example names the real tools', () => {
  const text = fs.readFileSync(examplePath, 'utf8')
  assert.match(text, /\bimpl_gate_compose\b/)
  assert.match(text, /\bimpl_gate_init\b/)
  assert.match(text, /企业级登录/)
  assert.match(text, /微信/)
})

test('the example plan validates and has three modules', () => {
  const text = fs.readFileSync(examplePath, 'utf8')
  const block = text.match(/```json\n([\s\S]*?)\n```/)
  assert.notEqual(block, null)
  const parsed = JSON.parse(block[1])
  const result = validatePlan(parsed)
  assert.deepEqual(result.problems, [])
  assert.equal(result.plan.modules.length, 3)
})

test('the example records the real artifacts and three edit recipes', () => {
  const text = fs.readFileSync(examplePath, 'utf8')
  assert.match(text, /"modules": 3/)
  assert.match(text, /wave-1\/M1-shared\.md/)
  assert.match(text, /三处最常见的改法/)
  assert.match(text, /加一个模块/)
  assert.match(text, /加一条验收断言/)
  assert.match(text, /拆波次/)
})
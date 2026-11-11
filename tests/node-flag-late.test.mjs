// `node --test file --test-name-pattern=…` silently ignores the selector: node
// only parses its own flags before the positional script. The warning has to
// catch that shape without flagging vitest, which accepts `-t` after the file.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { collectWarnings, validatePlan } from '../lib/index.js'

const example = path.resolve(import.meta.dirname, '..', 'playbooks', 'examples', 'login.md')
const base = () => {
  const md = fs.readFileSync(example, 'utf8')
  return JSON.parse(md.match(/```json\n([\s\S]*?)```/)[1])
}

const codes = (plan) => {
  const result = validatePlan(plan)
  assert.equal(result.problems.length, 0, JSON.stringify(result.problems?.slice(0, 2)))
  return collectWarnings(plan).map((w) => w.code)
}

test('a node pattern after the file gets flagged', () => {
  const plan = base()
  plan.modules[2].acceptance[0].test = 'node --test auth-api/test/login.test.mjs --test-name-pattern="登录 成功"'
  assert.ok(codes(plan).includes('AC_TEST_NODE_FLAG_LATE'))
})

test('the same pattern before the file is fine', () => {
  const plan = base()
  plan.modules[2].acceptance[0].test = 'node --test --test-name-pattern="登录 成功" auth-api/test/login.test.mjs'
  assert.ok(!codes(plan).includes('AC_TEST_NODE_FLAG_LATE'))
})

test('vitest selectors after the file are not flagged', () => {
  const plan = base()
  plan.modules[2].acceptance[0].test = 'npx vitest run auth-api/tests/login.test.ts -t "登录 成功"'
  assert.ok(!codes(plan).includes('AC_TEST_NODE_FLAG_LATE'))
})
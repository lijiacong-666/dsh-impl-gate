// Shared renderer for declared plan types. SPEC.md and task cards must agree
// on the wording, so both call this module instead of formatting their own.

import type { PlanType } from './plan.js'

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function table(headers: string[], rows: string[][]): string[] {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.map((value) => cell(value)).join(' | ')} |`)
  return lines
}

/** One type as Markdown: a heading plus a shape that depends on `kind`. */
export function renderTypeBlock(type: PlanType): string[] {
  const lines: string[] = [`#### ${type.name}（${type.kind}）`, '']
  if (type.kind === 'object') {
    lines.push(...table(['字段', '类型', '说明'], (type.fields ?? []).map((field) => [field.name, field.type, field.note ?? '—'])))
  } else if (type.kind === 'external') {
    lines.push(`来源：${type.source ?? '（未写明）'}`)
  } else {
    const values = (type.values ?? []).map((value) => `\`${value}\``).join('、')
    lines.push(`取值：${values.length > 0 ? values : '（无）'}`)
  }
  if (type.note !== undefined && type.note.trim().length > 0) lines.push('', `说明：${type.note}`)
  return lines
}

/** Only the types whose names appear in `texts`, in declaration order. */
export function typesUsedBy(types: PlanType[], texts: string[]): PlanType[] {
  const haystack = texts.join('\n')
  return types.filter((type) => new RegExp(`\\b${type.name}\\b`).test(haystack))
}
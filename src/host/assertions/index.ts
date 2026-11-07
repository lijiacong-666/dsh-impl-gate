// Assertion registry. Each checks/impl-gate.checks.json id maps to exactly one
// landing below; check() reports NOT-RUN/NOT_IMPLEMENTED for ids without a
// runnable implementation.
import { checkA1 } from './a1.js'
import { checkB1, checkB2, checkB3, checkB4, checkB5, checkB6, checkB7 } from './delivery.js'
import { checkA2, checkA3, checkA4, checkA5 } from './input.js'
import { checkM1, checkM2, checkM3, checkM4, checkM5, checkM6, checkM8, checkM9 } from './modules.js'
import { checkQ10 } from './q10.js'
import { checkQ2, checkQ3, checkQ5, checkQ6, checkQ7, checkQ8, checkQ9 } from './quality.js'
import type { Assertion } from './types.js'

export const ASSERTIONS: Readonly<Record<string, Assertion>> = {
  A1: checkA1,
  A2: checkA2,
  A3: checkA3,
  A4: checkA4,
  A5: checkA5,
  B1: checkB1,
  B2: checkB2,
  B3: checkB3,
  B4: checkB4,
  B5: checkB5,
  B6: checkB6,
  B7: checkB7,
  M1: checkM1,
  M2: checkM2,
  M3: checkM3,
  M4: checkM4,
  M5: checkM5,
  M6: checkM6,
  M8: checkM8,
  M9: checkM9,
  Q2: checkQ2,
  Q3: checkQ3,
  Q5: checkQ5,
  Q6: checkQ6,
  Q7: checkQ7,
  Q8: checkQ8,
  Q9: checkQ9,
  Q10: checkQ10,
}

/**
 * 32 条 → src/host/assertions/* landing map (coverage 100%).
 * Ids whose function is absent from ASSERTIONS above are the ones still
 * reported as NOT-RUN by impl_gate_check.
 */
export const LANDING: Readonly<Record<string, string>> = {
  A1: 'assertions/a1.ts#checkA1',
  A2: 'assertions/input.ts#checkA2',
  A3: 'assertions/input.ts#checkA3',
  A4: 'assertions/input.ts#checkA4',
  A5: 'assertions/input.ts#checkA5',
  B1: 'assertions/delivery.ts#checkB1',
  B2: 'assertions/delivery.ts#checkB2',
  B3: 'assertions/delivery.ts#checkB3',
  B4: 'assertions/delivery.ts#checkB4',
  B5: 'assertions/delivery.ts#checkB5',
  B6: 'assertions/delivery.ts#checkB6',
  B7: 'assertions/delivery.ts#checkB7',
  M1: 'assertions/modules.ts#checkM1',
  M2: 'assertions/modules.ts#checkM2',
  M3: 'assertions/modules.ts#checkM3',
  M4: 'assertions/modules.ts#checkM4',
  M5: 'assertions/modules.ts#checkM5',
  M6: 'assertions/modules.ts#checkM6',
  M7: 'assertions/modules.ts#checkM7',
  M8: 'assertions/modules.ts#checkM8',
  M9: 'assertions/modules.ts#checkM9',
  M10: 'assertions/modules.ts#checkM10',
  Q1: 'assertions/quality.ts#checkQ1',
  Q2: 'assertions/quality.ts#checkQ2',
  Q3: 'assertions/quality.ts#checkQ3',
  Q4: 'assertions/quality.ts#checkQ4',
  Q5: 'assertions/quality.ts#checkQ5',
  Q6: 'assertions/quality.ts#checkQ6',
  Q7: 'assertions/quality.ts#checkQ7',
  Q8: 'assertions/quality.ts#checkQ8',
  Q9: 'assertions/quality.ts#checkQ9',
  Q10: 'assertions/q10.ts#checkQ10',
}
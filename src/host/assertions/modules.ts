// M-group landings. M1–M6, M8, M9 are judged by replaying the evidence command
// (Step 5 boundary, D-09). M7/M10 stay notrun in checks.json (GUI).
import { makeReplayCheck } from './exec.js'

export const checkM1 = makeReplayCheck('M1')
export const checkM2 = makeReplayCheck('M2')
export const checkM3 = makeReplayCheck('M3')
export const checkM4 = makeReplayCheck('M4')
export const checkM5 = makeReplayCheck('M5')
export const checkM6 = makeReplayCheck('M6')
export const checkM8 = makeReplayCheck('M8')
export const checkM9 = makeReplayCheck('M9')
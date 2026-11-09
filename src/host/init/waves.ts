// Wave planning for G2: topology only. Task cards are G3/G5 work.
// Modules in the same layer form one wave; files that two same-wave modules
// both claim are reported, never merged and never treated as an error.

import type { Plan } from '../compose/plan.js'

export interface Wave {
  index: number
  modules: string[]
  dependsOn: string[]
}

export interface WaveOverlap {
  a: string
  b: string
  files: string[]
}

export interface WavesResult {
  waves: Wave[]
  overlaps: WaveOverlap[]
}

export type WavesOutcome =
  | { ok: true; result: WavesResult }
  | { ok: false; code: 'PLAN_INVALID'; message: string }

interface Edge {
  from: string // requiring module id
  to: string // provider module id
}

function edgesOf(plan: Plan): Edge[] {
  const ids = new Set(plan.modules.map((module) => module.id))
  const edges: Edge[] = []
  for (const module of plan.modules) {
    for (const need of module.requires) {
      if (!ids.has(need.module) || need.module === module.id) continue
      edges.push({ from: module.id, to: need.module })
    }
  }
  return edges
}

/** Depth-first search that returns the first cycle as `A → B → C → A`. */
function findCycle(plan: Plan): string[] | null {
  const adjacency = new Map<string, string[]>()
  for (const module of plan.modules) {
    adjacency.set(
      module.id,
      module.requires.map((need) => need.module).filter((id) => id !== module.id),
    )
  }
  const state = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    state.set(id, 1)
    stack.push(id)
    for (const next of adjacency.get(id) ?? []) {
      if (!adjacency.has(next)) continue
      const seen = state.get(next) ?? 0
      if (seen === 1) {
        const start = stack.indexOf(next)
        return [...stack.slice(start), next]
      }
      if (seen === 0) {
        const found = visit(next)
        if (found !== null) return found
      }
    }
    stack.pop()
    state.set(id, 2)
    return null
  }
  for (const id of adjacency.keys()) {
    if ((state.get(id) ?? 0) === 0) {
      const found = visit(id)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Kahn layering: a module enters the next wave once every prerequisite has
 * been placed. Ids are sorted so the same plan always yields the same waves.
 */
export function computeWaves(plan: Plan): WavesOutcome {
  const cycle = findCycle(plan)
  if (cycle !== null) {
    return { ok: false, code: 'PLAN_INVALID', message: `dependency cycle: ${cycle.join(' → ')}` }
  }

  const edges = edgesOf(plan)
  const ids = plan.modules.map((module) => module.id).sort()
  const prerequisites = new Map<string, Set<string>>()
  for (const id of ids) prerequisites.set(id, new Set<string>())
  for (const edge of edges) prerequisites.get(edge.from)?.add(edge.to)

  const placed = new Set<string>()
  const waves: Wave[] = []
  let index = 1
  while (placed.size < ids.length) {
    const ready = ids.filter((id) => {
      if (placed.has(id)) return false
      const needs = prerequisites.get(id) ?? new Set<string>()
      for (const need of needs) if (!placed.has(need)) return false
      return true
    })
    if (ready.length === 0) {
      return { ok: false, code: 'PLAN_INVALID', message: 'dependency cycle: cannot place remaining modules' }
    }
    const dependsOn = new Set<string>()
    for (const id of ready) for (const need of prerequisites.get(id) ?? []) dependsOn.add(need)
    waves.push({ index, modules: ready, dependsOn: [...dependsOn].sort() })
    for (const id of ready) placed.add(id)
    index += 1
  }

  // Pins: a module may ask for a later wave (e.g. a demo page after the API),
  // but never earlier than its dependencies allow.
  const baseLayer = new Map<string, number>()
  waves.forEach((wave) => {
    for (const id of wave.modules) baseLayer.set(id, wave.index)
  })
  const pinned = new Map<string, number>()
  for (const module of plan.modules) {
    const pin = module.wave
    if (pin === undefined) continue
    const base = baseLayer.get(module.id) ?? 1
    if (pin < base) {
      return {
        ok: false,
        code: 'PLAN_INVALID',
        message: `module "${module.id}" is pinned to wave ${pin} but its dependencies place it in wave ${base} or later`,
      }
    }
    pinned.set(module.id, pin)
  }
  if (pinned.size > 0) {
    const layered = new Map<number, string[]>()
    for (const module of plan.modules) {
      const layer = Math.max(baseLayer.get(module.id) ?? 1, pinned.get(module.id) ?? 1)
      const bucket = layered.get(layer) ?? []
      bucket.push(module.id)
      layered.set(layer, bucket)
    }
    const rebuilt: Wave[] = []
    for (const layer of [...layered.keys()].sort((a, b) => a - b)) {
      const ids = (layered.get(layer) ?? []).sort()
      const dependsOn = new Set<string>()
      for (const id of ids) {
        const module = plan.modules.find((entry) => entry.id === id)
        for (const need of module?.requires ?? []) {
          if (!ids.includes(need.module)) dependsOn.add(need.module)
        }
      }
      rebuilt.push({ index: rebuilt.length + 1, modules: ids, dependsOn: [...dependsOn].sort() })
    }
    waves.length = 0
    waves.push(...rebuilt)
  }

  const filesById = new Map<string, Set<string>>()
  for (const module of plan.modules) filesById.set(module.id, new Set(module.files))
  const overlaps: WaveOverlap[] = []
  for (const wave of waves) {
    for (let i = 0; i < wave.modules.length; i += 1) {
      for (let j = i + 1; j < wave.modules.length; j += 1) {
        const a = wave.modules[i] as string
        const b = wave.modules[j] as string
        const left = filesById.get(a) ?? new Set<string>()
        const right = filesById.get(b) ?? new Set<string>()
        const shared = [...left].filter((file) => right.has(file)).sort()
        if (shared.length > 0) overlaps.push({ a, b, files: shared })
      }
    }
  }

  return { ok: true, result: { waves, overlaps } }
}
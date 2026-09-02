// ============================================================================
// 헤드리스 런 시뮬레이터 (v2)
//   시뮬레이터가 밸런스의 유일한 오라클이다. 봇의 판단이 편향되면 측정이 못 쓴다 —
//   그래서 보상/상점 선택은 하드코딩 우선순위가 아니라 **실측 화력 증가분**으로 한다.
// ============================================================================
import type { Attachment, RewardItem, RunState, Threat } from '../core/types'
import { makeRng } from '../core/rng'
import { startCombat } from '../core/combat'
import { computeFireCost } from '../core/pipeline'
import { combatBrass, skipRewardBrass } from '../core/economy'
import {
  advanceNode,
  applyReward,
  armoryStock,
  buy,
  consumeCombatMods,
  currentNode,
  enterDoor,
  newRun,
  reliquaryStock,
  rollDoors,
  rollRewards,
  withRng,
} from '../core/run'
import type { ArmoryEntry } from '../core/run'
import { makeEnemy } from '../core/data/enemies'
import { pickDerelict } from '../core/data/events'
import { estimateMagDamage, playCombat } from './bot'
import type { BotSkill } from './bot'

const SAFETY = 1.35
const MAX_PURCHASES = 8

export interface DoorChoice {
  sector: number
  offered: [Threat, Threat]
  chosen: Threat
  tookRiskier: boolean
}

export interface RunResult {
  seed: number
  skill: BotSkill
  stake: number
  reachedSector: number
  won: boolean
  deathNode: string | null
  finalBuild: string[]
  specialsLeft: number
  peakHeat: number
  doorChoices: DoorChoice[]
}

export interface Summary {
  runs: number
  winRate: number
  sectorHistogram: number[]
  medianSector: number
  medianPeakHeat: number
}

// ---------------------------------------------------------------------------
// 화력 프로브 — "이 빌드가 표준 적을 얼마나 빨리 죽이나"
// ---------------------------------------------------------------------------
interface Snapshot {
  barrel: Attachment | null
  handguard: Attachment | null
  optic: Attachment | null
  stock: Attachment | null
  magazine: Attachment | null
  rails: (Attachment | null)[]
  railSlots: number
  stash: Attachment[]
  specials: Record<string, number>
  brass: number
  taken: number
}

function snapshot(run: RunState): Snapshot {
  const l = run.loadout
  return {
    barrel: l.barrel,
    handguard: l.handguard,
    optic: l.optic,
    stock: l.stock,
    magazine: l.magazine,
    rails: l.rails.slice(),
    railSlots: l.railSlots,
    stash: l.stash.slice(),
    specials: { ...l.specials },
    brass: l.brass,
    taken: run.attachmentsTaken,
  }
}

function restore(run: RunState, s: Snapshot): void {
  const l = run.loadout
  l.barrel = s.barrel
  l.handguard = s.handguard
  l.optic = s.optic
  l.stock = s.stock
  l.magazine = s.magazine
  l.rails = s.rails.slice()
  l.railSlots = s.railSlots
  l.stash = s.stash.slice()
  l.specials = { ...s.specials }
  l.brass = s.brass
  run.attachmentsTaken = s.taken
}

function probeEnemy(run: RunState, threat: Threat = 1) {
  return makeEnemy({
    archetypeId: 'shambler',
    passiveId: null,
    sector: Math.max(1, Math.min(8, run.sector)),
    nodeMul: 1.63,
    threat,
  })
}

/** 처리량 = 탄창당 피해 × 실제로 쓸 수 있는 사격 횟수 (필요 이상은 가치 0) */
export function firepower(run: RunState): number {
  const probe = probeEnemy(run)
  const s = startCombat(run.loadout, probe, makeRng(0x5eed + run.sector), {
    startDistDelta: 0,
    heatStartDelta: 0,
    runVars: { ...run.attVars },
    attachmentsTaken: run.attachmentsTaken,
  })
  const perMag = estimateMagDamage(s, 'greedy')
  const actions = Math.max(1, Math.floor(s.distance / Math.max(1, s.fireCost)))
  const need = Math.ceil(probe.maxHp / Math.max(1, perMag))
  return perMag * Math.min(actions, need + 1)
}

// ---------------------------------------------------------------------------
function takeReward(run: RunState, threat: Threat): void {
  const items = rollRewards(run, threat)
  const before = firepower(run)
  let best: RewardItem | null = null
  let bestV = 0

  for (const item of items) {
    const snap = snapshot(run)
    applyReward(run, item)
    const v = firepower(run) - before
    restore(run, snap)
    // 특수탄은 즉시 화력이 안 오르지만 소모품 재고가 곧 후반 화력이다
    const score = item.t === 'special' ? v + item.count * before * 0.02 : v
    if (score > bestV) {
      bestV = score
      best = item
    }
  }
  if (best === null) {
    const gain = skipRewardBrass(run.stake)
    run.loadout.brass += gain
    run.stats.brassEarned += gain
    return
  }
  applyReward(run, best)
}

function purchaseValue(run: RunState, e: ArmoryEntry, before: number): number {
  if (e.price > run.loadout.brass) return -1
  if (e.kind === 'rail') return run.sector <= 5 ? (before * 0.34) / e.price : -1
  if (e.kind === 'heal') return run.loadout.brass > 200 ? 0.02 : -1

  const snap = snapshot(run)
  buy(run, e)
  const paid = snap.brass - run.loadout.brass
  if (paid <= 0) {
    restore(run, snap)
    return -1
  }
  const after = firepower(run)
  const bonus = e.kind === 'special' ? before * 0.03 : 0
  restore(run, snap)
  return (after - before + bonus) / paid
}

function visitShop(run: RunState, kind: 'armory' | 'reliquary'): void {
  const failed = new Set<string>()
  for (let i = 0; i < MAX_PURCHASES; i += 1) {
    const stock = kind === 'armory' ? armoryStock(run) : reliquaryStock(run)
    const before = firepower(run)
    let best: ArmoryEntry | null = null
    let bestV = 0
    for (const e of stock) {
      const key = e.kind + '/' + e.label
      if (failed.has(key)) continue
      const v = purchaseValue(run, e, before)
      if (v > bestV) {
        bestV = v
        best = e
      }
    }
    if (best === null) return
    const brassBefore = run.loadout.brass
    buy(run, best)
    if (run.loadout.brass === brassBefore) failed.add(best.kind + '/' + best.label)
  }
}

// ---------------------------------------------------------------------------
function requiredPower(run: RunState, threat: Threat): number {
  const e = makeEnemy({
    archetypeId: 'shambler',
    passiveId: null,
    sector: run.sector,
    nodeMul: currentNode(run) === 'boss' ? 2.5 : run.nodeIndex === 1 ? 1.63 : 1,
    threat,
  })
  return e.maxHp
}

function chooseDoor(run: RunState, power: number): { index: number; choice: DoorChoice } {
  const doors = rollDoors(run)
  const riskier = doors[0].threat >= doors[1].threat ? 0 : 1
  const safer = 1 - riskier
  const okRisky = power >= requiredPower(run, doors[riskier].threat) * SAFETY
  const index = okRisky ? riskier : safer
  return {
    index,
    choice: {
      sector: run.sector,
      offered: [doors[0].threat, doors[1].threat],
      chosen: doors[index].threat,
      tookRiskier: index === riskier,
    },
  }
}

function buildOf(run: RunState): string[] {
  const l = run.loadout
  const out: string[] = []
  for (const a of [l.barrel, l.handguard, l.optic, l.stock, l.magazine]) {
    if (a !== null) out.push(a.id)
  }
  for (const r of l.rails) if (r !== null) out.push(r.id)
  return out
}

export function simulateRun(seed: number, skill: BotSkill, stake: number): RunResult {
  const run = newRun(seed, stake)
  const doorChoices: DoorChoice[] = []
  let deathNode: string | null = null
  let peak = 0

  for (let guard = 0; guard < 80 && run.status === 'alive'; guard += 1) {
    const node = currentNode(run)

    if (node === 'combat' || node === 'boss') {
      const power = firepower(run)
      const { index, choice } = chooseDoor(run, power)
      doorChoices.push(choice)
      const { enemy, threat } = enterDoor(run, index)
      if (enemy === null) {
        advanceNode(run)
        continue
      }
      const mods = consumeCombatMods(run)
      const stakePenalty = run.stake >= 5 ? 2 * Math.max(0, run.sector - 1) : 0
      const staged = { ...enemy, startDist: Math.max(4, enemy.startDist - stakePenalty) }
      const rng = makeRng(run.rngState).fork(run.sector * 733 + run.nodeIndex * 17 + 3)
      const s = startCombat(run.loadout, staged, rng, mods)
      const res = playCombat(s, skill)

      run.stats.shotsFired += s.shotsFired
      run.stats.totalDamage += s.totalDamage
      if (s.peakHeat > peak) peak = s.peakHeat
      run.loadout.specials = { ...s.specials }

      if (!res.win) {
        deathNode = 'S' + run.sector + 'N' + run.nodeIndex + ':' + node
        run.status = 'dead'
        break
      }
      run.stats.combatsWon += 1
      const gain = combatBrass(s, threat)
      run.loadout.brass += gain
      run.stats.brassEarned += gain
      takeReward(run, threat)
    } else if (node === 'armory' || node === 'reliquary') {
      visitShop(run, node)
    } else if (node === 'derelict') {
      withRng(run, (r) => {
        const ev = pickDerelict(r, new Set())
        ev.options[r.int(ev.options.length)].apply(run, r)
      })
    }
    advanceNode(run)
  }

  let left = 0
  for (const v of Object.values(run.loadout.specials)) left += v

  return {
    seed,
    skill,
    stake,
    reachedSector: Math.min(8, run.sector),
    won: run.status === 'won',
    deathNode,
    finalBuild: buildOf(run),
    specialsLeft: left,
    peakHeat: peak,
    doorChoices,
  }
}

export function simulateMany(
  n: number,
  skill: BotSkill,
  stake: number,
  seedBase = 1,
): { results: RunResult[]; summary: Summary } {
  const results: RunResult[] = []
  for (let i = 0; i < n; i += 1) results.push(simulateRun(seedBase + i, skill, stake))
  return { results, summary: summarize(results) }
}

function median(a: number[]): number {
  if (a.length === 0) return 0
  const b = [...a].sort((x, y) => x - y)
  return b[b.length >> 1]
}

export function summarize(results: readonly RunResult[]): Summary {
  const hist = new Array<number>(9).fill(0)
  let wins = 0
  for (const r of results) {
    hist[Math.max(1, Math.min(8, r.reachedSector))] += 1
    if (r.won) wins += 1
  }
  return {
    runs: results.length,
    winRate: results.length === 0 ? 0 : wins / results.length,
    sectorHistogram: hist.slice(1),
    medianSector: median(results.map((r) => r.reachedSector)),
    medianPeakHeat: median(results.map((r) => r.peakHeat)),
  }
}

export function survivalCurve(results: readonly RunResult[]): number[] {
  const out: number[] = []
  for (let s = 1; s <= 8; s += 1) {
    const alive = results.filter((r) => r.reachedSector >= s || r.won).length
    out.push(results.length === 0 ? 0 : alive / results.length)
  }
  return out
}

export function deathDistribution(results: readonly RunResult[]): Record<string, number> {
  const m: Record<string, number> = {}
  for (const r of results) {
    if (r.deathNode === null) continue
    m[r.deathNode] = (m[r.deathNode] ?? 0) + 1
  }
  return m
}

export { computeFireCost }

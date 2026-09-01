// 런 시뮬레이션 하네스 — run.ts 의 실제 API 로 런을 끝까지 돌리고 결과를 모은다.
// 전투는 bot.playCombat 이, 문·보상·상점 같은 메타 결정은 이 파일의 휴리스틱이 담당한다.
// 무작위는 전부 run.rngState / 시드 파생 스트림에서만 나온다 (Math.random 없음).

import type {
  Ammo,
  Attachment,
  DoorOption,
  EnemyInstance,
  Loadout,
  Rarity,
  RewardItem,
  RunState,
  Threat,
} from '../core/types'
import { NODE_MUL, THREAT_HP_MUL, THREAT_SPEED_ADD } from '../core/types'
import { makeRng } from '../core/rng'
import { startCombat } from '../core/combat'
import { computeEnemySpeed, computeFireCost, computeStartDistance } from '../core/pipeline'
import { combatBrass, distanceLeft, skipRewardBrass } from '../core/economy'
import {
  FINAL_SECTOR,
  advanceNode,
  applyReward,
  armoryStock,
  buy,
  currentNode,
  consumeCombatMods,
  enterDoor,
  newRun,
  reliquaryStock,
  rollDoors,
  rollRewards,
  runRng,
} from '../core/run'
import type { ArmoryEntry } from '../core/run'
import { ARCH_BY_ID, baseHp } from '../core/data/enemies'
import { pickDerelict } from '../core/data/events'
import { estimateMagDamage, playCombat } from './bot'
import type { BotSkill } from './bot'

// ---------------------------------------------------------------------------
// 결과 타입
// ---------------------------------------------------------------------------

export interface RunResult {
  seed: number
  skill: BotSkill
  stake: number
  /** 도달한 섹터 (클리어하면 FINAL_SECTOR) */
  reachedSector: number
  won: boolean
  /** 죽은 노드. 예: "S3N1:combat". 살아서 끝났으면 null */
  deathNode: string | null
  /** 최종 빌드 (부착물 id + "mag:<탄창 id>") */
  finalBuild: string[]
  peakHeat: number
}

export interface Summary {
  runs: number
  winRate: number
  /** 인덱스 = 섹터 (0 은 쓰지 않는다). 값 = 그 섹터에서 끝난 런 수 */
  sectorHistogram: number[]
  medianSector: number
  buildFrequency: Record<string, number>
}

// ---------------------------------------------------------------------------
// 휴리스틱 상수 — 봇의 "성격"이 전부 여기에 모여 있다
// ---------------------------------------------------------------------------

/** 문 선택: 요구 화력의 몇 배를 확보해야 위험한 문으로 들어가는가 */
const DOOR_SAFETY = 1.35
/** 가방이 이보다 두꺼우면 압축(탄 제거)이 최우선 지출이 된다 */
const BAG_FAT = 20
/** 런 하나가 밟을 수 있는 노드 수 상한 (무한루프 방지) */
const MAX_NODES = 8 * 5 + 10
/** 한 상점에서 시도하는 최대 구매 횟수 */
const MAX_PURCHASES = 8

const RARITY_RANK: Record<Rarity, number> = { common: 1, uncommon: 2, rare: 3, relic: 4 }

// ---------------------------------------------------------------------------
// 로드아웃 조회 헬퍼
// ---------------------------------------------------------------------------

function equippedAttachments(l: Loadout): Attachment[] {
  const out: Attachment[] = []
  if (l.barrel) out.push(l.barrel)
  if (l.handguard) out.push(l.handguard)
  if (l.optic) out.push(l.optic)
  if (l.stock) out.push(l.stock)
  for (const r of l.rails) {
    if (r) out.push(r)
  }
  return out
}

/** 전리품 벨트는 onCombatEnd 훅으로 직접 탄피를 준다 — 정산에서 중복으로 세지 않기 위한 판정 */
function hasLootBelt(l: Loadout): boolean {
  for (const a of equippedAttachments(l)) {
    if (a.id === 'st_loot_belt') return true
  }
  return false
}

/** 해당 부착물이 들어갈 자리에 이미 뭐가 있는가 (없으면 null) */
function occupant(l: Loadout, a: Attachment): Attachment | null | undefined {
  switch (a.slot) {
    case 'barrel':
      return l.barrel
    case 'handguard':
      return l.handguard
    case 'optic':
      return l.optic
    case 'stock':
      return l.stock
    case 'rail': {
      if (l.railSlots <= 0) return undefined // 달 곳이 없다
      for (const r of l.rails) {
        if (r === null) return null
      }
      // 전부 차 있으면 가장 약한 것과 비교한다
      let weakest: Attachment | null = null
      for (const r of l.rails) {
        if (r === null) continue
        if (weakest === null || RARITY_RANK[r.rarity] < RARITY_RANK[weakest.rarity]) weakest = r
      }
      return weakest
    }
  }
}

function averageGrade(bag: readonly Ammo[]): number {
  if (bag.length === 0) return 1
  let sum = 0
  for (const a of bag) sum += a.grade
  return sum / bag.length
}

// ---------------------------------------------------------------------------
// 문 선택 — "이 빌드로 이 문의 요구 화력을 감당하는가"
// ---------------------------------------------------------------------------

/**
 * 지금 빌드의 "탄창 1회 피해" 추정치.
 * 무한 HP 표적을 상대로 실제 전투를 한 번 차려서 봇에게 최선의 탄창을 짜게 한다
 * (부착물·탄창 효과가 전부 반영된다). 원본 런은 건드리지 않는다 —
 * startCombat 이 가방을 복제하고, rng 는 시드 파생 스트림을 따로 준다.
 */
function estimatePower(run: RunState, skill: BotSkill, salt: number): number {
  const arch = ARCH_BY_ID.shambler
  const probe: EnemyInstance = {
    archetype: arch,
    passive: null,
    maxHp: 1e12,
    hp: 1e12,
    speed: arch.speed,
    startDist: arch.startDist,
    label: '연습 표적',
    bodyCount: 1,
  }
  const rng = makeRng(run.seed).fork((run.sector * 977 + run.nodeIndex * 31 + salt) | 0)
  const s = startCombat(run.loadout, probe, rng)
  return estimateMagDamage(s, skill)
}

/** 문 뒤에 있을 적의 HP 추정 (run.ts 의 nodeMul 규칙과 같은 식) */
function nodeMulFor(nodeIndex: number): number {
  if (nodeIndex <= 0) return NODE_MUL.small
  if (nodeIndex >= 3) return NODE_MUL.boss
  return NODE_MUL.big
}

/** 이 문에 들어갔을 때 탄창 하나가 감당해야 할 피해량 */
function doorDemand(run: RunState, door: DoorOption): number {
  const arch = ARCH_BY_ID[door.archetype ?? 'shambler']
  const stakeHp = run.stake >= 3 ? 1.1 : 1
  const hp =
    baseHp(run.sector, nodeMulFor(run.nodeIndex), run.sector > FINAL_SECTOR) *
    arch.hpMul *
    THREAT_HP_MUL[door.threat] *
    stakeHp

  // 실제 전투에 쓰일 값과 같은 식으로 행동 수를 센다 (거인의 보폭·역장 급탄기 반영).
  const probe: EnemyInstance = {
    archetype: arch,
    passive: null,
    maxHp: hp,
    hp,
    speed: arch.speed + THREAT_SPEED_ADD[door.threat],
    startDist: arch.startDist,
    label: '',
    bodyCount: 1,
  }
  const speed = computeEnemySpeed(run.loadout, probe.speed)
  const dist = computeStartDistance(run.loadout, probe)
  const cost = computeFireCost(run.loadout, probe, speed)
  const actions = Math.max(1, Math.ceil(dist / cost))
  return hp / actions
}

/**
 * 문 선택 휴리스틱: 감당 가능한 문 중 가장 위험한 문을 고른다 (보상이 크므로).
 * 어느 쪽도 감당이 안 되면 가장 안전한 문으로 도망친다.
 */
function chooseDoor(run: RunState, doors: readonly DoorOption[], power: number): number {
  let bestIdx = 0
  let bestThreat = -1
  let safestIdx = 0
  let safestThreat = 99

  for (let i = 0; i < doors.length; i += 1) {
    const d = doors[i]
    if (d.threat < safestThreat) {
      safestThreat = d.threat
      safestIdx = i
    }
    if (power >= doorDemand(run, d) * DOOR_SAFETY && d.threat > bestThreat) {
      bestThreat = d.threat
      bestIdx = i
    }
  }
  return bestThreat >= 0 ? bestIdx : safestIdx
}

// ---------------------------------------------------------------------------
// 보상 선택 — 빈 하드포인트 우선, 그 다음 레어도 교체
// ---------------------------------------------------------------------------

function rewardScore(run: RunState, item: RewardItem): number {
  const l = run.loadout
  switch (item.t) {
    case 'attachment': {
      const a = item.attachment
      const cur = occupant(l, a)
      if (cur === undefined) return -1 // 레일 칸이 없다
      if (cur === null) return 100 + RARITY_RANK[a.rarity] * 10 // 빈 자리 채우기
      const diff = RARITY_RANK[a.rarity] - RARITY_RANK[cur.rarity]
      return diff > 0 ? 50 + diff * 10 : -1
    }
    case 'ammo': {
      const avg = averageGrade(l.bag)
      return item.ammo.grade > avg ? 40 + (item.ammo.grade - avg) * 5 : -1
    }
    case 'magazine':
      return -1
  }
}

function takeReward(run: RunState, threat: Threat): void {
  const items = rollRewards(run, threat)
  let best: RewardItem | null = null
  let bestScore = 0

  for (const item of items) {
    const sc = rewardScore(run, item)
    if (sc > bestScore) {
      bestScore = sc
      best = item
    }
  }

  if (best === null) {
    // 건너뛰기 — 빌드 순수성 유지 비용을 탄피로 보전받는다 (GDD §9.5)
    const gain = skipRewardBrass(run.stake)
    run.loadout.brass += gain
    run.stats.brassEarned += gain
    return
  }
  applyReward(run, best)
}

// ---------------------------------------------------------------------------
// 상점 — 압축 > 레일 > 부착물 > 승급 > 탄 > 회복
// ---------------------------------------------------------------------------

function entryPriority(run: RunState, entry: ArmoryEntry): number {
  const l = run.loadout
  switch (entry.kind) {
    case 'removal':
      return l.bag.length > BAG_FAT ? 100 : -1
    case 'rail':
      return 90
    case 'attachment': {
      const p = entry.payload
      const a = isAttachmentPayload(p) ? p.attachment : null
      if (a === null) return -1
      const cur = occupant(l, a)
      if (cur === undefined) return -1
      if (cur === null) return 80 + RARITY_RANK[a.rarity]
      return RARITY_RANK[a.rarity] > RARITY_RANK[cur.rarity] ? 60 + RARITY_RANK[a.rarity] : -1
    }
    case 'upgrade':
      return l.bag.some((x) => x.grade < 5) ? 40 : -1
    case 'ammo': {
      const p = entry.payload
      if (!isAmmoPayload(p)) return -1
      return p.grade > averageGrade(l.bag) ? 20 : -1
    }
    case 'magazine':
      return -1 // 빌드 방향 전환은 봇이 판단하기 어렵다 — 손대지 않는다
    case 'heal':
      return l.brass > 150 ? 10 : -1
  }
}

function isAttachmentPayload(p: unknown): p is { attachment: Attachment } {
  if (typeof p !== 'object' || p === null) return false
  const a = (p as { attachment?: unknown }).attachment
  return typeof a === 'object' && a !== null && typeof (a as Attachment).id === 'string'
}

function isAmmoPayload(p: unknown): p is { grade: number } {
  if (typeof p !== 'object' || p === null) return false
  return typeof (p as { grade?: unknown }).grade === 'number'
}

/**
 * 살 수 있는 것 중 우선순위가 가장 높은 것을 하나씩 산다.
 * 진열(armoryStock/reliquaryStock)은 좌표 고정 스트림이라 다시 불러도 같은 물건이 나오지만,
 * 장착·제거로 진열 후보가 바뀔 수 있어 매번 다시 읽는다.
 */
function visitShop(run: RunState, kind: 'armory' | 'reliquary'): void {
  const failed = new Set<string>()

  for (let i = 0; i < MAX_PURCHASES; i += 1) {
    const stock = kind === 'armory' ? armoryStock(run) : reliquaryStock(run)
    let best: ArmoryEntry | null = null
    let bestScore = 0

    for (const entry of stock) {
      const key = entry.kind + '/' + entry.label
      if (failed.has(key)) continue
      if (entry.price > run.loadout.brass) continue
      const sc = entryPriority(run, entry)
      if (sc > bestScore) {
        bestScore = sc
        best = entry
      }
    }

    if (best === null) return
    const before = run.loadout.brass
    buy(run, best)
    if (run.loadout.brass === before) {
      // 구매가 거절됐다 (가방 하한·레일 없음 등) — 같은 항목을 다시 시도하지 않는다.
      failed.add(best.kind + '/' + best.label)
    }
  }
}

// ---------------------------------------------------------------------------
// 폐허 이벤트 — 선택지는 무작위로 고른다 (환율표라 어느 쪽도 함정이 아니다)
// ---------------------------------------------------------------------------

function visitDerelict(run: RunState, seen: Set<string>): void {
  const rng = runRng(run)
  const ev = pickDerelict(rng, seen)
  if (ev.options.length === 0) return
  const opt = ev.options[rng.int(ev.options.length)]
  opt.apply(run, rng)
}

// ---------------------------------------------------------------------------
// 전투 1회
// ---------------------------------------------------------------------------

function runCombat(
  run: RunState,
  enemy: EnemyInstance,
  threat: Threat,
  skill: BotSkill,
): { win: boolean; peakHeat: number } {
  // 정비소 "회복"/이벤트의 한시 효과는 여기서 정확히 한 번 소비된다.
  const mods = consumeCombatMods(run)
  // 성전 등급 5 "섹터마다 시작 거리 −2m" (GDD §12) — 전투 셋업 소관이라 여기서 얹는다.
  const stakePenalty = run.stake >= 5 ? 2 * Math.max(0, run.sector - 1) : 0
  const start = Math.max(1, enemy.startDist - stakePenalty)
  const staged: EnemyInstance = { ...enemy, startDist: start }

  const rng = makeRng(run.rngState).fork(run.sector * 733 + run.nodeIndex * 17 + 3)
  const s = startCombat(run.loadout, staged, rng, mods)
  const res = playCombat(s, skill)

  run.stats.shotsFired += s.shotsFired
  run.stats.totalDamage += s.totalDamage
  if (s.peakHeat > run.stats.peakHeat) run.stats.peakHeat = s.peakHeat

  if (res.win) {
    run.stats.combatsWon += 1
    // 전리품 벨트는 onCombatEnd 훅에서 이미 지급했으므로 정산식에서 그만큼 빼고 더한다.
    const belt = hasLootBelt(run.loadout) ? distanceLeft(s) * 2 : 0
    const gain = Math.max(0, combatBrass(s, threat) - belt)
    run.loadout.brass += gain
    run.stats.brassEarned += gain
  }

  return { win: res.win, peakHeat: s.peakHeat }
}

// ---------------------------------------------------------------------------
// 런 1회
// ---------------------------------------------------------------------------

function buildOf(run: RunState): string[] {
  const out = equippedAttachments(run.loadout).map((a) => a.id)
  out.push('mag:' + run.loadout.magazine.id)
  return out
}

export function simulateRun(seed: number, skill: BotSkill, stake: number): RunResult {
  // newRun 이 resetUidCounter() 를 부르므로 같은 시드는 항상 같은 런이 된다.
  const run = newRun(seed, stake)
  const seenDerelicts = new Set<string>()

  let deathNode: string | null = null
  let peakHeat = 0

  for (let step = 0; step < MAX_NODES && run.status === 'alive'; step += 1) {
    const node = currentNode(run)

    if (node === 'combat' || node === 'boss') {
      let doorIndex = 0
      if (node === 'combat') {
        const doors = rollDoors(run)
        doorIndex = chooseDoor(run, doors, estimatePower(run, skill, step))
      }

      const entered = enterDoor(run, doorIndex)
      if (entered.enemy === null) {
        advanceNode(run)
        continue
      }

      const res = runCombat(run, entered.enemy, entered.threat, skill)
      if (res.peakHeat > peakHeat) peakHeat = res.peakHeat

      if (!res.win) {
        run.status = 'dead'
        run.stats.deaths += 1
        deathNode = 'S' + run.sector + 'N' + run.nodeIndex + ':' + node
        break
      }
      takeReward(run, entered.threat)
    } else if (node === 'armory') {
      visitShop(run, 'armory')
    } else if (node === 'reliquary') {
      visitShop(run, 'reliquary')
    } else if (node === 'derelict') {
      visitDerelict(run, seenDerelicts)
    }

    advanceNode(run)
  }

  const won = run.status === 'won'
  return {
    seed,
    skill,
    stake,
    reachedSector: won ? FINAL_SECTOR : Math.min(run.sector, FINAL_SECTOR),
    won,
    deathNode,
    finalBuild: buildOf(run),
    peakHeat,
  }
}

// ---------------------------------------------------------------------------
// 여러 런
// ---------------------------------------------------------------------------

export function simulateMany(
  n: number,
  skill: BotSkill,
  stake: number,
  seedBase = 1,
): { results: RunResult[]; summary: Summary } {
  const results: RunResult[] = []
  for (let i = 0; i < n; i += 1) {
    results.push(simulateRun(seedBase + i, skill, stake))
  }
  return { results, summary: summarize(results) }
}

export function summarize(results: readonly RunResult[]): Summary {
  const hist = new Array<number>(FINAL_SECTOR + 1).fill(0)
  const freq: Record<string, number> = {}
  let wins = 0

  for (const r of results) {
    if (r.won) wins += 1
    const s = Math.max(1, Math.min(FINAL_SECTOR, r.reachedSector))
    hist[s] += 1
    for (const id of r.finalBuild) {
      freq[id] = (freq[id] ?? 0) + 1
    }
  }

  const sectors = results.map((r) => r.reachedSector).sort((a, b) => a - b)
  const median =
    sectors.length === 0
      ? 0
      : sectors.length % 2 === 1
        ? sectors[(sectors.length - 1) / 2]
        : (sectors[sectors.length / 2 - 1] + sectors[sectors.length / 2]) / 2

  return {
    runs: results.length,
    winRate: results.length === 0 ? 0 : wins / results.length,
    sectorHistogram: hist,
    medianSector: median,
    buildFrequency: freq,
  }
}

/** 사망 노드 분포 (CLI 표 3번) */
export function deathDistribution(results: readonly RunResult[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of results) {
    if (r.deathNode === null) continue
    out[r.deathNode] = (out[r.deathNode] ?? 0) + 1
  }
  return out
}

/** 섹터별 생존율 곡선: index i = 섹터 i 에 도달한 런의 비율 */
export function survivalCurve(results: readonly RunResult[]): number[] {
  const out = new Array<number>(FINAL_SECTOR + 1).fill(0)
  if (results.length === 0) return out
  for (let s = 1; s <= FINAL_SECTOR; s += 1) {
    let n = 0
    for (const r of results) {
      if (r.reachedSector >= s) n += 1
    }
    out[s] = n / results.length
  }
  return out
}

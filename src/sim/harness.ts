// 런 시뮬레이션 하네스 — run.ts 의 실제 API 로 런을 끝까지 돌리고 결과를 모은다.
// 전투는 bot.playCombat 이, 문·보상·상점 같은 메타 결정은 이 파일의 휴리스틱이 담당한다.
// 무작위는 전부 run.rngState / 시드 파생 스트림에서만 나온다 (Math.random 없음).

import type {
  Ammo,
  Attachment,
  CombatState,
  DoorOption,
  EnemyInstance,
  Loadout,
  Rarity,
  RewardItem,
  Rng,
  RunState,
  Threat,
  Magazine,
} from '../core/types'
import { NODE_MUL, THREAT_HP_MUL, THREAT_SPEED_ADD } from '../core/types'
import { makeRng } from '../core/rng'
import { cloneState, startCombat, previewDamage } from '../core/combat'
import { ammoStats } from '../core/ammoStats'
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
import { ARCH_BY_ID, PASSIVE_BY_ID, baseHp, makeEnemy } from '../core/data/enemies'
import { pickDerelict } from '../core/data/events'
import { chooseAction, estimateMagDamage, playCombat } from './bot'
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
  /** 이 런에서 마주친 갈림길과 봇의 선택 (JUSTIFICATION §5 "갈림길이 진짜 선택인가") */
  doorChoices: DoorChoice[]
  /** 순서 민감도 표본 (JUSTIFICATION §5 "순서가 정말 중요한가") */
  orderSamples: OrderSample[]
}

/** 갈림길 1회 — 무엇이 제시됐고 봇이 무엇을 골랐는가 */
export interface DoorChoice {
  sector: number
  nodeIndex: number
  /** 제시된 두 문의 위험도. 항상 오름차순 — (1,2) 또는 (2,3) */
  offered: [Threat, Threat]
  chosen: Threat
  /** 더 위험한 쪽을 골랐는가 */
  tookRisk: boolean
  /** 각 문을 상대로 잰 자기 화력 (탄창 1회 피해). offered 와 같은 순서 */
  power: [number, number]
  /** 각 문의 요구 화력. offered 와 같은 순서 */
  demand: [number, number]
}

/**
 * 순서 민감도 표본 1건.
 * **같은 탄 묶음**의 모든 배열을 previewDamage 로 재서 최선/최악을 찾는다.
 * best/worst 가 곧 JUSTIFICATION §5 의 "최선 배열 / 최악 배열 데미지 비"다.
 */
export interface OrderSample {
  sector: number
  /** 이 표본을 뽑은 런의 봇 숙련도 (빌드가 달라지므로 구분해 둔다) */
  skill: BotSkill
  /** 묶음 크기 = 실제로 장전한 탄 수 */
  k: number
  /** 그때의 탄창 용량 */
  cap: number
  best: number
  worst: number
  /** greedy 봇이 실제로 택한 배열의 값 (무작위 묶음에는 없다) */
  greedy: number | null
  /** 순열을 전수 조사했는가. false 면 표본 추정이라 비율이 과소평가된다 */
  exhaustive: boolean
  /** bot = 봇이 고른 묶음 · random = 손패에서 무작위로 집은 묶음 */
  kind: 'bot' | 'random'
/**
   * 최선 배열이 이 한 탄창으로 적을 죽였을 표본인가.
   * 측정 자체는 죽지 않는 표적으로 하므로(immortalProbe) 편향은 이미 제거돼 있다 —
   * 이 값은 "실제 전투였다면 여기서 끝났다" 는 참고용 비중이다.
   */
  cappedByKill: boolean
}

/** simulateRun 에 넘기는 계측 옵션 */
export interface SimOptions {
  /** 이 런에서 순열 분석 표본을 뽑을지 */
  orderAnalysis: boolean
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

/** 순열 전수 조사를 허용하는 최대 순열 수 (6! = 720). 그 위는 표본 추정 */
const ORDER_EXHAUSTIVE_PERMS = 720
/** 전수 조사가 불가능할 때 무작위로 재보는 배열 수 */
const ORDER_SAMPLED_PERMS = 240
/** 한 런에서 순서 표본을 뽑는 섹터당 횟수 (섹터마다 첫 전투 1회) */
const ORDER_PER_SECTOR = 1
/**
 * 순열 분석에 쓰는 런 수 상한. --runs 를 아무리 키워도 이 수만큼의 런에서만 표본을 뽑아
 * 실행 시간이 선형으로 폭발하지 않게 한다 (스트라이드 추출이라 시드 편향도 없다).
 */
const ORDER_RUN_BUDGET = 120

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
// 순서 민감도 계측 — "같은 탄 묶음을 어떻게 배열하느냐"가 만드는 피해 차이
//
//   JUSTIFICATION §5 의 첫 번째 성공 기준을 재는 유일한 장치다.
//   판정은 전부 core 의 previewDamage 로 한다 (규칙을 새로 만들지 않는다).
//   previewDamage 는 상태를 복제해서 계산하므로 원본 전투/런을 오염시키지 않는다.
// ---------------------------------------------------------------------------

function dmgOf(a: Ammo): number {
  return ammoStats(a).dmg
}

function heatOf(a: Ammo): number {
  return ammoStats(a).heat
}

/** 지금 손에 든 탄 = 트레이 + 예비칸 (bot.hand 와 같은 정의) */
function handOf(s: CombatState): Ammo[] {
  return s.reserve.length > 0 ? s.tray.concat(s.reserve) : s.tray.slice()
}

function factorial(n: number): number {
  let f = 1
  for (let i = 2; i <= n; i += 1) f *= i
  return f
}

/** 모든 순열을 하나씩 넘겨준다 (Heap's algorithm). 배열을 모아두지 않아 메모리가 상수다. */
function eachPermutation(items: readonly Ammo[], visit: (p: Ammo[]) => void): void {
  const arr = items.slice()
  const c = new Array<number>(arr.length).fill(0)
  visit(arr.slice())
  let i = 0
  while (i < arr.length) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i]
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
      visit(arr.slice())
      c[i] += 1
      i = 0
    } else {
      c[i] = 0
      i += 1
    }
  }
}

/**
 * 이 묶음이 만들 수 있는 최선/최악 배열의 피해.
 * 순열이 720개 이하면 전수 조사, 그 위는 앵커 4종 + 무작위 표본으로 근사한다
 * (근사는 범위를 좁히는 쪽으로만 틀리므로 비율을 과대평가하지 않는다).
 */
function orderRange(
  s: CombatState,
  set: readonly Ammo[],
  rng: Rng,
): { best: number; worst: number; exhaustive: boolean } {
  let best = Number.NEGATIVE_INFINITY
  let worst = Number.POSITIVE_INFINITY
  const see = (p: Ammo[]): void => {
    const v = previewDamage(s, p).expected
    if (v > best) best = v
    if (v < worst) worst = v
  }

  if (factorial(set.length) <= ORDER_EXHAUSTIVE_PERMS) {
    eachPermutation(set, see)
    return { best, worst, exhaustive: true }
  }

  // 해석적 앵커 — 최선/최악에 가까울 것이 뻔한 네 배열은 반드시 재본다.
  const byExchange = set.slice().sort((a, b) => heatOf(b) * dmgOf(a) - heatOf(a) * dmgOf(b))
  see(byExchange)
  see(byExchange.slice().reverse())
  see(set.slice().sort((a, b) => dmgOf(a) - dmgOf(b)))
  see(set.slice().sort((a, b) => dmgOf(b) - dmgOf(a)))
  for (let i = 0; i < ORDER_SAMPLED_PERMS; i += 1) see(rng.shuffle(set.slice()))
  return { best, worst, exhaustive: false }
}

/**
 * 배열 비교 전용 표적 사본.
 *
 * ★ 이 사본이 없으면 측정이 망가진다: combat.fire 는 적이 죽는 순간 남은 탄을 쏘지 않는다.
 *   좋은 배열일수록 일찍 죽여서 뒷 탄이 잘리므로, **최선값만 깎이고 최악값은 온전히 남는다.**
 *   실측해 보니 표본의 38% 가 이 절단에 걸렸다 — 비율이 체계적으로 과소평가된다.
 *   그래서 죽지 않는 표적에 대고 "이 배열이 뽑아내는 피해"만 잰다.
 *   전투 시작 시점에는 hp == maxHp 라서, 둘을 같이 키우면 HP 비율 조건부 효과
 *   (예: "적 HP 25% 이하") 의 발동 여부도 원본과 똑같이 유지된다.
 */
function immortalProbe(s: CombatState): CombatState {
  const p = cloneState(s)
  const hp = 1e12
  p.enemy = { ...p.enemy, hp, maxHp: hp }
  return p
}

/**
 * 이 전투 시작 시점에서 순서 민감도 표본을 뽑는다.
 *  ① 봇이 실제로 장전하기로 한 묶음 — "플레이어가 마주하는 진짜 배열 결정"
 *  ② 손패에서 무작위로 집은 같은 크기의 묶음 — 선택 편향이 없는 대조군
 * 두 값이 크게 다르면 "좋은 묶음일수록 순서가 더 중요하다"는 뜻이다.
 *
 * 묶음을 **고르는** 것은 진짜 상태(s)로 한다(봇이 실제로 하는 판단 그대로).
 * 묶음을 **배열해 재는** 것만 죽지 않는 표적으로 한다.
 */
function sampleOrder(s: CombatState, sector: number, skill: BotSkill): OrderSample[] {
  const out: OrderSample[] = []
  const hand = handOf(s)
  const k = Math.min(s.cap, hand.length)
  if (k <= 0) return out

  // s.rng 를 소비하면 전투 결과가 바뀐다 — 상태만 읽어 독립 스트림을 판다.
  const rng = makeRng(s.rng.state()).fork(0x0d1e)
  const probe = immortalProbe(s)

  const act = chooseAction(s, 'greedy')
  if (act.kind === 'fire' && act.plan.length > 0) {
    const r = orderRange(probe, act.plan, rng)
    out.push({
      sector,
      skill,
      k: act.plan.length,
      cap: s.cap,
      best: r.best,
      worst: r.worst,
      greedy: previewDamage(probe, act.plan).expected,
      exhaustive: r.exhaustive,
      kind: 'bot',
      cappedByKill: r.best >= s.enemy.hp,
    })
  }

  const pick = rng.shuffle(hand.slice()).slice(0, k)
  const r2 = orderRange(probe, pick, rng)
  out.push({
    sector,
    skill,
    k: pick.length,
    cap: s.cap,
    best: r2.best,
    worst: r2.worst,
    greedy: null,
    exhaustive: r2.exhaustive,
    kind: 'random',
    cappedByKill: r2.best >= s.enemy.hp,
  })

  return out
}

// ---------------------------------------------------------------------------
// 문 선택 — "이 빌드로 이 문의 요구 화력을 감당하는가"
// ---------------------------------------------------------------------------

/**
 * **이 문 뒤의 적을 상대로** 낼 수 있는 탄창 1회 피해 추정치.
 * 무한 HP 표적을 상대로 실제 전투를 한 번 차려서 봇에게 최선의 탄창을 짜게 한다
 * (부착물·탄창 효과가 전부 반영된다). 원본 런은 건드리지 않는다 —
 * startCombat 이 가방을 복제하고, rng 는 시드 파생 스트림을 따로 준다.
 *
 * ★ 문마다 따로 재는 이유: 위험도 3 문에는 **반드시** 적 패시브가 붙는다(run.rollDoors).
 *   패시브는 화력을 직접 깎는 축이다(장갑·강직·냉혈·성별 거부). 패시브 없는 프로브 하나로
 *   두 문을 같이 재면 위험도 3 의 난이도만 체계적으로 과소평가하게 되고,
 *   그 편향은 그대로 "봇이 늘 위험한 문만 고른다"는 계측 결과로 나타난다.
 *   런 스코프 카운터(attVars)와 획득 부착물 수도 넘겨야 누적형 부착물이 제값으로 잡힌다.
 */
function powerAgainst(run: RunState, door: DoorOption, skill: BotSkill, salt: number): number {
  const arch = ARCH_BY_ID[door.archetype ?? 'shambler']
  const probe: EnemyInstance = {
    archetype: arch,
    passive: door.passiveId === null ? null : (PASSIVE_BY_ID[door.passiveId] ?? null),
    maxHp: 1e12,
    hp: 1e12,
    speed: arch.speed + THREAT_SPEED_ADD[door.threat],
    startDist: arch.startDist,
    label: '연습 표적',
    bodyCount: 1,
  }
  const rng = makeRng(run.seed).fork((run.sector * 977 + run.nodeIndex * 31 + salt) | 0)
  const s = startCombat(run.loadout, probe, rng, {
    startDistDelta: 0,
    heatStartDelta: 0,
    // 프로브가 런 스코프 카운터를 오염시키면 안 된다 — 사본을 넘긴다.
    runVars: { ...run.attVars },
    attachmentsTaken: run.attachmentsTaken,
  })
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
 *
 * "감당 가능"의 기준은 `그 문을 상대로 잰 화력 >= 그 문의 요구화력 × DOOR_SAFETY` 하나다.
 * 화력을 문마다 따로 재기 때문에(powerAgainst) 적 패시브·접근 속도가 판정에 들어간다.
 */
function chooseDoor(
  run: RunState,
  doors: readonly DoorOption[],
  skill: BotSkill,
  salt: number,
): { index: number; record: DoorChoice } {
  let bestIdx = 0
  let bestThreat = -1
  let safestIdx = 0
  let safestThreat = 99
  const demands: number[] = []
  const powers: number[] = []

  for (let i = 0; i < doors.length; i += 1) {
    const d = doors[i]
    const demand = doorDemand(run, d)
    const power = powerAgainst(run, d, skill, salt * 7 + i)
    demands.push(demand)
    powers.push(power)
    if (d.threat < safestThreat) {
      safestThreat = d.threat
      safestIdx = i
    }
    if (power >= demand * DOOR_SAFETY && d.threat > bestThreat) {
      bestThreat = d.threat
      bestIdx = i
    }
  }

  const index = bestThreat >= 0 ? bestIdx : safestIdx

  // 계측용 기록 — 위험도 오름차순으로 정규화해서 담는다 (표에서 (1,2)/(2,3) 로 묶기 위함).
  const order = doors.map((_, i) => i).sort((a, b) => doors[a].threat - doors[b].threat)
  const lo = order[0]
  const hi = order[order.length - 1]
  const record: DoorChoice = {
    sector: run.sector,
    nodeIndex: run.nodeIndex,
    offered: [doors[lo].threat, doors[hi].threat],
    chosen: doors[index].threat,
    tookRisk: doors[index].threat === doors[hi].threat && lo !== hi,
    power: [powers[lo], powers[hi]],
    demand: [demands[lo], demands[hi]],
  }
  return { index, record }
}

// ---------------------------------------------------------------------------
// 보상 선택 — 빈 하드포인트 우선, 그 다음 레어도 교체
// ---------------------------------------------------------------------------

/**
 * 보상 가치 = 실제로 받아본 뒤의 화력 증가분.
 * 레어도 순위 같은 대리지표를 쓰면 "레어도는 낮지만 내 빌드에 맞는 것"을 영영 못 고른다.
 */
function rewardScore(run: RunState, item: RewardItem, before: number): number {
  const l = run.loadout
  if (item.t === 'magazine') return -1
  if (item.t === 'attachment' && occupant(l, item.attachment) === undefined) return -1

  const snap = snapshot(run)
  applyReward(run, item)
  const after = firepower(run)
  restore(run, snap)

  const gain = after - before
  // 빈 하드포인트를 채우는 것은 화력이 같아도 미래 가치가 있다 (교체 여지 확보).
  const empty = item.t === 'attachment' && occupant(l, item.attachment) === null
  return gain + (empty ? before * 0.02 : 0)
}

function takeReward(run: RunState, threat: Threat): void {
  const items = rollRewards(run, threat)
  const before = firepower(run)
  let best: RewardItem | null = null
  let bestScore = 0

  for (const item of items) {
    const sc = rewardScore(run, item, before)
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
// 화력 프로브 — 봇의 모든 "무엇을 살까/받을까" 판단의 공통 자
//   하드코딩 우선순위 대신 "이걸 장착하면 탄창 피해가 실제로 얼마나 오르는가"를 잰다.
//   시뮬레이터가 밸런스의 오라클이므로, 봇의 판단이 편향되면 측정 자체가 못 쓴다.
// ---------------------------------------------------------------------------

/**
 * 현재 빌드의 **전투 처리량** = (탄창당 예상 피해) × (쓸 수 있는 사격 행동 수).
 *
 * 탄창당 피해만 재면 "거리를 팔아 데미지를 사는" 부착물(참회의 사슬 등)을 체계적으로
 * 과대평가한다 — 실제로는 행동을 잃어 총 피해가 줄어드는데도 프로브에는 이득으로 보인다.
 * 시뮬레이터가 밸런스의 오라클이므로 이 편향은 곧 잘못된 밸런싱으로 이어진다.
 */
function firepower(run: RunState): number {
  const sec = Math.max(1, Math.min(8, run.sector))
  const probe = makeEnemy({
    archetypeId: 'shambler',
    passiveId: null,
    sector: sec,
    nodeMul: 1.63,
    threat: 1,
  })
  const s = startCombat(run.loadout, probe, makeRng(0x5eed + sec), {
    startDistDelta: 0,
    heatStartDelta: 0,
    // 프로브가 런 스코프 카운터를 오염시키면 안 된다 — 사본을 넘긴다.
    runVars: { ...run.attVars },
    attachmentsTaken: run.attachmentsTaken,
  })
  const perMag = estimateMagDamage(s, 'greedy')
  const actions = Math.max(1, Math.floor(s.distance / Math.max(1, s.fireCost)))

  // 필요 이상의 행동은 가치가 없다. 적을 3탄창에 잡는데 10행동이 있어도 7행동은 노는 것이다.
  // 이 상한이 없으면 "적 이동속도 −2" 같은 자원 부착물이 무한히 좋아 보인다.
  // 여유 1행동까지만 보험으로 값을 쳐 준다.
  const need = Math.ceil(probe.maxHp / Math.max(1, perMag))
  const usable = Math.min(actions, need + 1)
  return perMag * usable
}

/** 로드아웃/가방/누적 카운터의 얕은 스냅샷 (프로브용 롤백) */
interface BuildSnapshot {
  barrel: Attachment | null
  handguard: Attachment | null
  optic: Attachment | null
  stock: Attachment | null
  rails: (Attachment | null)[]
  railSlots: number
  magazine: Magazine
  bag: Ammo[]
  brass: number
  taken: number
  removals: number
}

function snapshot(run: RunState): BuildSnapshot {
  const l = run.loadout
  return {
    barrel: l.barrel,
    handguard: l.handguard,
    optic: l.optic,
    stock: l.stock,
    rails: l.rails.slice(),
    railSlots: l.railSlots,
    magazine: l.magazine,
    bag: l.bag.slice(),
    brass: l.brass,
    taken: run.attachmentsTaken,
    removals: run.removals,
  }
}

function restore(run: RunState, snap: BuildSnapshot): void {
  const l = run.loadout
  l.barrel = snap.barrel
  l.handguard = snap.handguard
  l.optic = snap.optic
  l.stock = snap.stock
  l.rails = snap.rails.slice()
  l.railSlots = snap.railSlots
  l.magazine = snap.magazine
  l.bag = snap.bag.slice()
  l.brass = snap.brass
  run.attachmentsTaken = snap.taken
  run.removals = snap.removals
}

/** 이 구매가 만들어내는 "탄피 1개당 화력 증가분". 살 가치가 없으면 음수. */
function purchaseValue(run: RunState, entry: ArmoryEntry, before: number): number {
  const price = Math.max(1, entry.price)
  if (price > run.loadout.brass) return -1

  // 레일 확장은 화력이 즉시 오르지 않는다 (다음 부착물을 담을 그릇이다).
  // 슬롯이 비어 있으면 앞으로 받을 보상 하나가 통째로 이득이 되므로 고정 가치를 준다.
  if (entry.kind === 'rail') {
    return run.sector <= 5 ? (before * 0.34) / price : -1
  }
  // 응급 보급은 화력이 아니라 행동 수를 산다 — 프로브로 잴 수 없다.
  if (entry.kind === 'heal') return run.loadout.brass > 200 ? 0.02 : -1
  // 탄창 교체는 빌드 방향 전환이라 봇이 판단하기 어렵다.
  if (entry.kind === 'magazine') return -1

  const snap = snapshot(run)
  const msg = buy(run, entry)
  const paid = snap.brass - run.loadout.brass
  if (paid <= 0) {
    restore(run, snap)
    void msg
    return -1
  }
  const after = firepower(run)
  restore(run, snap)
  return (after - before) / paid
}

// ---------------------------------------------------------------------------
// 상점 — 측정 기반. 탄피 1개당 화력 증가분이 가장 큰 것부터 산다.
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
    const before = firepower(run)
    let best: ArmoryEntry | null = null
    let bestScore = 0

    for (const entry of stock) {
      const key = entry.kind + '/' + entry.label
      if (failed.has(key)) continue
      if (entry.price > run.loadout.brass) continue
      const sc = purchaseValue(run, entry, before)
      if (sc > bestScore) {
        bestScore = sc
        best = entry
      }
    }

    if (best === null) return
    const brassBefore = run.loadout.brass
    buy(run, best)
    if (run.loadout.brass === brassBefore) {
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
  /** null 이 아니면 이 전투 시작 시점의 순서 민감도 표본을 여기에 담는다 */
  orderSink: OrderSample[] | null,
): { win: boolean; peakHeat: number } {
  // 정비소 "회복"/이벤트의 한시 효과는 여기서 정확히 한 번 소비된다.
  const mods = consumeCombatMods(run)
  // 성전 등급 5 "섹터마다 시작 거리 −2m" (GDD §12) — 전투 셋업 소관이라 여기서 얹는다.
  const stakePenalty = run.stake >= 5 ? 2 * Math.max(0, run.sector - 1) : 0
  const start = Math.max(1, enemy.startDist - stakePenalty)
  const staged: EnemyInstance = { ...enemy, startDist: start }

  const rng = makeRng(run.rngState).fork(run.sector * 733 + run.nodeIndex * 17 + 3)
  const s = startCombat(run.loadout, staged, rng, mods)

  // 순열 분석은 반드시 첫 사격 **전에** 한다 — 트레이가 가장 넓고, 온도가 시작값이라
  // 표본끼리 비교 가능한 시점이기 때문이다. previewDamage 는 s 를 건드리지 않는다.
  if (orderSink !== null) {
    for (const sample of sampleOrder(s, run.sector, skill)) orderSink.push(sample)
  }

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

export function simulateRun(
  seed: number,
  skill: BotSkill,
  stake: number,
  opt: SimOptions = { orderAnalysis: false },
): RunResult {
  // newRun 이 resetUidCounter() 를 부르므로 같은 시드는 항상 같은 런이 된다.
  const run = newRun(seed, stake)
  const seenDerelicts = new Set<string>()

  let deathNode: string | null = null
  let peakHeat = 0
  const doorChoices: DoorChoice[] = []
  const orderSamples: OrderSample[] = []
  // 섹터당 몇 번 표본을 뽑았는지 — 후반 섹터가 표본을 독식하지 않게 한다.
  const orderTaken = new Map<number, number>()

  for (let step = 0; step < MAX_NODES && run.status === 'alive'; step += 1) {
    const node = currentNode(run)

    if (node === 'combat' || node === 'boss') {
      let doorIndex = 0
      if (node === 'combat') {
        const doors = rollDoors(run)
        const pick = chooseDoor(run, doors, skill, step)
        doorIndex = pick.index
        doorChoices.push(pick.record)
      }

      const entered = enterDoor(run, doorIndex)
      if (entered.enemy === null) {
        advanceNode(run)
        continue
      }

      const takenHere = orderTaken.get(run.sector) ?? 0
      const wantOrder = opt.orderAnalysis && takenHere < ORDER_PER_SECTOR
      if (wantOrder) orderTaken.set(run.sector, takenHere + 1)

      const res = runCombat(
        run,
        entered.enemy,
        entered.threat,
        skill,
        wantOrder ? orderSamples : null,
      )
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
    doorChoices,
    orderSamples,
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
  orderAnalysis = false,
): { results: RunResult[]; summary: Summary } {
  const results: RunResult[] = []
  // --runs 가 커져도 순열 분석 비용은 상수로 묶는다. 앞쪽 런만 쓰면 시드 편향이 생기므로
  // 전 구간에 균등하게 흩뿌리는 스트라이드 추출을 쓴다.
  const stride = orderAnalysis ? Math.max(1, Math.ceil(n / ORDER_RUN_BUDGET)) : 0
  for (let i = 0; i < n; i += 1) {
    const sampleThis = orderAnalysis && i % stride === 0
    results.push(simulateRun(seedBase + i, skill, stake, { orderAnalysis: sampleThis }))
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

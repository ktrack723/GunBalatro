// 런 진행 상태기 — 섹터/노드 레이아웃, 갈림길, 보상, 정비소·성소 구매를 담당한다.
// 모든 무작위는 run.rngState 에서만 나온다 (withRng / 노드 고정 fork). Math.random 없음.
// 전투 자체는 여기서 하지 않는다. 이 모듈은 "전투 사이"의 모든 결정을 만든다.

import type {
  Ammo,
  AmmoType,
  Attachment,
  DoorOption,
  EnemyArchetypeId,
  EnemyInstance,
  Grade,
  Loadout,
  Magazine,
  NodeKind,
  Rarity,
  RewardItem,
  Rng,
  RunState,
  RunStats,
  SlotKind,
  Threat,
  CombatMods,
} from './types'
import { NODE_MUL, THREAT_RARITY_W, THREAT_REWARD_COUNT } from './types'
import { makeRng } from './rng'
import { ammoLabel, makeAmmo, nextUid, resetUidCounter } from './ammoStats'
import { ATT_BY_ID, attachmentsBySlot, pickAttachment } from './data/attachments'
import { ARCHETYPES, PASSIVES, makeEnemy } from './data/enemies'
import { MAGAZINES, MAG_BY_ID, STARTER_MAGAZINE } from './data/magazines'
import { makeStartingBag } from './data/startingBag'
import {
  MAX_RAIL_SLOTS,
  PRICES,
  ammoPrice,
  attachmentPrice,
  railPrice,
  removalPrice,
  shopPrice,
  upgradePrice,
} from './economy'

// ---------------------------------------------------------------------------
// 구조 상수 (GDD §9)
//   layout = [combat, combat, <special>, boss, armory] — 길이 5, nodeIndex 0..4.
//   마지막 칸이 항상 정비소라서 "섹터당 정비소 1회 보장"이 구조적으로 성립한다.
// ---------------------------------------------------------------------------

/** 정규 런의 마지막 섹터. 9 이상은 엔드리스 구간 */
export const FINAL_SECTOR = 8
/** 섹터 내 마지막 노드 인덱스 */
export const LAST_NODE = 4
/** 런당 유물 등장 상한 (ATTACHMENTS.md §1) */
export const MAX_RELICS = 2
/** 가방이 이보다 작아지는 압축은 팔지 않는다 (events.ts 와 동일 기준) */
const MIN_BAG = 6

const ALL_TYPES: readonly AmmoType[] = ['AP', 'INC', 'HE', 'SANC']
const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'relic']
const RARITY_NAME: Record<Rarity, string> = {
  common: '일반',
  uncommon: '희귀',
  rare: '영웅',
  relic: '유물',
}
/** 정비소 부착물 진열 레어도 분포 (유물은 성소에서만 나온다) */
const SHOP_RARITY: readonly Rarity[] = ['common', 'uncommon', 'rare']
const SHOP_RARITY_W: readonly number[] = [45, 40, 15]
/** 성소 진열 레어도 분포 */
const RELIQUARY_RARITY: readonly Rarity[] = ['rare', 'relic']
const RELIQUARY_RARITY_W: readonly number[] = [85, 15]

/** 등급 +1 (5 상한). 타입 단언 없이 승급을 표현하기 위한 표 */
const NEXT_GRADE: Record<Grade, Grade> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }
const ALL_GRADES: readonly Grade[] = [1, 2, 3, 4, 5]

type HardpointSlot = Exclude<SlotKind, 'rail'>
const HARDPOINTS: readonly HardpointSlot[] = ['barrel', 'handguard', 'optic', 'stock']

// ---------------------------------------------------------------------------
// 문자열 유틸
// ---------------------------------------------------------------------------

/** 한국어 조사 — 마지막 글자의 받침 유무로 고른다 (한글 음절이 아니면 받침 없음 취급) */
function josa(word: string, withJong: string, withoutJong: string): string {
  const code = word.charCodeAt(word.length - 1)
  if (code < 0xac00 || code > 0xd7a3) return word + withoutJong
  return word + ((code - 0xac00) % 28 !== 0 ? withJong : withoutJong)
}

function threatMark(threat: Threat): string {
  let s = ''
  for (let i = 0; i < threat; i++) s += '◆'
  return s
}

// ---------------------------------------------------------------------------
// RNG 접근 — 두 갈래
//   withRng/runRng : run.rngState 를 소비한다 (보상·구매처럼 되돌릴 수 없는 굴림)
//   nodeRng        : seed+좌표로 고정된 독립 스트림 (문·진열처럼 몇 번 조회해도
//                    같아야 하는 굴림). fork 는 부모 상태를 소비하지 않는다.
// ---------------------------------------------------------------------------

/** run.rngState 로 rng 를 만들고, 쓴 만큼 곧바로 되써준다 */
export function withRng<T>(run: RunState, fn: (r: Rng) => T): T {
  const rng = makeRng(run.rngState)
  try {
    return fn(rng)
  } finally {
    run.rngState = rng.state()
  }
}

/** 호출 하나하나가 끝날 때마다 run.rngState 를 저장하는 Rng 래퍼 */
export function runRng(run: RunState): Rng {
  const base = makeRng(run.rngState)
  const save = <T>(v: T): T => {
    run.rngState = base.state()
    return v
  }
  return {
    next(): number {
      return save(base.next())
    },
    int(n: number): number {
      return save(base.int(n))
    },
    pick<T>(arr: readonly T[]): T {
      return save(base.pick(arr))
    },
    shuffle<T>(arr: T[]): T[] {
      return save(base.shuffle(arr))
    },
    weighted<T>(items: readonly T[], weights: readonly number[]): T {
      return save(base.weighted(items, weights))
    },
    state(): number {
      return base.state()
    },
    setState(s: number): void {
      base.setState(s)
      run.rngState = base.state()
    },
    fork(salt: number): Rng {
      return base.fork(salt)
    },
  }
}

/** (seed, 섹터, 노드, salt) 로 고정된 스트림. 몇 번 불러도 같은 결과가 나온다. */
function nodeRng(run: RunState, salt: number): Rng {
  const coord = (run.sector * 8191 + run.nodeIndex * 131 + salt) | 0
  return makeRng(run.seed).fork(coord)
}

// ---------------------------------------------------------------------------
// 섹터 레이아웃
// ---------------------------------------------------------------------------

/**
 * 길이 5. [전투, 전투, 특수, 보스, 정비소]
 * 특수 칸: 섹터 3·5·7 은 성소, 짝수 섹터는 폐허(섹터당 최대 1회), 나머지는 정비소.
 * (엔드리스 구간도 같은 규칙이 이어지도록 "3 이상 홀수 = 성소"로 일반화했다)
 */
export function sectorLayout(sector: number): NodeKind[] {
  const s = Number.isFinite(sector) ? Math.max(1, Math.floor(sector)) : 1
  let special: NodeKind
  if (s >= 3 && s % 2 === 1) special = 'reliquary'
  else if (s % 2 === 0) special = 'derelict'
  else special = 'armory'
  return ['combat', 'combat', special, 'boss', 'armory']
}

/** 지금 서 있는 노드 종류 */
export function currentNode(run: RunState): NodeKind {
  const layout = sectorLayout(run.sector)
  const i = clampInt(run.nodeIndex, 0, layout.length - 1)
  return layout[i]
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : lo
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/** 노드별 HP 배율 (BALANCE.md §3 소형/중형/보스) */
function nodeMulFor(nodeIndex: number): number {
  if (nodeIndex <= 0) return NODE_MUL.small
  if (nodeIndex >= 3) return NODE_MUL.boss
  return NODE_MUL.big
}

// ---------------------------------------------------------------------------
// 성전 등급 (GDD §12) — 이 모듈이 책임지는 항목만 반영한다
//   등급3 적 HP +10% / 등급4 정비소 가격 +40%(economy) / 등급6 보상 레어도 1단계 하향
// ---------------------------------------------------------------------------

function stakeHpMul(stake: number): number {
  return stake >= 3 ? 1.1 : 1
}

function downgradeRarity(r: Rarity): Rarity {
  if (r === 'relic') return 'rare'
  if (r === 'rare') return 'uncommon'
  if (r === 'uncommon') return 'common'
  return 'common'
}

// ---------------------------------------------------------------------------
// 보스 패시브 — 섹터 시작 시 공개, 같은 런에서 중복 없음
//   런 시작 시 시드로 패시브 10종의 순서를 한 번 정해두고 섹터 번호로 꺼내 쓴다.
//   (RunState 에 "이미 쓴 패시브" 필드가 없어도 중복이 원천적으로 불가능해진다)
// ---------------------------------------------------------------------------

const BOSS_SALT = 0x5b055

function bossPassiveOrder(seed: number): string[] {
  const ids = PASSIVES.map((p) => p.id)
  return makeRng(seed).fork(BOSS_SALT).shuffle(ids)
}

function rollBossPassive(run: RunState): string | null {
  const order = bossPassiveOrder(run.seed)
  if (order.length === 0) return null
  const s = Math.max(1, Math.floor(run.sector))
  return order[(s - 1) % order.length]
}

/**
 * 보스가 될 수 있는 아키타입.
 * 보스는 피할 수 없는 노드라 "행동당 요구 화력"(hpMul ÷ 행동 수)이 배회자 기준선을
 * 크게 넘으면 안 된다 — BALANCE.md §7.3 의 최종 난이도 검산이 배회자(×1.0, 6행동)
 * 기준으로 아슬아슬하게 맞춰져 있기 때문이다. 비대체(0.225)·무리(0.26)는 그 검산을
 * 깨뜨리므로 보스에서 제외된다. 아키타입의 진짜 개성인 "행동 수"는 그대로 남는다.
 */
const BOSS_LOAD_TOLERANCE = 1.15

function actionBudget(speed: number, startDist: number): number {
  return Math.max(1, Math.floor(startDist / speed))
}

const BOSS_ARCHETYPES = (() => {
  const load = (hpMul: number, speed: number, dist: number): number =>
    hpMul / actionBudget(speed, dist)
  const base = ARCHETYPES.find((a) => a.id === 'shambler') ?? ARCHETYPES[0]
  const limit = load(base.hpMul, base.speed, base.startDist) * BOSS_LOAD_TOLERANCE
  const pool = ARCHETYPES.filter((a) => load(a.hpMul, a.speed, a.startDist) <= limit)
  return pool.length > 0 ? pool : [base]
})()

/** 섹터 보스의 아키타입 — 섹터마다 고정 (문이 없으므로 굴림을 소비하지 않는다) */
function bossArchetype(run: RunState): EnemyArchetypeId {
  return makeRng(run.seed)
    .fork((BOSS_SALT ^ (run.sector * 7919)) | 0)
    .pick(BOSS_ARCHETYPES).id
}

// ---------------------------------------------------------------------------
// 런 생성
// ---------------------------------------------------------------------------

function emptyStats(): RunStats {
  return {
    combatsWon: 0,
    shotsFired: 0,
    peakHeat: 0,
    totalDamage: 0,
    brassEarned: 0,
    deaths: 0,
  }
}

export function newRun(seed: number, stake = 1): RunState {
  // uid 카운터를 런 시작에 맞춰 초기화한다 — 같은 시드면 탄 uid 까지 같아진다.
  resetUidCounter()

  const s = Number.isFinite(seed) ? Math.floor(seed) | 0 : 0
  const loadout: Loadout = {
    barrel: null,
    handguard: null,
    optic: null,
    stock: null,
    rails: [],
    railSlots: 0,
    magazine: STARTER_MAGAZINE,
    bag: makeStartingBag(),
    brass: 0,
  }

  const run: RunState = {
    seed: s,
    sector: 1,
    nodeIndex: 0,
    loadout,
    doors: null,
    current: null,
    stake: clampInt(stake, 1, 8),
    stats: emptyStats(),
    bossPassiveId: null,
    status: 'alive',
    relicsSeen: 0,
    removals: 0,
    rngState: s,
    pending: { startDistDelta: 0, heatStartDelta: 0 },
    sectorMods: { heatStartDelta: 0, startDistDelta: 0 },
  }

  run.bossPassiveId = rollBossPassive(run)
  run.current = currentNode(run)
  return run
}

// ---------------------------------------------------------------------------
// 갈림길 (GDD §9.2)
// ---------------------------------------------------------------------------

/** 두 문의 위험도는 항상 다르다. (1,2) 또는 (2,3). 낮은 쪽이 항상 왼쪽. */
const THREAT_PAIRS: ReadonlyArray<readonly [Threat, Threat]> = [
  [1, 2],
  [2, 3],
]

function doorLabel(archName: string, threat: Threat, passiveName: string | null): string {
  const head = threatMark(threat) + ' ' + archName
  return passiveName ? head + ' · ' + passiveName : head
}

/**
 * 전투 노드의 문 2개를 만든다. 같은 노드에서 몇 번 불러도 같은 문이 나온다
 * (문은 되굴릴 수 있는 자원이 아니므로 좌표 고정 스트림을 쓴다).
 * 결과는 run.doors 에도 넣어준다.
 */
export function rollDoors(run: RunState): DoorOption[] {
  const rng = nodeRng(run, 11)
  const pair = rng.pick(THREAT_PAIRS)

  // 두 문의 아키타입도 서로 다르게 — "어떤 종류의 문제인지"가 선택의 근거여야 한다.
  const pool = ARCHETYPES.slice()
  rng.shuffle(pool)

  const doors: DoorOption[] = []
  for (let i = 0; i < pair.length; i++) {
    const threat = pair[i]
    const arch = pool[i % pool.length]
    let passiveId: string | null = null
    if (threat === 3 || (threat === 2 && rng.next() < 0.3)) {
      passiveId = rng.pick(PASSIVES).id
    }
    const passiveName = passiveId ? PASSIVES.find((p) => p.id === passiveId)?.name ?? null : null
    let hint = rng.weighted(RARITIES, THREAT_RARITY_W[threat])
    if (run.stake >= 6) hint = downgradeRarity(hint)

    doors.push({
      threat,
      kind: 'combat',
      archetype: arch.id,
      passiveId,
      rewardHint: hint,
      label: doorLabel(arch.name, threat, passiveName),
    })
  }

  run.doors = doors
  return doors
}

/**
 * 문을 열고 노드로 들어간다.
 * 보스 노드는 문이 없으므로 doorIndex 를 무시하고 고정 편성으로 만든다.
 * 보스의 위험도는 1 이다 — BALANCE.md §3 의 보스 HP 표가 T1 기준값이기 때문.
 */
export function enterDoor(
  run: RunState,
  doorIndex: number,
): { node: NodeKind; enemy: EnemyInstance | null; threat: Threat } {
  const layout = sectorLayout(run.sector)
  const idx = clampInt(run.nodeIndex, 0, layout.length - 1)
  const node = layout[idx]
  run.current = node

  if (node === 'boss') {
    const enemy = makeEnemy({
      archetypeId: bossArchetype(run),
      passiveId: run.bossPassiveId,
      sector: run.sector,
      nodeMul: NODE_MUL.boss,
      threat: 1,
      stakeHpMul: stakeHpMul(run.stake),
    })
    run.doors = null
    return { node, enemy, threat: 1 }
  }

  if (node !== 'combat') {
    run.doors = null
    return { node, enemy: null, threat: 1 }
  }

  const doors = run.doors && run.doors.length > 0 ? run.doors : rollDoors(run)
  const door = doors[clampInt(doorIndex, 0, doors.length - 1)]
  const enemy = makeEnemy({
    archetypeId: door.archetype ?? 'shambler',
    passiveId: door.passiveId,
    sector: run.sector,
    nodeMul: nodeMulFor(idx),
    threat: door.threat,
    stakeHpMul: stakeHpMul(run.stake),
  })
  run.doors = null
  return { node, enemy, threat: door.threat }
}

// ---------------------------------------------------------------------------
// 보상방 (GDD §9.5)
// ---------------------------------------------------------------------------

/** 보상 탄의 등급대 — 섹터가 오를수록 통째로 올라간다 */
function ammoGradeBand(sector: number): [Grade, Grade] {
  if (sector <= 2) return [1, 2]
  if (sector <= 4) return [2, 3]
  if (sector <= 6) return [3, 4]
  return [4, 5]
}

function rollAmmo(rng: Rng, lo: Grade, hi: Grade): Ammo {
  const grades = ALL_GRADES.filter((g) => g >= lo && g <= hi)
  const g = grades.length > 0 ? rng.pick(grades) : lo
  return makeAmmo(rng.pick(ALL_TYPES), g, nextUid())
}

/** 장착 중인 부착물 id 집합 (중복 지급 방지) */
function equippedIds(l: Loadout): Set<string> {
  const set = new Set<string>()
  for (const s of HARDPOINTS) {
    const a = l[s]
    if (a) set.add(a.id)
  }
  for (const r of l.rails) {
    if (r) set.add(r.id)
  }
  return set
}

/** 레일 칸이 없으면 레일 부착물은 애초에 진열하지 않는다 (달 곳이 없다) */
function excludeSet(run: RunState): Set<string> {
  const ex = equippedIds(run.loadout)
  if (run.loadout.railSlots <= 0) {
    for (const a of attachmentsBySlot('rail')) ex.add(a.id)
  }
  return ex
}

/** 원하는 레어도가 소진되면 아래 레어도로 물러난다 (유물로는 절대 올라가지 않는다) */
function pickWithFallback(rng: Rng, rarity: Rarity, exclude: Set<string>): Attachment | null {
  const first = pickAttachment(rng, { rarity, exclude })
  if (first) return first
  const order: Rarity[] = ['rare', 'uncommon', 'common']
  for (const r of order) {
    if (r === rarity) continue
    const a = pickAttachment(rng, { rarity: r, exclude })
    if (a) return a
  }
  return null
}

function rollRewardRarity(rng: Rng, run: RunState, threat: Threat): Rarity {
  let r = rng.weighted(RARITIES, THREAT_RARITY_W[threat])
  if (run.stake >= 6) r = downgradeRarity(r)
  if (r === 'relic' && run.relicsSeen >= MAX_RELICS) r = 'rare'
  return r
}

/**
 * 전투 보상 목록. 부착물 2 : 탄 1 (T3 은 부착물 3 : 탄 1).
 * 보스 노드는 GDD §9.3 "대형 보상"이므로 위험도와 무관하게 T3 표로 굴린다.
 * ※ run.rngState 와 run.relicsSeen 을 소비한다 — 보상방마다 정확히 한 번만 부른다.
 */
export function rollRewards(run: RunState, threat: Threat): RewardItem[] {
  const t: Threat = currentNode(run) === 'boss' ? 3 : threat
  const count = THREAT_REWARD_COUNT[t]
  const [lo, hi] = ammoGradeBand(run.sector)

  return withRng(run, (rng) => {
    const exclude = excludeSet(run)
    const out: RewardItem[] = []

    for (let i = 0; i < count - 1; i++) {
      const rarity = rollRewardRarity(rng, run, t)
      const a = pickWithFallback(rng, rarity, exclude)
      if (!a) continue
      exclude.add(a.id)
      if (a.rarity === 'relic') run.relicsSeen += 1
      out.push({ t: 'attachment', attachment: a })
    }

    out.push({ t: 'ammo', ammo: rollAmmo(rng, lo, hi) })
    rng.shuffle(out)
    return out
  })
}

// ---------------------------------------------------------------------------
// 장착 (보상 획득 · 구매 공용)
// ---------------------------------------------------------------------------

/** rails 배열 길이를 railSlots 에 맞춘다 (types.ts 의 "길이 == railSlots" 계약) */
function syncRails(l: Loadout): void {
  if (!Number.isFinite(l.railSlots) || l.railSlots < 0) l.railSlots = 0
  if (l.railSlots > MAX_RAIL_SLOTS) l.railSlots = MAX_RAIL_SLOTS
  while (l.rails.length < l.railSlots) l.rails.push(null)
  while (l.rails.length > l.railSlots) l.rails.pop()
}

/** 레일 칸을 늘린다. 실제 늘어난 칸 수를 돌려준다 (상한 2). */
function growRails(l: Loadout, delta: number): number {
  syncRails(l)
  const before = l.railSlots
  l.railSlots = Math.min(MAX_RAIL_SLOTS, before + Math.max(0, Math.floor(delta)))
  syncRails(l)
  return l.railSlots - before
}

/**
 * 부착물을 장착한다. 하드포인트는 같은 부위를 덮어쓰고, 레일은
 * railIndex → 첫 빈칸 → 0번 칸(교체) 순으로 자리를 고른다.
 * mods.railSlots 를 가진 부착물은 장착과 동시에 레일 칸을 연다.
 * (한 번 열린 레일 칸은 그 부착물을 떼도 닫히지 않는다 — 칸에 든 부착물이 증발하는 것을 막는다)
 */
function equip(run: RunState, a: Attachment, railIndex?: number): string {
  const l = run.loadout
  syncRails(l)

  let msg: string
  if (a.slot === 'rail') {
    if (l.railSlots <= 0) {
      return josa(a.name, '은', '는') + ' 달 보조 레일이 없다.'
    }
    let idx = -1
    if (railIndex !== undefined && railIndex >= 0 && railIndex < l.rails.length) {
      idx = railIndex
    } else {
      for (let i = 0; i < l.rails.length; i++) {
        if (l.rails[i] === null) {
          idx = i
          break
        }
      }
      if (idx < 0) idx = 0
    }
    const old = l.rails[idx]
    l.rails[idx] = a
    msg = (old ? old.name + ' 대신 ' : '') + josa(a.name, '을', '를') + ' 보조 레일에 달았다.'
  } else {
    const slot: HardpointSlot = a.slot
    const old = l[slot]
    l[slot] = a
    msg = (old ? old.name + ' 대신 ' : '') + josa(a.name, '을', '를') + ' 장착했다.'
  }

  const add = a.mods?.railSlots
  if (add !== undefined && add > 0) {
    const grown = growRails(l, add)
    if (grown > 0) msg += ' 보조 레일 ' + grown + '칸이 열렸다.'
  }
  return msg
}

/**
 * 보상 1개를 실제로 획득한다. 결과 문장을 돌려준다.
 * railIndex 는 레일 부착물을 어느 칸에 달지 지정할 때만 쓴다.
 */
export function applyReward(run: RunState, item: RewardItem, railIndex?: number): string {
  switch (item.t) {
    case 'attachment':
      return equip(run, item.attachment, railIndex)
    case 'ammo':
      run.loadout.bag.push(item.ammo)
      return ammoLabel(item.ammo) + ' 1발을 가방에 넣었다.'
    case 'magazine': {
      const old = run.loadout.magazine
      run.loadout.magazine = item.magazine
      return old.name + ' 대신 ' + josa(item.magazine.name, '을', '를') + ' 물렸다.'
    }
  }
}

// ---------------------------------------------------------------------------
// 진행
// ---------------------------------------------------------------------------

/**
 * 다음 노드로. nodeIndex 가 4를 넘으면 다음 섹터로 넘어가며 보스 패시브를 새로 공개한다.
 * 섹터 8 을 넘기면 status='won'. 엔드리스는 별도 플래그 없이 그대로 계속 진행된다.
 */
export function advanceNode(run: RunState): void {
  if (run.status === 'dead') return

  run.doors = null
  run.nodeIndex += 1

  if (run.nodeIndex > LAST_NODE) {
    run.nodeIndex = 0
    run.sector += 1
    // 섹터 지속 효과는 섹터가 넘어가는 순간 사라진다.
    run.sectorMods = { heatStartDelta: 0, startDistDelta: 0 }
    if (run.sector > FINAL_SECTOR) run.status = 'won'
    run.bossPassiveId = rollBossPassive(run)
  }

  run.current = currentNode(run)
}

// ---------------------------------------------------------------------------
// 정비소 / 성소 (GDD §9.3, BALANCE.md §5)
//   진열은 좌표 고정 스트림으로 만든다 — 화면을 다시 그려도 물건이 바뀌지 않는다.
// ---------------------------------------------------------------------------

export interface ArmoryEntry {
  kind: 'ammo' | 'removal' | 'upgrade' | 'attachment' | 'magazine' | 'rail' | 'heal'
  price: number
  label: string
  payload?: unknown
}

interface AmmoPayload {
  type: AmmoType
  grade: Grade
}
interface TargetPayload {
  uid?: string
}
interface AttachmentPayload {
  attachment: Attachment
  railIndex?: number
}
interface MagazinePayload {
  magazine: Magazine
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asAmmoPayload(p: unknown): AmmoPayload | null {
  if (!isRecord(p)) return null
  const t = p.type
  const g = p.grade
  if (typeof t !== 'string' || typeof g !== 'number') return null
  if (t !== 'AP' && t !== 'INC' && t !== 'HE' && t !== 'SANC') return null
  if (g !== 1 && g !== 2 && g !== 3 && g !== 4 && g !== 5) return null
  return { type: t, grade: g }
}

function asTargetPayload(p: unknown): TargetPayload {
  if (!isRecord(p)) return {}
  const uid = p.uid
  return typeof uid === 'string' ? { uid } : {}
}

function asAttachmentPayload(p: unknown): AttachmentPayload | null {
  if (!isRecord(p)) return null
  const raw = p.attachment
  if (!isRecord(raw)) return null
  const id = raw.id
  if (typeof id !== 'string') return null
  const att = ATT_BY_ID[id]
  if (!att) return null
  const ri = p.railIndex
  return typeof ri === 'number' ? { attachment: att, railIndex: ri } : { attachment: att }
}

function asMagazinePayload(p: unknown): MagazinePayload | null {
  if (!isRecord(p)) return null
  const raw = p.magazine
  if (!isRecord(raw)) return null
  const id = raw.id
  if (typeof id !== 'string') return null
  const mag = MAG_BY_ID[id]
  return mag ? { magazine: mag } : null
}

/** 정비소에서 파는 탄의 등급 상한 — 보상 등급대의 위쪽 끝과 맞춘다 */
function shopGradeCap(sector: number): Grade {
  return ammoGradeBand(sector)[1]
}

function ammoEntry(run: RunState, type: AmmoType, grade: Grade): ArmoryEntry {
  const payload: AmmoPayload = { type, grade }
  return {
    kind: 'ammo',
    price: shopPrice(ammoPrice(grade), run.stake),
    label: ammoLabel({ uid: '#shop', type, grade }) + ' 구매',
    payload,
  }
}

function attachmentEntry(run: RunState, a: Attachment): ArmoryEntry {
  const payload: AttachmentPayload = { attachment: a }
  return {
    kind: 'attachment',
    price: shopPrice(attachmentPrice(a.rarity), run.stake),
    label: a.name + ' (' + RARITY_NAME[a.rarity] + ')',
    payload,
  }
}

/**
 * 정비소 진열: 탄 3 · 제거 1 · 승급 1 · 부착물 2 · 회복 1.
 * 승급가는 표시상 30 이며, Mk.IV 를 고르면 buy() 가 70 으로 다시 계산한다.
 */
export function armoryStock(run: RunState): ArmoryEntry[] {
  const rng = nodeRng(run, 21)
  const out: ArmoryEntry[] = []

  const cap = shopGradeCap(run.sector)
  const grades = ALL_GRADES.filter((g) => g <= cap)
  for (let i = 0; i < 3; i++) {
    out.push(ammoEntry(run, rng.pick(ALL_TYPES), rng.pick(grades)))
  }

  out.push({
    kind: 'removal',
    price: shopPrice(removalPrice(run.removals), run.stake),
    label: '가방에서 탄 1발 제거',
  })

  out.push({
    kind: 'upgrade',
    price: shopPrice(PRICES.upgrade, run.stake),
    label: '탄 1발 등급 +1 (Mk.IV→V 는 ' + PRICES.upgradeToV + ')',
  })

  const exclude = excludeSet(run)
  for (let i = 0; i < 2; i++) {
    const rarity = rng.weighted(SHOP_RARITY, SHOP_RARITY_W)
    const a = pickWithFallback(rng, rarity, exclude)
    if (!a) continue
    exclude.add(a.id)
    out.push(attachmentEntry(run, a))
  }

  out.push({
    kind: 'heal',
    price: shopPrice(PRICES.heal, run.stake),
    label: '응급 보급 — 다음 전투 시작 거리 +10m',
  })

  return out
}

/** 성소 진열: 영웅/유물 부착물 3 · 보조 레일 확장 · 탄창 교체 */
export function reliquaryStock(run: RunState): ArmoryEntry[] {
  const rng = nodeRng(run, 31)
  const out: ArmoryEntry[] = []

  const exclude = excludeSet(run)
  for (let i = 0; i < 3; i++) {
    let rarity = rng.weighted(RELIQUARY_RARITY, RELIQUARY_RARITY_W)
    if (rarity === 'relic' && run.relicsSeen >= MAX_RELICS) rarity = 'rare'
    const a = pickWithFallback(rng, rarity, exclude)
    if (!a) continue
    exclude.add(a.id)
    out.push(attachmentEntry(run, a))
  }

  if (run.loadout.railSlots < MAX_RAIL_SLOTS) {
    const owned = Math.max(0, run.loadout.railSlots)
    out.push({
      kind: 'rail',
      price: shopPrice(railPrice(owned), run.stake),
      label: '보조 레일 확장 (' + (owned + 1) + '번째)',
    })
  }

  const others = MAGAZINES.filter((m) => m.id !== run.loadout.magazine.id)
  if (others.length > 0) {
    const mag = rng.pick(others)
    const payload: MagazinePayload = { magazine: mag }
    out.push({
      kind: 'magazine',
      price: shopPrice(PRICES.magazine, run.stake),
      label: '탄창 교체 — ' + mag.name,
      payload,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// 다음 전투 한정 거리 보너스 (정비소 "회복")
//   RunState 에 담을 필드가 없어 모듈 스코프에 붙여 둔다. 전투 시작 시
//   consumeCombatMods(run) 으로 전투 시작 시 한 번만 꺼내 쓴다.
// ---------------------------------------------------------------------------

export function distanceBonus(run: RunState): number {
  return run.pending.startDistDelta
}

export function addDistanceBonus(run: RunState, meters: number): void {
  if (!Number.isFinite(meters)) return
  run.pending.startDistDelta += meters
}

export function addPendingHeat(run: RunState, heat: number): void {
  if (!Number.isFinite(heat)) return
  run.pending.heatStartDelta += heat
}

/**
 * 전투 시작 시 1회 소비. pending(1회성)은 비우고 sectorMods(섹터 지속)는 유지한다.
 */
export function consumeCombatMods(run: RunState): CombatMods {
  const mods: CombatMods = {
    startDistDelta: run.pending.startDistDelta + run.sectorMods.startDistDelta,
    heatStartDelta: run.pending.heatStartDelta + run.sectorMods.heatStartDelta,
  }
  run.pending = { startDistDelta: 0, heatStartDelta: 0 }
  return mods
}

// ---------------------------------------------------------------------------
// 구매
// ---------------------------------------------------------------------------

/** 실제로 지불해야 할 값. 승급만 대상 등급에 따라 다시 계산한다. */
function realPrice(run: RunState, entry: ArmoryEntry, target: Ammo | null): number {
  if (entry.kind === 'upgrade') {
    return shopPrice(upgradePrice(target ? target.grade : 1), run.stake)
  }
  return Math.max(0, Math.floor(entry.price))
}

/** 승급/제거 대상 탄 찾기. uid 가 없으면 무작위로 고른다. */
function findTarget(run: RunState, uid: string | undefined, ok: (a: Ammo) => boolean): number {
  const bag = run.loadout.bag
  if (uid !== undefined) {
    for (let i = 0; i < bag.length; i++) {
      if (bag[i].uid === uid) return ok(bag[i]) ? i : -1
    }
    return -1
  }
  const cand: number[] = []
  for (let i = 0; i < bag.length; i++) {
    if (ok(bag[i])) cand.push(i)
  }
  if (cand.length === 0) return -1
  return withRng(run, (rng) => rng.pick(cand))
}

/**
 * 진열품 하나를 산다. 성공하면 탄피를 깎고 효과를 적용한 뒤 결과 문장을 돌려준다.
 * 실패해도 상태는 그대로 두고 이유만 문장으로 돌려준다.
 */
export function buy(run: RunState, entry: ArmoryEntry): string {
  const l = run.loadout

  switch (entry.kind) {
    case 'ammo': {
      const p = asAmmoPayload(entry.payload)
      if (!p) return '살 수 없는 물건이다.'
      const price = realPrice(run, entry, null)
      if (l.brass < price) return '탄피가 부족하다.'
      l.brass -= price
      const ammo = makeAmmo(p.type, p.grade, nextUid())
      l.bag.push(ammo)
      return ammoLabel(ammo) + ' 1발을 샀다.'
    }

    case 'removal': {
      if (l.bag.length <= MIN_BAG) return '가방이 더 얇아지면 안 된다.'
      const t = asTargetPayload(entry.payload)
      const i = findTarget(run, t.uid, () => true)
      if (i < 0) return '제거할 탄을 찾지 못했다.'
      const price = realPrice(run, entry, null)
      if (l.brass < price) return '탄피가 부족하다.'
      l.brass -= price
      const gone = l.bag.splice(i, 1)[0]
      run.removals += 1
      return ammoLabel(gone) + ' 1발을 가방에서 덜어냈다.'
    }

    case 'upgrade': {
      const t = asTargetPayload(entry.payload)
      const i = findTarget(run, t.uid, (a) => a.grade < 5)
      if (i < 0) return '승급할 탄이 없다.'
      const target = l.bag[i]
      const price = realPrice(run, entry, target)
      if (l.brass < price) return '탄피가 부족하다.'
      l.brass -= price
      const before = ammoLabel(target)
      const up = makeAmmo(target.type, NEXT_GRADE[target.grade], target.uid)
      l.bag[i] = up
      return before + ' → ' + ammoLabel(up) + ' 로 승급했다.'
    }

    case 'attachment': {
      const p = asAttachmentPayload(entry.payload)
      if (!p) return '살 수 없는 물건이다.'
      const price = realPrice(run, entry, null)
      if (l.brass < price) return '탄피가 부족하다.'
      if (p.attachment.slot === 'rail' && l.railSlots <= 0) {
        return josa(p.attachment.name, '은', '는') + ' 달 보조 레일이 없다.'
      }
      l.brass -= price
      if (p.attachment.rarity === 'relic') run.relicsSeen += 1
      return equip(run, p.attachment, p.railIndex)
    }

    case 'magazine': {
      const p = asMagazinePayload(entry.payload)
      if (!p) return '살 수 없는 물건이다.'
      const price = realPrice(run, entry, null)
      if (l.brass < price) return '탄피가 부족하다.'
      l.brass -= price
      const old = l.magazine
      l.magazine = p.magazine
      return old.name + ' 대신 ' + josa(p.magazine.name, '을', '를') + ' 물렸다.'
    }

    case 'rail': {
      if (l.railSlots >= MAX_RAIL_SLOTS) return '보조 레일은 두 칸이 끝이다.'
      const price = realPrice(run, entry, null)
      if (l.brass < price) return '탄피가 부족하다.'
      l.brass -= price
      growRails(l, 1)
      return '보조 레일 ' + l.railSlots + '번째 칸이 열렸다.'
    }

    case 'heal': {
      const price = realPrice(run, entry, null)
      if (l.brass < price) return '탄피가 부족하다.'
      l.brass -= price
      addDistanceBonus(run, 10)
      return '다음 전투를 10m 더 멀리서 시작한다.'
    }
  }
}

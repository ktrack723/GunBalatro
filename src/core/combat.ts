// 전투 상태 기계: 전투 시작 / 드로우 / 사격 행동 / 배출 행동 / 승패 판정을 담당한다.
// 실제 한 발의 계산은 전부 pipeline.fireOneShot 에 위임하고, 여기서는 "행동 단위" 규칙만 다룬다.
// 미리보기는 cloneState 로 완전히 격리된 사본 위에서 돌린다 — 원본과 rng 를 절대 건드리지 않는다.

import type {
  Ammo,
  CombatCtx,
  CombatState,
  EnemyInstance,
  FireEvent,
  Loadout,
  MagCtx,
  Rng,
  CombatMods,
} from './types'
import { BASE_HEAT } from './types'
import { makeRng } from './rng'
import {
  computeCap,
  computeEjectCost,
  computeEnemySpeed,
  computeFireCost,
  computeStartDistance,
  computeTraySize,
  fireOneShot,
  orderedAttachments,
  safeCall,
} from './pipeline'

// ---------------------------------------------------------------------------
// 예약 키 / 상수
// ---------------------------------------------------------------------------

/** 냉각 자켓(M7)이 heatStartBase 에 얹어 둔 "이월분". 영구 누적분과 분리해 두려고 쓴다. */
const K_HEAT_CARRY = '__heatCarry'
/** onCombatEnd 를 정확히 1회만 호출하기 위한 표식 */
const F_COMBAT_ENDED = '__combatEnded'

/** 미소모 탄창(M3)의 무한루프 방지 상한 */
const MAX_SHOTS_PER_MAG = 60

/** 한 번의 배출로 뺄 수 있는 최대 발수 */
const MAX_EJECT = 3

export function maxEject(_s: CombatState): number {
  return MAX_EJECT
}

// ---------------------------------------------------------------------------
// 훅 순회 (부착물 → 탄창 → 적 패시브)
// ---------------------------------------------------------------------------

function runCombatStart(s: CombatState): void {
  // 기계교 각인이 순회 중에 attachments 를 늘릴 수 있으므로 인덱스 루프로 돈다.
  // (복제 대상 풀에서 유물을 제외하므로 증식은 최대 1회에서 멈춘다.)
  for (let i = 0; i < s.attachments.length; i += 1) {
    const a = s.attachments[i]
    const hook = a.hooks?.onCombatStart
    if (hook === undefined) continue
    const c: CombatCtx = { s, self: a.id }
    safeCall(`${a.id}.onCombatStart`, () => hook(c))
  }
  const mag = s.loadout.magazine
  const magHook = mag.hooks?.onCombatStart
  if (magHook !== undefined) {
    const c: CombatCtx = { s, self: mag.id }
    safeCall(`${mag.id}.onCombatStart`, () => magHook(c))
  }
  const p = s.enemy.passive
  const pHook = p?.onCombatStart
  if (p !== null && pHook !== undefined) {
    const c: CombatCtx = { s, self: p.id }
    safeCall(`${p.id}.onCombatStart`, () => pHook(c))
  }
}

function runCombatEnd(s: CombatState): void {
  // EnemyPassive 에는 onCombatEnd 가 없다 (types.ts 계약). 부착물 + 탄창만 돈다.
  for (const a of s.attachments) {
    const hook = a.hooks?.onCombatEnd
    if (hook === undefined) continue
    const c: CombatCtx = { s, self: a.id }
    safeCall(`${a.id}.onCombatEnd`, () => hook(c))
  }
  const mag = s.loadout.magazine
  const magHook = mag.hooks?.onCombatEnd
  if (magHook !== undefined) {
    const c: CombatCtx = { s, self: mag.id }
    safeCall(`${mag.id}.onCombatEnd`, () => magHook(c))
  }
}

function runMagStart(s: CombatState): void {
  for (const a of s.attachments) {
    const hook = a.hooks?.onMagStart
    if (hook === undefined) continue
    const c: MagCtx = { s, self: a.id, plan: s.magPlan }
    safeCall(`${a.id}.onMagStart`, () => hook(c))
  }
  const mag = s.loadout.magazine
  const magHook = mag.hooks?.onMagStart
  if (magHook !== undefined) {
    const c: MagCtx = { s, self: mag.id, plan: s.magPlan }
    safeCall(`${mag.id}.onMagStart`, () => magHook(c))
  }
  const p = s.enemy.passive
  const pHook = p?.onMagStart
  if (p !== null && pHook !== undefined) {
    const c: MagCtx = { s, self: p.id, plan: s.magPlan }
    safeCall(`${p.id}.onMagStart`, () => pHook(c))
  }
}

function runMagEnd(s: CombatState): void {
  for (const a of s.attachments) {
    const hook = a.hooks?.onMagEnd
    if (hook === undefined) continue
    const c: MagCtx = { s, self: a.id, plan: s.magPlan }
    safeCall(`${a.id}.onMagEnd`, () => hook(c))
  }
  const mag = s.loadout.magazine
  const magHook = mag.hooks?.onMagEnd
  if (magHook !== undefined) {
    const c: MagCtx = { s, self: mag.id, plan: s.magPlan }
    safeCall(`${mag.id}.onMagEnd`, () => magHook(c))
  }
  const p = s.enemy.passive
  const pHook = p?.onMagEnd
  if (p !== null && pHook !== undefined) {
    const c: MagCtx = { s, self: p.id, plan: s.magPlan }
    safeCall(`${p.id}.onMagEnd`, () => pHook(c))
  }
}

// ---------------------------------------------------------------------------
// 전투 시작
// ---------------------------------------------------------------------------

export function startCombat(
  loadout: Loadout,
  enemy: EnemyInstance,
  rng: Rng,
  mods?: CombatMods,
): CombatState {
  const speed = computeEnemySpeed(loadout, enemy.speed)
  // 적 개체는 사본으로 들고 간다 — 전투가 호출자의 EnemyInstance 를 파괴하지 않게 한다.
  const e: EnemyInstance = { ...enemy, speed }

  const s: CombatState = {
    enemy: e,
    distance: computeStartDistance(loadout, enemy) + (mods?.startDistDelta ?? 0),

    // 가방은 loadout.bag 의 사본이다. 역병/예지 렌즈가 splice 로 파먹기 때문에
    // 원본을 그대로 쓰면 런 전체의 덱이 전투 중에 사라진다.
    bag: loadout.bag.slice(),
    tray: [],
    spent: [],
    reserve: [],

    traySize: computeTraySize(loadout),
    cap: computeCap(loadout),

    heat: BASE_HEAT,
    heatStartBase: (loadout.magazine.startHeat ?? BASE_HEAT) + (mods?.heatStartDelta ?? 0),
    peakHeat: 0,

    magsFired: 0,
    ejectsUsed: 0,
    shotsFired: 0,
    totalDamage: 0,

    magPlan: [],
    magFired: [],
    magDamage: 0,
    abortMag: false,
    pendingNextDmg: 0,
    heatDoublePending: false,

    vars: {},
    flags: {},

    fireCost: computeFireCost(loadout, e, speed),
    ejectCost: computeEjectCost(loadout, e, speed),

    rng,
    loadout,
    attachments: orderedAttachments(loadout),
    hiddenTrayCount: enemy.passive?.hiddenTrayCount ?? 0,
    dryRun: false,
    outcome: 'ongoing',
  }

  s.heat = s.heatStartBase
  s.vars[K_HEAT_CARRY] = 0

  // 볼터의 원형은 s.bag 을 읽고, 탄약 주머니는 reserve 를 채우고,
  // 기계교 각인은 attachments 를 늘린다 → 가방을 채운 뒤에 훅을 돌린다.
  runCombatStart(s)

  rng.shuffle(s.bag)
  drawToTray(s)

  return s
}

// ---------------------------------------------------------------------------
// 드로우
// ---------------------------------------------------------------------------

/** 가방이 비면 소각 더미를 전부 회수해 재셔플한다 (GDD §5.4 탄약 재보급). */
function recycleSpent(s: CombatState): boolean {
  if (s.spent.length === 0) return false
  for (const a of s.spent) s.bag.push(a)
  s.spent.length = 0
  s.rng.shuffle(s.bag)
  return true
}

/** 황제의 눈: 트레이가 가방 전체가 된다 → traySize 를 매번 다시 잡는다. */
function refreshFullTray(s: CombatState): void {
  if (s.flags['fullTray'] !== true) return
  if (s.bag.length === 0) recycleSpent(s)
  s.traySize = s.tray.length + s.bag.length
}

export function drawToTray(s: CombatState): void {
  refreshFullTray(s)
  let guard = 0
  while (s.tray.length < s.traySize) {
    if (s.bag.length === 0 && !recycleSpent(s)) break
    const a = s.bag.pop()
    if (a === undefined) break
    s.tray.push(a)
    guard += 1
    if (guard > 512) break // 방어: traySize 가 비정상적으로 커도 멈춘다
  }
}

// ---------------------------------------------------------------------------
// 사격 행동
// ---------------------------------------------------------------------------

/** 장전한 탄을 트레이(또는 예비칸)에서 뺀다. 이미 없으면 조용히 넘어간다. */
function takeFromHand(s: CombatState, ammo: Ammo): void {
  const ti = s.tray.findIndex((a) => a.uid === ammo.uid)
  if (ti >= 0) {
    s.tray.splice(ti, 1)
    return
  }
  const ri = s.reserve.findIndex((a) => a.uid === ammo.uid)
  if (ri >= 0) s.reserve.splice(ri, 1)
}

/**
 * 이번 탄창의 "실제 발사 순서"를 확정한다.
 * 미소모 확률(M3 탐식의 성궤)이 있는 탄창은 소모 판정을 먼저 전부 굴려서
 * 발사 순서를 만든다 — 그래야 isLast(마지막 탄) 판정이 정확해진다.
 * keep[i] 가 true 면 그 발사에서 탄이 소모되지 않았다는 뜻이다.
 */
function buildShotSequence(s: CombatState): { seq: Ammo[]; keep: boolean[] } {
  const plan = s.magPlan
  const p = s.loadout.magazine.notConsumedChance
  const hasChance = typeof p === 'number' && Number.isFinite(p) && p > 0

  if (!hasChance || plan.length === 0) {
    return { seq: plan, keep: [] }
  }

  const seq: Ammo[] = []
  const keep: boolean[] = []

  if (s.dryRun) {
    // 미리보기는 확률을 굴리지 않는다 (rng 소비 금지 + 결정론).
    // 기대 발수 = cap / (1 - p) 만큼 plan 을 순환한 것으로 근사한다.
    const n = p >= 0.999 ? MAX_SHOTS_PER_MAG : Math.round(s.cap / (1 - p))
    const total = Math.max(1, Math.min(MAX_SHOTS_PER_MAG, n))
    for (let i = 0; i < total; i += 1) {
      seq.push(plan[i % plan.length])
      keep.push(false)
    }
    return { seq, keep }
  }

  const remaining = plan.slice()
  let cursor = 0
  while (remaining.length > 0 && seq.length < MAX_SHOTS_PER_MAG) {
    if (cursor >= remaining.length) cursor = 0
    seq.push(remaining[cursor])
    const notConsumed = s.rng.next() < p
    keep.push(notConsumed)
    if (notConsumed) cursor += 1
    else remaining.splice(cursor, 1) // 소모 → cursor 가 곧 다음 탄을 가리킨다
  }
  return { seq, keep }
}

export function fire(s: CombatState, plan: Ammo[]): FireEvent[] {
  const out: FireEvent[] = []
  if (s.outcome !== 'ongoing') return out

  // --- 0. 방어: 유효한 탄만, 용량까지만 -------------------------------------
  const clean: Ammo[] = []
  for (const a of plan) {
    if (a === null || a === undefined) continue
    if (clean.length >= s.cap) break // 초과분은 예외 대신 잘라낸다
    clean.push(a)
  }
  for (const a of clean) takeFromHand(s, a)

  // --- 1. 탄창 스코프 초기화 --------------------------------------------------
  s.magPlan = clean.slice()
  s.magFired = []
  s.magDamage = 0
  s.abortMag = false
  s.pendingNextDmg = 0
  s.heatDoublePending = false

  // --- 2. 온도 초기화 ---------------------------------------------------------
  // 두 이월 규칙의 우선순위를 여기서 못박는다.
  //  (a) 영원한 불(flags.eternalFlame): 온도를 리셋하지 않고 max(1, heat−5) 로 넘긴다.
  //  (b) 그 외: heatStartBase 로 리셋한다. 냉각 자켓(heatCarryRatio)의 이월분은
  //      직전 사격의 magEnd 에서 이미 heatStartBase 에 합산해 뒀으므로 여기선 아무것도 안 한다.
  //  둘이 동시에 걸리면 (a)가 이긴다 — 같은 온도를 두 번 이월하면 사실상 곱셈이 되기 때문이다.
  if (s.flags['eternalFlame'] === true) {
    s.heat = Math.max(BASE_HEAT, s.heat - 5)
  } else {
    s.heat = s.heatStartBase
  }
  if (s.heat > s.peakHeat) s.peakHeat = s.heat

  // --- 3. onMagStart (성별 렌즈·예지 렌즈가 magPlan 을 직접 고친다) -----------
  runMagStart(s)
  out.push({ t: 'magStart', plan: s.magPlan.slice(), heat: s.heat })

  // --- 4. 발사 루프 -----------------------------------------------------------
  const { seq, keep } = buildShotSequence(s)
  for (let i = 0; i < seq.length; i += 1) {
    fireOneShot(s, seq[i], i, seq, out)
    if (keep[i] === true) out.push({ t: 'notConsumed', index: i, ammo: seq[i] })
    if (s.enemy.hp <= 0) break
    if (s.abortMag) break
  }

  // --- 5. 소모 처리 → onMagEnd -----------------------------------------------
  // 장전한 탄은 (중단되었더라도) 전부 소모되어 소각 더미로 간다.
  // 자동 급탄기가 onMagEnd 에서 spent 를 뒤지므로 훅보다 먼저 옮겨야 한다.
  for (const a of s.magPlan) s.spent.push(a)

  runMagEnd(s)

  // 냉각 자켓 이월. 순교의 화로가 onMagEnd 에서 heatStartBase 에 영구 가산을 얹으므로,
  // "영구 누적분 = 현재 heatStartBase − 지난번 이월분" 으로 분리해야 둘이 서로를 지우지 않는다.
  const ratio = s.loadout.magazine.heatCarryRatio
  const carryNow =
    typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? s.heat * ratio : 0
  const prevCarry = s.vars[K_HEAT_CARRY] ?? 0
  s.heatStartBase = s.heatStartBase - prevCarry + carryNow
  s.vars[K_HEAT_CARRY] = carryNow

  out.push({ t: 'magEnd', heatCarried: carryNow, totalDamage: s.magDamage })

  // --- 6. 거리 소모 -----------------------------------------------------------
  s.distance -= s.fireCost
  out.push({ t: 'advance', meters: s.fireCost, distanceAfter: s.distance })
  s.magsFired += 1

  // --- 7. 재보충 & 판정 -------------------------------------------------------
  drawToTray(s)
  settleOutcome(s, out)
  return out
}

// ---------------------------------------------------------------------------
// 배출 행동
// ---------------------------------------------------------------------------

export function eject(s: CombatState, uids: string[]): FireEvent[] {
  const out: FireEvent[] = []
  if (s.outcome !== 'ongoing') return out

  const limit = maxEject(s)
  let moved = 0
  for (const uid of uids) {
    if (moved >= limit) break
    const i = s.tray.findIndex((a) => a.uid === uid)
    if (i < 0) continue
    const taken = s.tray.splice(i, 1)
    if (taken.length === 0) continue
    s.spent.push(taken[0])
    moved += 1
  }
  // 실제로 뺀 탄이 없으면 거리를 먹지 않는다 (UI 실수로 자살하지 않도록).
  if (moved === 0) return out

  // 무한 탄약고는 상시 무료, 탄도 계산기는 1회용 충전식이다.
  let cost = s.ejectCost
  if (s.flags['freeEjectAlways'] === true) {
    cost = 0
  } else if (s.flags['freeEject'] === true) {
    cost = 0
    s.flags['freeEject'] = false
  }

  s.ejectsUsed += 1
  s.distance -= cost
  out.push({ t: 'advance', meters: cost, distanceAfter: s.distance })

  drawToTray(s)
  settleOutcome(s, out)
  return out
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------

export function checkOutcome(s: CombatState): 'ongoing' | 'win' | 'lose' {
  if (s.enemy.hp <= 0) return 'win'
  if (s.distance <= 0) return 'lose'
  return 'ongoing'
}

/** 판정 결과를 상태에 반영하고, 처음 종료되는 순간에만 onCombatEnd 를 돌린다. */
function settleOutcome(s: CombatState, out: FireEvent[]): void {
  const o = checkOutcome(s)
  s.outcome = o
  if (o === 'ongoing') return
  if (o === 'lose') out.push({ t: 'playerDead' })
  if (s.flags[F_COMBAT_ENDED] === true) return
  s.flags[F_COMBAT_ENDED] = true
  runCombatEnd(s)
}

// ---------------------------------------------------------------------------
// 미리보기
// ---------------------------------------------------------------------------

/**
 * 원본을 전혀 건드리지 않고 이번 사격의 총 피해를 예측한다.
 * 사본의 rng 는 makeRng(state) 로 새로 만들기 때문에 원본 rng 스트림도 그대로 남는다.
 */
export function previewDamage(
  s: CombatState,
  plan: Ammo[],
): { expected: number; approximate: boolean } {
  const clone = cloneState(s)
  clone.dryRun = true
  fire(clone, plan)

  const p = s.loadout.magazine.notConsumedChance
  const randomMag = typeof p === 'number' && Number.isFinite(p) && p > 0
  // 도박꾼의 성구는 dryRun 에서 기대값(+55)으로 대체되므로 이것도 근사다.
  const randomAtt = s.attachments.some((a) => a.id === 'rl_gambler_litany')

  return {
    expected: clone.totalDamage - s.totalDamage,
    approximate: randomMag || randomAtt,
  }
}

/**
 * 손으로 쓴 깊은 복사. Ammo 는 불변으로 취급해 얕게 공유하고,
 * 배열/레코드만 새로 만든다. loadout·archetype·passive 는 읽기 전용이라 공유해도 안전하다.
 */
export function cloneState(s: CombatState): CombatState {
  return {
    enemy: { ...s.enemy },
    distance: s.distance,

    bag: s.bag.slice(),
    tray: s.tray.slice(),
    spent: s.spent.slice(),
    reserve: s.reserve.slice(),

    traySize: s.traySize,
    cap: s.cap,

    heat: s.heat,
    heatStartBase: s.heatStartBase,
    peakHeat: s.peakHeat,

    magsFired: s.magsFired,
    ejectsUsed: s.ejectsUsed,
    shotsFired: s.shotsFired,
    totalDamage: s.totalDamage,

    magPlan: s.magPlan.slice(),
    magFired: s.magFired.slice(),
    magDamage: s.magDamage,
    abortMag: s.abortMag,
    pendingNextDmg: s.pendingNextDmg,
    heatDoublePending: s.heatDoublePending,

    vars: { ...s.vars },
    flags: { ...s.flags },

    fireCost: s.fireCost,
    ejectCost: s.ejectCost,

    // 원본 rng 를 소비하지 않도록 상태만 복사한 독립 스트림을 준다.
    rng: makeRng(s.rng.state()),
    loadout: s.loadout,
    attachments: s.attachments.slice(),
    hiddenTrayCount: s.hiddenTrayCount,
    dryRun: s.dryRun,
    outcome: s.outcome,
  }
}

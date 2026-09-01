// 자동 플레이 봇 — 트레이에서 어떤 탄을 어떤 순서로 장전할지(그리고 배출할지) 결정한다.
// 평가는 전부 core 의 previewDamage 로 하고, 후보 수는 해석적 근사로 미리 쳐낸다.
// core 를 읽기만 하며 규칙을 새로 만들지 않는다 — 봇은 "플레이어 흉내"일 뿐이다.

import type { Ammo, CombatState } from '../core/types'
import { ammoStats } from '../core/ammoStats'
import { eject, fire, previewDamage } from '../core/combat'

export type BotSkill = 'greedy' | 'optimal'

export type BotAction = { kind: 'fire'; plan: Ammo[] } | { kind: 'eject'; uids: string[] }

// ---------------------------------------------------------------------------
// 탐색 예산 — previewDamage 1회 ≈ 6.5µs 라서 결정 1회당 상한을 둔다.
// ---------------------------------------------------------------------------

/** optimal 이 한 번의 결정에 쓰는 previewDamage 호출 상한(대략치) */
const PREVIEW_BUDGET = 400
/** 조합을 뽑아낼 트레이 상위 후보 수 */
const POOL_SIZE = 8
/** 순열 전탐색을 허용하는 최대 탄창 용량 (그 위는 언덕오르기) */
const MAX_PERM_CAP = 6
/** 한 전투에서 허용하는 최대 행동 수 (무한루프 방지) */
export const MAX_ACTIONS = 40
/** 한 전투에서 허용하는 최대 배출 횟수 */
const MAX_EJECTS = 6
/** 트레이를 갈아엎었을 때 기대할 수 있는 화력 개선 배수 (이보다 모자라면 배출해도 진다) */
const EJECT_HOPE = 1.6
/** 한 번에 배출할 수 있는 탄 수 (GDD §2) */
const EJECT_SIZE = 3

// ---------------------------------------------------------------------------
// 작은 헬퍼
// ---------------------------------------------------------------------------

function dmgOf(a: Ammo): number {
  return ammoStats(a).dmg
}

function heatOf(a: Ammo): number {
  return ammoStats(a).heat
}

/** 지금 손에 든 탄 = 트레이 + 예비칸 (예비칸도 장전 대상이다) */
function hand(s: CombatState): Ammo[] {
  return s.reserve.length > 0 ? s.tray.concat(s.reserve) : s.tray.slice()
}

/**
 * 부착물을 무시한 해석적 탄창 가치. Σ dmg_i × (시작온도 + 누적 heat).
 * 실제 값이 아니라 "후보를 줄이기 위한 순위 함수"로만 쓴다.
 */
function analyticValue(plan: readonly Ammo[], startHeat: number): number {
  let heat = startHeat
  let total = 0
  for (const a of plan) {
    heat += heatOf(a)
    total += dmgOf(a) * heat
  }
  return total
}

/**
 * 해석적 최적 순서: heat/dmg 내림차순.
 * (인접 교환 논증 — 순서 (a,b) 가 (b,a) 보다 나은 조건은 heat_a·dmg_b > heat_b·dmg_a 다.
 *  부착물이 없다면 이것이 증명 가능한 최적해이고, 있어도 좋은 출발점이 된다.)
 */
function analyticOrder(set: readonly Ammo[]): Ammo[] {
  return set.slice().sort((a, b) => heatOf(b) * dmgOf(a) - heatOf(a) * dmgOf(b))
}

function planKey(plan: readonly Ammo[]): string {
  let k = ''
  for (const a of plan) k += a.uid + '|'
  return k
}

// ---------------------------------------------------------------------------
// 평가기 — 같은 배열을 두 번 재보지 않도록 캐시를 낀다
// ---------------------------------------------------------------------------

interface Evaluator {
  (plan: Ammo[]): number
  calls: number
}

function makeEvaluator(s: CombatState): Evaluator {
  const cache = new Map<string, number>()
  const fn = ((plan: Ammo[]): number => {
    const key = planKey(plan)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const v = previewDamage(s, plan).expected
    cache.set(key, v)
    fn.calls += 1
    return v
  }) as Evaluator
  fn.calls = 0
  return fn
}

// ---------------------------------------------------------------------------
// greedy — 평범한 플레이어 모사
//   "온도 큰 탄 먼저 → 데미지 큰 탄 나중" 이라는 널리 통하는 직관 그대로.
// ---------------------------------------------------------------------------

/** 트레이 앞쪽 절반은 온도, 뒤쪽 절반은 데미지 기준으로 고른다 */
function greedySelect(pool: readonly Ammo[], cap: number, frontCount: number): Ammo[] {
  const byHeat = pool.slice().sort((a, b) => heatOf(b) - heatOf(a))
  const front = byHeat.slice(0, Math.max(0, Math.min(frontCount, cap)))
  const taken = new Set(front.map((a) => a.uid))
  const rest = pool.filter((a) => !taken.has(a.uid)).sort((a, b) => dmgOf(b) - dmgOf(a))
  const back = rest.slice(0, cap - front.length)
  return front.concat(back)
}

/** 앞쪽은 heat/dmg 내림차순, 뒤쪽은 dmg 오름차순으로 배열한다 */
function greedyArrange(selected: readonly Ammo[], frontCount: number): Ammo[] {
  const n = Math.max(0, Math.min(frontCount, selected.length))
  const byHeat = selected.slice().sort((a, b) => heatOf(b) - heatOf(a))
  const front = analyticOrder(byHeat.slice(0, n))
  const back = byHeat.slice(n).sort((a, b) => dmgOf(a) - dmgOf(b))
  return front.concat(back)
}

/** greedy 후보 2~3가지를 만들어 previewDamage 로 최선을 고른다 */
function greedyPlan(s: CombatState, evaluate: Evaluator): { plan: Ammo[]; expected: number } {
  const pool = hand(s)
  const cap = Math.min(s.cap, pool.length)
  if (cap <= 0) return { plan: [], expected: 0 }

  const half = Math.floor(cap / 2)
  const candidates: Ammo[][] = []

  const setA = greedySelect(pool, cap, half)
  candidates.push(greedyArrange(setA, half))
  candidates.push(analyticOrder(setA))

  const setB = greedySelect(pool, cap, Math.ceil(cap / 2))
  candidates.push(greedyArrange(setB, Math.ceil(cap / 2)))

  // 마지막 자리에서는 예열이 항상 손해다(BALANCE §1) → 순수 데미지 오름차순도 후보에 넣는다.
  candidates.push(setA.slice().sort((a, b) => dmgOf(a) - dmgOf(b)))

  let best = candidates[0]
  let bestValue = evaluate(best)
  for (let i = 1; i < candidates.length; i += 1) {
    const v = evaluate(candidates[i])
    if (v > bestValue) {
      bestValue = v
      best = candidates[i]
    }
  }
  return { plan: best, expected: bestValue }
}

// ---------------------------------------------------------------------------
// optimal — 조합 × 순열 전탐색 (예산 안에서) + 언덕오르기
// ---------------------------------------------------------------------------

function factorial(n: number): number {
  let f = 1
  for (let i = 2; i <= n; i += 1) f *= i
  return f
}

/** pool 에서 k 개를 뽑는 모든 조합 */
function combinations<T>(pool: readonly T[], k: number): T[][] {
  const out: T[][] = []
  const cur: T[] = []
  const walk = (start: number): void => {
    if (cur.length === k) {
      out.push(cur.slice())
      return
    }
    for (let i = start; i < pool.length; i += 1) {
      cur.push(pool[i])
      walk(i + 1)
      cur.pop()
    }
  }
  walk(0)
  return out
}

/** 모든 순열 (Heap's algorithm) */
function permutations<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  const arr = items.slice()
  const c = new Array<number>(arr.length).fill(0)
  out.push(arr.slice())
  let i = 0
  while (i < arr.length) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i]
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
      out.push(arr.slice())
      c[i] += 1
      i = 0
    } else {
      c[i] = 0
      i += 1
    }
  }
  return out
}

/** 인접 스왑 언덕오르기 — 더 나아지지 않을 때까지 (또는 예산이 마를 때까지) */
function hillClimb(
  start: readonly Ammo[],
  evaluate: Evaluator,
  budget: number,
): { plan: Ammo[]; expected: number } {
  let cur = start.slice()
  let best = evaluate(cur)
  let spent = 0
  let improved = true

  while (improved && spent < budget) {
    improved = false
    for (let i = 0; i + 1 < cur.length && spent < budget; i += 1) {
      const swapped = cur.slice()
      const tmp = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = tmp
      const v = evaluate(swapped)
      spent += 1
      if (v > best) {
        best = v
        cur = swapped
        improved = true
      }
    }
  }
  return { plan: cur, expected: best }
}

function optimalPlan(s: CombatState, evaluate: Evaluator): { plan: Ammo[]; expected: number } {
  const pool = hand(s)
  const cap = Math.min(s.cap, pool.length)
  if (cap <= 0) return { plan: [], expected: 0 }

  // 출발점은 언제나 greedy — optimal 이 greedy 보다 나쁠 수는 없게 한다.
  let best = greedyPlan(s, evaluate)

  // 조합 폭발 방지: 해석적 가치 상위 POOL_SIZE 발만 후보로 남긴다.
  const ranked = pool
    .slice()
    .sort((a, b) => analyticValue([b], s.heat) - analyticValue([a], s.heat))
    .slice(0, POOL_SIZE)
  const candidatePool = ranked.length >= cap ? ranked : pool.slice(0, Math.max(cap, ranked.length))

  if (cap > MAX_PERM_CAP) {
    // 용량이 크면 순열이 감당 불가 — greedy 배열에서 지역 탐색만 한다.
    const climbed = hillClimb(best.plan, evaluate, PREVIEW_BUDGET)
    return climbed.expected > best.expected ? climbed : best
  }

  const combos = combinations(candidatePool, cap)
  // 해석적 가치로 조합을 미리 줄 세운다 (previewDamage 를 쓰지 않는 무료 판정).
  const scored = combos
    .map((set) => {
      const ordered = analyticOrder(set)
      return { set: ordered, score: analyticValue(ordered, s.heat) }
    })
    .sort((a, b) => b.score - a.score)

  const permCount = factorial(cap)
  const fullCount = Math.max(1, Math.min(scored.length, Math.floor(PREVIEW_BUDGET / permCount)))

  for (let i = 0; i < scored.length; i += 1) {
    const entry = scored[i]
    if (i < fullCount) {
      // 상위 조합은 모든 순열을 실제로 재본다.
      for (const p of permutations(entry.set)) {
        const v = evaluate(p)
        if (v > best.expected) best = { plan: p, expected: v }
      }
    } else {
      // 나머지는 해석적 최적 배열 + 인접 스왑 몇 번만.
      const v = evaluate(entry.set)
      if (v > best.expected) best = { plan: entry.set.slice(), expected: v }
      if (evaluate.calls > PREVIEW_BUDGET * 2) break
      const climbed = hillClimb(entry.set, evaluate, cap)
      if (climbed.expected > best.expected) best = climbed
    }
    if (evaluate.calls > PREVIEW_BUDGET * 3) break
  }

  return best
}

// ---------------------------------------------------------------------------
// 배출 판단
// ---------------------------------------------------------------------------

/** 이 탄이 이번 빌드에서 갖는 대략적 가치 (배출 후보를 고르는 용도) */
function ammoWorth(s: CombatState, a: Ammo, avgDmg: number): number {
  const heatWeight = avgDmg * Math.max(1, s.cap / 2)
  return dmgOf(a) * (s.heatStartBase + 1) + heatOf(a) * heatWeight
}

/** 남은 거리로 몇 번 더 사격할 수 있는가 (마지막 한 방은 거리를 다 써도 된다) */
function fireActionsLeft(s: CombatState): number {
  const cost = Math.max(1, s.fireCost)
  return Math.max(1, Math.ceil(s.distance / cost))
}

/** 지금 배출이 실제로 먹는 거리 (탄도 계산기·무한 탄약고 플래그를 그대로 읽는다) */
function effectiveEjectCost(s: CombatState): number {
  if (s.flags['freeEjectAlways'] === true) return 0
  if (s.flags['freeEject'] === true) return 0
  return Math.max(0, s.ejectCost)
}

/**
 * 배출할 탄 목록. 지금 장전할 계획(plan)에 들어가지 않은 탄 중 가치가 낮은 순서로 최대 3발.
 * 비어 있으면 배출할 이유가 없다는 뜻이다.
 */
function ejectTargets(s: CombatState, plan: readonly Ammo[]): string[] {
  const chosen = new Set(plan.map((a) => a.uid))
  const rest = s.tray.filter((a) => !chosen.has(a.uid))
  if (rest.length === 0) return []

  const all = hand(s)
  let sum = 0
  for (const a of all) sum += dmgOf(a)
  const avgDmg = all.length > 0 ? sum / all.length : 20

  return rest
    .slice()
    .sort((a, b) => ammoWorth(s, a, avgDmg) - ammoWorth(s, b, avgDmg))
    .slice(0, EJECT_SIZE)
    .map((a) => a.uid)
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/**
 * 지금 무엇을 할지 하나 고른다.
 *
 * 배출 조건은 세 가지를 동시에 만족할 때만이다.
 *  ① 이번 탄창이 "남은 HP ÷ 남은 행동 수"에 못 미친다 (지금 페이스로는 진다)
 *  ② 배출하고도 사격 행동이 2번 이상 남는다 (배출이 마지막 행동이 되면 그냥 자살이다)
 *  ③ 손패가 좋아지면 따라잡을 여지가 있다 — 이미 가망이 없으면 배출 대신 쏜다.
 *    (③ 이 없으면 승산 없는 전투에서 봇이 죽을 때까지 배출만 반복한다)
 */
export function chooseAction(s: CombatState, skill: BotSkill): BotAction {
  const evaluate = makeEvaluator(s)
  const best = skill === 'optimal' ? optimalPlan(s, evaluate) : greedyPlan(s, evaluate)

  const needNow = s.enemy.hp / fireActionsLeft(s)
  if (best.expected < needNow && s.ejectsUsed < MAX_EJECTS) {
    const cost = effectiveEjectCost(s)
    const distAfter = s.distance - cost
    const actionsAfter = distAfter > 0 ? Math.ceil(distAfter / Math.max(1, s.fireCost)) : 0
    const needAfter = s.enemy.hp / Math.max(1, actionsAfter)

    if (actionsAfter >= 2 && best.expected * EJECT_HOPE >= needAfter) {
      const uids = ejectTargets(s, best.plan)
      if (uids.length > 0) return { kind: 'eject', uids }
    }
  }

  return { kind: 'fire', plan: best.plan }
}

/**
 * 전투 하나를 끝까지 자동으로 진행한다.
 * 어떤 행동도 상태를 못 바꾸는 병리적 상황을 대비해 행동 수에 상한(40)을 둔다.
 */
export function playCombat(
  s: CombatState,
  skill: BotSkill,
): { win: boolean; magsUsed: number; peakHeat: number; distanceLeft: number } {
  let actions = 0

  while (s.outcome === 'ongoing' && actions < MAX_ACTIONS) {
    actions += 1
    const act = chooseAction(s, skill)

    if (act.kind === 'eject') {
      const events = eject(s, act.uids)
      // 배출이 아무것도 못 뺐으면(트레이에 없는 uid 등) 사격으로 되돌린다 — 제자리걸음 방지.
      if (events.length === 0) fire(s, chooseFirePlan(s, skill))
      continue
    }

    fire(s, act.plan)
  }

  return {
    win: s.outcome === 'win',
    magsUsed: s.magsFired,
    peakHeat: s.peakHeat,
    distanceLeft: Math.max(0, s.distance),
  }
}

/** 배출이 불발됐을 때 쓰는 대체 사격 계획 */
function chooseFirePlan(s: CombatState, skill: BotSkill): Ammo[] {
  const evaluate = makeEvaluator(s)
  const best = skill === 'optimal' ? optimalPlan(s, evaluate) : greedyPlan(s, evaluate)
  return best.plan
}

/** 지금 손패로 뽑을 수 있는 최선의 탄창 피해 추정 (문 선택 등 메타 판단용) */
export function estimateMagDamage(s: CombatState, skill: BotSkill): number {
  const evaluate = makeEvaluator(s)
  const best = skill === 'optimal' ? optimalPlan(s, evaluate) : greedyPlan(s, evaluate)
  return best.expected
}

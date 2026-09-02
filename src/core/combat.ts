// ============================================================================
// 전투 상태기계
//   v2: 가방/트레이/드로우/배출이 없다. 기본탄은 무한이고 특수탄은 소모품이다.
//   행동은 오직 "사격" 하나이며, 사격 한 번이 거리를 fireCost 만큼 먹는다.
//   따라서 남은 거리 = 남은 사격 횟수 = 남은 목숨이다.
// ============================================================================
import type {
  CombatMods,
  CombatState,
  EnemyInstance,
  FireEvent,
  Loadout,
  MagCtx,
  Rng,
  Round,
} from './types'
import { BASE_HEAT } from './types'
import { makeRng } from './rng'
import {
  computeCap,
  computeEnemySpeed,
  computeFireCost,
  computeStartDistance,
  computeHeatCarry,
  computeStartHeat,
  defOf,
  fireOneShot,
  magRules,
  orderedAttachments,
} from './pipeline'

let roundUid = 0
export function resetRoundUid(): void {
  roundUid = 0
}
export function makeRound(special: string | null): Round {
  roundUid += 1
  return { uid: 'r' + roundUid, special }
}

/** 기본탄은 무한하다 — 필요할 때 만들어 쓴다 */
export function basicRound(): Round {
  return makeRound(null)
}

function safe(fn: (() => void) | undefined, label: string): void {
  if (fn === undefined) return
  try {
    fn()
  } catch (e) {
    console.warn('[hook]', label, e)
  }
}

export function startCombat(
  loadout: Loadout,
  enemy: EnemyInstance,
  rng: Rng,
  mods?: CombatMods,
): CombatState {
  const speed = computeEnemySpeed(loadout, enemy.speed)
  const e: EnemyInstance = { ...enemy, speed, vuln: 0 }

  const s: CombatState = {
    enemy: e,
    distance: computeStartDistance(loadout, enemy) + (mods?.startDistDelta ?? 0),
    specials: { ...loadout.specials },
    cap: computeCap(loadout),

    heat: BASE_HEAT,
    heatStartBase: BASE_HEAT + computeStartHeat(loadout) + (mods?.heatStartDelta ?? 0),
    peakHeat: 0,

    magsFired: 0,
    shotsFired: 0,
    totalDamage: 0,

    magPlan: [],
    magFired: [],
    magDamage: 0,
    abortMag: false,
    pendingNextDmg: 0,
    doubleNext: false,
    heatDoublePending: false,
    magDmgBonus: 0,

    vars: {},
    runVars: mods?.runVars ?? {},
    flags: {},

    fireCost: computeFireCost(loadout, speed),

    rng,
    loadout,
    attachments: orderedAttachments(loadout),
    dryRun: false,
    outcome: 'ongoing',
  }

  s.heat = s.heatStartBase
  s.vars['__taken'] = mods?.attachmentsTaken ?? 0

  const cc = { s, self: '' }
  for (const a of s.attachments.slice()) {
    cc.self = a.id
    safe(() => a.hooks?.onCombatStart?.(cc), a.id)
  }
  if (e.passive?.onCombatStart !== undefined) {
    cc.self = e.passive.id
    safe(() => e.passive?.onCombatStart?.(cc), e.passive.id)
  }

  return s
}

/**
 * 전투 중 부착물 교체 — 사격 전이면 언제든 가능하다.
 * 같은 부위끼리만 교체되며, 벗은 것은 stash 로 돌아간다.
 */
export function swapAttachment(s: CombatState, id: string, railIndex?: number): boolean {
  const l = s.loadout
  const idx = l.stash.findIndex((a) => a.id === id)
  if (idx < 0) return false
  const next = l.stash[idx]

  let removed: import('./types').Attachment | null = null
  if (next.slot === 'rail') {
    const slots = l.rails
    if (slots.length === 0) return false
    const at = railIndex !== undefined && railIndex >= 0 && railIndex < slots.length
      ? railIndex
      : Math.max(0, slots.findIndex((r) => r === null))
    removed = slots[at] ?? null
    slots[at] = next
  } else {
    removed = l[next.slot]
    l[next.slot] = next
  }

  l.stash.splice(idx, 1)
  if (removed !== null) l.stash.push(removed)

  // 장비가 바뀌었으니 파생값을 다시 잡는다 (거리는 이미 진행 중이라 건드리지 않는다)
  s.attachments = orderedAttachments(l)
  s.cap = computeCap(l)
  s.fireCost = computeFireCost(l, s.enemy.speed)
  s.heatStartBase = BASE_HEAT + computeStartHeat(l)
  return true
}

/** 이 계획이 유효한가 (용량 초과, 보유하지 않은 특수탄 등) */
export function validatePlan(s: CombatState, plan: Round[]): Round[] {
  const out: Round[] = []
  const used: Record<string, number> = {}
  for (const r of plan) {
    if (out.length >= s.cap) break
    if (r.special !== null) {
      const have = s.specials[r.special] ?? 0
      const spent = used[r.special] ?? 0
      if (spent >= have) continue
      used[r.special] = spent + 1
    }
    out.push(r)
  }
  return out
}

export function fire(s: CombatState, planIn: Round[]): FireEvent[] {
  const out: FireEvent[] = []
  const plan = validatePlan(s, planIn)
  if (plan.length === 0) return out

  s.magPlan = plan.slice()
  s.magFired = []
  s.magDamage = 0
  s.abortMag = false
  s.pendingNextDmg = 0
  s.doubleNext = false
  s.heatDoublePending = false
  s.magDmgBonus = 0

  // 온도 초기화. 이월(냉각 자켓)은 magEnd 에서 heatStartBase 에 반영해 둔다.
  s.heat = s.heatStartBase

  out.push({ t: 'magStart', plan: plan.slice(), heat: s.heat, cap: s.cap })

  const mc: MagCtx = { s, self: '', plan }
  for (const a of s.attachments) {
    mc.self = a.id
    safe(() => a.hooks?.onMagStart?.(mc), a.id)
  }
  if (s.enemy.passive?.onMagStart !== undefined) {
    mc.self = s.enemy.passive.id
    safe(() => s.enemy.passive?.onMagStart?.(mc), s.enemy.passive.id)
  }

  const rules = magRules(s.loadout)
  const keepChance = rules.notConsumedChance ?? 0
  const freeFirst = s.flags['freeFirstSpecial'] === true
  let usedFreeFirst = false

  const queue = plan.slice()
  let i = 0
  let guard = 0
  while (queue.length > 0 && guard < 60) {
    guard += 1
    const r = queue[0]
    const def = defOf(r)

    fireOneShot(s, r, i, plan, out)
    i += 1

    // 소모 판정 — 기본탄은 무한이므로 특수탄만 대상이다
    let consumed = true
    if (def !== null) {
      if (freeFirst && !usedFreeFirst) {
        usedFreeFirst = true
        consumed = false
      } else if (keepChance > 0 && !s.dryRun && s.rng.next() < keepChance) {
        consumed = false
      }
      if (consumed) {
        s.specials[def.id] = Math.max(0, (s.specials[def.id] ?? 0) - 1)
      } else {
        out.push({ t: 'notConsumed', index: i - 1, round: r })
      }
    }

    if (consumed) queue.shift()
    else if (keepChance <= 0) queue.shift() // 무료 1회는 재발사하지 않는다

    if (s.enemy.hp <= 0) break
    if (s.abortMag) break
    if (queue.length === 0) break
    if (i >= 60) break
  }

  // --- 사격 종료 -----------------------------------------------------------
  for (const a of s.attachments) {
    mc.self = a.id
    safe(() => a.hooks?.onMagEnd?.(mc), a.id)
  }
  if (s.enemy.passive?.onMagEnd !== undefined) {
    mc.self = s.enemy.passive.id
    safe(() => s.enemy.passive?.onMagEnd?.(mc), s.enemy.passive.id)
  }

  // ★ 온도는 사격 사이에 이월된다 (기본 50%). 부착물이 이 비율을 바꾼다.
  const carryRatio = computeHeatCarry(s.loadout)
  const carried = s.heat * carryRatio
  s.heatStartBase = BASE_HEAT + computeStartHeat(s.loadout) + carried
  out.push({
    t: 'magEnd',
    heatCarried: carried,
    heatAfter: s.heatStartBase,
    totalDamage: s.magDamage,
  })

  s.magsFired += 1

  if (s.enemy.hp <= 0) {
    s.outcome = 'win'
    return out
  }

  s.distance -= s.fireCost
  out.push({ t: 'advance', meters: s.fireCost, distanceAfter: s.distance })

  if (s.distance <= 0) {
    s.outcome = 'lose'
    out.push({ t: 'playerDead' })
  }
  return out
}

export function previewDamage(s: CombatState, plan: Round[]): { expected: number; approximate: boolean } {
  const clone = cloneState(s)
  clone.dryRun = true
  const events = fire(clone, plan)
  let total = 0
  for (const ev of events) if (ev.t === 'shot') total += ev.damage
  const approx = (magRules(s.loadout).notConsumedChance ?? 0) > 0
  return { expected: total, approximate: approx }
}

export function cloneState(s: CombatState): CombatState {
  return {
    ...s,
    enemy: { ...s.enemy },
    specials: { ...s.specials },
    magPlan: s.magPlan.slice(),
    magFired: s.magFired.slice(),
    vars: { ...s.vars },
    runVars: { ...s.runVars },
    flags: { ...s.flags },
    attachments: s.attachments.slice(),
    // 미리보기가 실제 난수를 소비하면 안 된다 — 상태만 복사한 독립 스트림을 쓴다
    rng: makeRng(s.rng.state()),
    // loadout 은 공유하되, 탄피 증가 훅은 dryRun 가드가 막는다
    loadout: s.loadout,
  }
}

export function checkOutcome(s: CombatState): 'ongoing' | 'win' | 'lose' {
  if (s.enemy.hp <= 0) return 'win'
  if (s.distance <= 0) return 'lose'
  return 'ongoing'
}

// ============================================================================
// 데미지 파이프라인 — 이 게임의 심장
//   한 발을 쏠 때마다 아래 7스텝이 정확히 이 순서로 1회전한다.
//   곱셈은 STEP5 의 `dmg × HEAT` 단 한 번뿐이다. 나머지는 전부 덧셈이다.
// ============================================================================
import type {
  Attachment,
  CombatState,
  EnemyInstance,
  FireCtx,
  FireEvent,
  Loadout,
  Round,
  SpecialDef,
} from './types'
import { BASE_HEAT_CARRY, BASIC_DMG, BASIC_HEAT } from './types'
import { SPECIAL_BY_ID } from './data/specials'

/** 순회 순서: 총열 → 덮개 → 광학 → 스톡 → 탄창 → 레일(좌→우) */
export function orderedAttachments(l: Loadout): Attachment[] {
  const out: Attachment[] = []
  for (const a of [l.barrel, l.handguard, l.optic, l.stock, l.magazine]) {
    if (a !== null) out.push(a)
  }
  for (const r of l.rails) if (r !== null) out.push(r)
  return out
}

function sumMods(
  l: Loadout,
  key: 'cap' | 'startDist' | 'fireCost' | 'enemySpeed' | 'railSlots' | 'startHeat' | 'heatCarry',
): number {
  let n = 0
  for (const a of orderedAttachments(l)) {
    const v = a.mods?.[key]
    if (typeof v === 'number') n += v
  }
  return n
}

export function magRules(l: Loadout) {
  return l.magazine?.mag ?? { cap: 5 }
}

export function computeCap(l: Loadout): number {
  return Math.max(1, magRules(l).cap + sumMods(l, 'cap'))
}

export function computeStartDistance(l: Loadout, e: EnemyInstance): number {
  return Math.max(4, e.startDist + sumMods(l, 'startDist'))
}

export function computeEnemySpeed(l: Loadout, base: number): number {
  return Math.max(2, base + sumMods(l, 'enemySpeed'))
}

export function computeFireCost(l: Loadout, speed: number): number {
  return Math.max(1, speed + sumMods(l, 'fireCost'))
}

export function computeStartHeat(l: Loadout): number {
  return sumMods(l, 'startHeat')
}

/** 사격 사이 온도 이월 비율 (0~1) */
export function computeHeatCarry(l: Loadout): number {
  const v = BASE_HEAT_CARRY + sumMods(l, 'heatCarry')
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function railSlotsOf(l: Loadout): number {
  return Math.max(0, sumMods(l, 'railSlots'))
}

export function defOf(r: Round): SpecialDef | null {
  return r.special === null ? null : (SPECIAL_BY_ID[r.special] ?? null)
}

/** 안전하게 훅을 부른다 — 하나가 던져도 전투가 죽지 않는다 */
function safe(fn: (() => void) | undefined, label: string): void {
  if (fn === undefined) return
  try {
    fn()
  } catch (e) {
    console.warn('[hook]', label, e)
  }
}

/**
 * STEP 1~7. s 를 변형하고 out 에 이벤트를 push 한다.
 */
export function fireOneShot(s: CombatState, round: Round, index: number, plan: Round[], out: FireEvent[]): void {
  const def = defOf(round)

  // ---- STEP 1: 기본 데미지 -------------------------------------------------
  let dmg = (def !== null ? def.dmg : BASIC_DMG) + s.pendingNextDmg + s.magDmgBonus
  s.pendingNextDmg = 0

  // ---- STEP 2: 탄 고유 온도 ------------------------------------------------
  let heatGain = def !== null ? def.heat : BASIC_HEAT

  const ctx: FireCtx = {
    s,
    self: '',
    round,
    def,
    index,
    isFirst: index === 0,
    isLast: index === plan.length - 1,
    prev: index > 0 ? (s.magFired[s.magFired.length - 1] ?? null) : null,
    heatBefore: s.heat,
    dmg,
    heatGain,
    triggered: [],
  }

  // ---- STEP 3~4: 부착물 → 특수탄 자체 훅 (덧셈만) --------------------------
  for (const a of s.attachments) {
    ctx.self = a.id
    safe(() => a.hooks?.onFire?.(ctx), a.id)
  }
  if (def !== null) {
    ctx.self = def.id
    safe(() => def.hooks?.onFire?.(ctx), def.id)
  }

  dmg = ctx.dmg
  heatGain = ctx.heatGain

  // ---- STEP 5: 온도 확정 & 곱셈 (이 게임의 유일한 곱셈) --------------------
  const mul = magRules(s.loadout).heatGainMul
  if (typeof mul === 'number') heatGain *= mul
  const passive = s.enemy.passive
  if (passive?.modifyHeatGain !== undefined) heatGain = passive.modifyHeatGain(heatGain, ctx)
  if (s.heatDoublePending) heatGain *= 2
  if (s.doubleNext && def === null) {
    // 성탄의 "다음 탄 2배" 는 기본탄에는 데미지 2배로 작용한다
    dmg *= 2
  }

  s.heat += heatGain
  if (s.heat > s.peakHeat) s.peakHeat = s.heat

  const rawDamage = Math.round(dmg * s.heat)

  // ---- STEP 6: 적 패시브 & 취약 ------------------------------------------
  let damage = rawDamage
  const pierce = s.flags['pierce'] === true
  if (!pierce && passive?.modifyDamage !== undefined) damage = passive.modifyDamage(damage, ctx)
  if (s.enemy.vuln > 0) damage = Math.round(damage * (1 + s.enemy.vuln))
  s.flags['pierce'] = false

  s.enemy.hp -= damage

  // ---- STEP 7: 발사 후 -----------------------------------------------------
  const distBefore = s.distance
  s.doubleNext = false

  for (const a of s.attachments) {
    ctx.self = a.id
    safe(() => a.hooks?.onAfterShot?.(ctx), a.id)
  }
  if (def !== null) {
    ctx.self = def.id
    safe(() => def.hooks?.onAfterShot?.(ctx), def.id)
  }
  if (passive?.onAfterShot !== undefined) {
    ctx.self = passive.id
    safe(() => passive.onAfterShot?.(ctx), passive.id)
  }

  // 사격 이벤트는 **STEP 7 이 끝난 뒤**에 발행한다.
  //   예전에는 STEP 6 직후에 발행해서, onAfterShot 에서만 발동하는 것들
  //   (황동 부적·영혼 표식·이단심문관의 화염·충격탄 …)이 triggered 에
  //   영원히 실리지 않았다. 그래서 화면에서 랙이 번쩍이지 않았고,
  //   시뮬레이터 계측에서는 "장착됐는데 한 번도 발동 안 함"으로 잘못 잡혔다.
  out.push({
    t: 'shot',
    index,
    round,
    dmg: Math.round(dmg),
    heatBefore: ctx.heatBefore,
    heatAfter: s.heat,
    damage,
    rawDamage,
    triggered: ctx.triggered.slice(),
    enemyHpAfter: s.enemy.hp,
  })

  if (s.distance !== distBefore) {
    out.push({ t: 'knockback', meters: s.distance - distBefore, distanceAfter: s.distance })
  }

  s.magFired.push(round)
  s.magDamage += damage
  s.totalDamage += damage
  s.shotsFired += 1

  if (s.enemy.hp <= 0) out.push({ t: 'enemyDead', overkill: -s.enemy.hp })
}

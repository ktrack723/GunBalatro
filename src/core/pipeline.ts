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

/**
 * 순회 순서: 총열 → 덮개 → **광학 → 레일 광학** → 스톡 → 탄창.
 *
 * 레일이 맨 뒤에 있으면 같은 부착물을 하드포인트에 꽂았을 때와 레일에 꽂았을 때
 * 한 탄창 피해가 최대 13.7% 달라진다 — 그 사이에 참회의 탄대의 `c.dmg = 0` 대입이
 * 끼기 때문이다. 광학은 같은 부위이므로 반드시 붙여서 돈다.
 */
export function orderedAttachments(l: Loadout): Attachment[] {
  const out: Attachment[] = []
  for (const a of [l.barrel, l.handguard, l.optic]) if (a !== null) out.push(a)
  for (const r of l.rails) if (r !== null) out.push(r)
  for (const a of [l.stock, l.magazine]) if (a !== null) out.push(a)
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
  // 하한 2. 거리 감소를 세 개 겹치면 1 까지 내려가 배회자 상대로 30회를 쏠 수 있었다 —
  // "거리 = 남은 목숨" 이라는 전제가 통째로 무의미해진다.
  return Math.max(2, speed + sumMods(l, 'fireCost'))
}

export function computeStartHeat(l: Loadout): number {
  return sumMods(l, 'startHeat')
}

/** 사격 사이 온도 이월 비율 (0~1) */
export function computeHeatCarry(l: Loadout): number {
  const v = BASE_HEAT_CARRY + sumMods(l, 'heatCarry')
  // 상한 0.9 — 이월 100% 면 온도가 영원히 식지 않아 "식힌다" 는 규칙 자체가 사라진다.
  return v < 0 ? 0 : v > 0.9 ? 0.9 : v
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
/**
 * 같은 특수탄을 한 탄창에 겹쳤을 때 **자기 값**에 걸리는 배수 (2번째 0.68, 3번째부터 0.45).
 *
 * 소이·소이·철갑 한 줄이 모든 빌드의 정답이었다 — 예열탄을 도배하고 큰 걸 마지막에
 * 얹으면 끝이라, 탄창을 '짜는' 결정이 '제일 센 탄을 몇 장 넣느냐' 로 납작해졌다.
 * 서로 **다른** 탄을 엮는 콤보는 그대로 두고 도배만 벌한다. 부착물이 얹어주는 보너스는
 * 건드리지 않는다 (그건 그 부착물의 값이다).
 */
const REPEAT_MUL = [1, 0.68, 0.45] as const
// 힘이 def.dmg/def.heat 이 아니라 **훅**에 들어 있는 탄(냉동·심판·방열·표식…)은
// 이 배수를 스스로 곱해야 한다 — specials 의 amp() 가 ctx.repeat 으로 그 일을 한다.
// 안 그러면 규칙이 통째로 비껴간다: 실측 냉동탄 1발 15.3 / 3발 14.8(안 줄고),
// 심판탄 4.7 → 6.0 (겹칠수록 **올라갔다**).

function repeatMul(s: CombatState, def: { id: string } | null): number {
  if (def === null) return 1
  let n = 0
  for (const r of s.magFired) if (r.special === def.id) n += 1
  return REPEAT_MUL[Math.min(n, REPEAT_MUL.length - 1)] ?? 0.3
}

export function fireOneShot(s: CombatState, round: Round, index: number, plan: Round[], out: FireEvent[]): void {
  const def = defOf(round)
  const rep = repeatMul(s, def)

  // ---- STEP 1: 기본 데미지 -------------------------------------------------
  let dmg = (def !== null ? Math.round(def.dmg * rep) : BASIC_DMG) + s.pendingNextDmg + s.magDmgBonus
  s.pendingNextDmg = 0

  // ---- STEP 2: 탄 고유 온도 ------------------------------------------------
  let heatGain = def !== null ? def.heat * rep : BASIC_HEAT

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
    repeat: rep,
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
  if (s.heatMulPending > 1) heatGain *= s.heatMulPending
  // 성탄 래치. STEP7 의 훅이 전부 끝난 뒤에 꺼야 한다 —
  // 여기서 바로 끄면 훅을 가진 특수탄(amp() 를 쓰는 12종)이 배수를 못 받고,
  // 안 끄면 성탄 자신의 onAfterShot 이 다음 발까지 끌고 간다.
  const wasDouble = s.doubleNextMul > 1
  // **훅이 없는 탄에만** 데미지 배수를 준다. 훅이 있는 탄은 자기 amp() 로 이미 배수를
  // 받으므로, 여기서 또 곱하면 STEP5 위에 다시 곱해져 제곱이 된다.
  if (wasDouble && (def === null || def.hooks === undefined)) {
    dmg *= s.doubleNextMul
  }

  s.heat += heatGain
  if (s.heat > s.peakHeat) s.peakHeat = s.heat

  // 음수 방어. 덧셈만 하는 게임이라 마이너스 보정(도박꾼의 −40 등)이 기본탄의
  // 바닥값 12 를 넘으면 dmg 가 음수가 되고, 그러면 `enemy.hp -= damage` 가
  // **적을 회복시킨다.** 실측 2,000발 중 1,022발이 그랬다(최악 −105).
  // 사격은 어떤 조합에서도 적을 낫게 하지 않는다 — 여기서 한 번에 막는다.
  if (dmg < 0) dmg = 0

  const rawDamage = Math.round(dmg * s.heat)

  // ---- STEP 6: 적 패시브 & 취약 ------------------------------------------
  let damage = rawDamage
  const pierce = s.flags['pierce'] === true
  if (!pierce && passive?.modifyDamage !== undefined) damage = passive.modifyDamage(damage, ctx)
  if (s.enemy.vuln > 0) damage = Math.round(damage * (1 + s.enemy.vuln))
  if (damage < 0) damage = 0
  s.flags['pierce'] = false

  s.enemy.hp -= damage

  // ---- STEP 7: 발사 후 -----------------------------------------------------
  const distBefore = s.distance
  const speedBefore = s.enemy.speed

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

  // 성탄 래치 해제 — 이 발이 배수를 받았을 때만 끈다.
  if (wasDouble) s.doubleNextMul = 1

  // 적 속도가 바뀌었으면(냉각탄 등) 사격 비용을 **부착물 보정까지 포함해** 다시 잡는다.
  // 카드가 직접 fireCost 를 대입하면 간이 거리계·완충기 보정이 통째로 날아간다.
  if (s.enemy.speed !== speedBefore) {
    s.fireCost = computeFireCost(s.loadout, s.enemy.speed)
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

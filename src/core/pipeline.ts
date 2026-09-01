// 데미지 파이프라인 7스텝(GDD §4)과 준정적 수치(트레이·용량·거리·행동비용) 산출을 담당한다.
// 런타임 증가는 전부 덧셈이고, 곱셈은 STEP5 의 round(dmg × HEAT) 단 한 번뿐이다.
// three.js·DOM·Date.now·Math.random 을 쓰지 않는 순수 계산 모듈이다.

import type {
  Ammo,
  Attachment,
  CombatState,
  EnemyInstance,
  FireCtx,
  FireEvent,
  Loadout,
  StaticMods,
} from './types'
import { BASE_TRAY } from './types'
import { ammoStats } from './ammoStats'

// ---------------------------------------------------------------------------
// 훅 호출 가드
// ---------------------------------------------------------------------------

/**
 * 훅 하나가 던져도 전투 전체가 죽지 않게 감싼다.
 * core 는 DOM 을 모르지만 console 은 런타임 중립이라 경고에만 쓴다.
 */
export function safeCall(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.warn(`[pipeline] 훅 실패: ${label}`, err)
  }
}

/** 값을 돌려주는 훅용 가드. 실패하거나 비정상 값이면 원값을 유지한다. */
function safeNumber(label: string, fallback: number, fn: () => number): number {
  try {
    const v = fn()
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback
  } catch (err) {
    console.warn(`[pipeline] 훅 실패: ${label}`, err)
    return fallback
  }
}

// ---------------------------------------------------------------------------
// 부착물 순회 순서 (GDD §4 STEP3)
// ---------------------------------------------------------------------------

/** 총열 → 총열덮개 → 광학 → 개머리판 → 보조레일(좌→우). 빈 슬롯은 건너뛴다. */
export function orderedAttachments(l: Loadout): Attachment[] {
  const out: Attachment[] = []
  if (l.barrel !== null) out.push(l.barrel)
  if (l.handguard !== null) out.push(l.handguard)
  if (l.optic !== null) out.push(l.optic)
  if (l.stock !== null) out.push(l.stock)
  for (const r of l.rails) {
    if (r !== null) out.push(r)
  }
  return out
}

/** 장착된 부착물의 정적 보정(StaticMods) 합. 유한한 숫자만 더한다. */
function sumMod(l: Loadout, key: keyof StaticMods): number {
  let total = 0
  for (const a of orderedAttachments(l)) {
    const mods = a.mods
    if (mods === undefined) continue
    const v = mods[key]
    if (typeof v === 'number' && Number.isFinite(v)) total += v
  }
  return total
}

/** 선택 필드를 안전하게 읽는다 (undefined / NaN → 기본값) */
function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

// ---------------------------------------------------------------------------
// 준정적 수치
// ---------------------------------------------------------------------------

/** BASE_TRAY(8) + 부착물 tray 합 + 탄창 trayDelta. 최소 1. */
export function computeTraySize(l: Loadout): number {
  const v = BASE_TRAY + sumMod(l, 'tray') + num(l.magazine.trayDelta, 0)
  return Math.max(1, Math.floor(v))
}

/** 탄창 cap + 부착물 cap 합. 최소 1. */
export function computeCap(l: Loadout): number {
  const v = num(l.magazine.cap, 1) + sumMod(l, 'cap')
  return Math.max(1, Math.floor(v))
}

/** 적의 시작 거리 + 부착물 startDist 합. 최소 1 (0 이면 시작하자마자 즉사라 방어). */
export function computeStartDistance(l: Loadout, e: EnemyInstance): number {
  const v = num(e.startDist, 0) + sumMod(l, 'startDist')
  return Math.max(1, v)
}

/** 적 접근 속도 + 부착물 enemySpeed 합. 최소 2 (거인의 보폭 하한). */
export function computeEnemySpeed(l: Loadout, base: number): number {
  const v = num(base, 0) + sumMod(l, 'enemySpeed')
  return Math.max(2, v)
}

/** 사격 1회의 거리 비용 = 접근 속도 + 부착물 fireCost 합 + 탄창 fireCostDelta. 최소 1. */
export function computeFireCost(l: Loadout, e: EnemyInstance, speed: number): number {
  const base = num(speed, num(e.speed, 2))
  const v = base + sumMod(l, 'fireCost') + num(l.magazine.fireCostDelta, 0)
  return Math.max(1, v)
}

/** 배출 1회의 거리 비용 = ceil(속도/2) + 부착물 ejectCost 합 (GDD §2). 최소 0. */
export function computeEjectCost(l: Loadout, e: EnemyInstance, speed: number): number {
  const base = num(speed, num(e.speed, 2))
  const v = Math.ceil(base / 2) + sumMod(l, 'ejectCost')
  return Math.max(0, v)
}

// ---------------------------------------------------------------------------
// 데미지 파이프라인 (GDD §4) — 이 게임의 심장
// ---------------------------------------------------------------------------

/**
 * 한 발을 쏜다. GDD §4 의 7스텝을 정확히 그 순서로 1회전한다.
 *
 * plan 은 "이번 탄창의 발사 순서" 배열이다. index 는 그 안의 0-based 순번이고
 * isLast 판정에도 쓰인다 (탐식의 성궤처럼 발사 수가 장전 수와 다른 탄창은
 * combat 이 실제 발사 순서 배열을 미리 확정해서 넘긴다).
 */
export function fireOneShot(
  s: CombatState,
  ammo: Ammo,
  index: number,
  plan: Ammo[],
  out: FireEvent[],
): void {
  const stats = ammoStats(ammo)
  const mag = s.loadout.magazine

  // --- STEP 1. 기본 데미지 + 축성탄이 예약해 둔 보너스 -----------------------
  // pendingNextDmg 는 여기서 소비되고 즉시 0 이 된다. STEP7 에서 이번 탄이 축성탄이면
  // 새로 예약되므로, 같은 발사가 자기 보너스를 자기가 먹는 일은 구조적으로 불가능하다.
  const carried = Number.isFinite(s.pendingNextDmg) ? s.pendingNextDmg : 0
  s.pendingNextDmg = 0

  // --- STEP 2. 탄 고유 온도 --------------------------------------------------
  const ctx: FireCtx = {
    s,
    self: '',
    ammo,
    index,
    isFirst: index === 0,
    isLast: index === plan.length - 1,
    // 직전에 "실제로 발사한" 탄. 미소모 반복 발사에서도 발사 로그가 곧 진실이다.
    prev: s.magFired.length > 0 ? s.magFired[s.magFired.length - 1] : null,
    // ★ 이번 발사의 heatGain 을 더하기 전 온도
    heatBefore: s.heat,
    dmg: stats.dmg + carried,
    heatGain: stats.heat,
    triggered: [],
  }

  // --- STEP 3 + 4. 부착물 onFire (dmg 와 heatGain 을 같은 순회에서 가산) ------
  // 훅 하나가 둘 다 건드릴 수 있다. 그것이 정상이며, 순회 순서가 결과를 결정론으로 만든다.
  for (const a of s.attachments) {
    const hook = a.hooks?.onFire
    if (hook === undefined) continue
    ctx.self = a.id
    safeCall(`${a.id}.onFire`, () => hook(ctx))
  }
  // 탄창 onFire 는 부착물 전부 뒤에 온다 (규칙 변경자가 마지막 말을 한다).
  const magFire = mag.hooks?.onFire
  if (magFire !== undefined) {
    ctx.self = mag.id
    safeCall(`${mag.id}.onFire`, () => magFire(ctx))
  }
  ctx.self = ''

  // --- STEP 5. 온도 확정 & 적용 ----------------------------------------------
  let heatGain = Number.isFinite(ctx.heatGain) ? ctx.heatGain : 0
  // 탄창 heatGainMul 은 "규칙 변경자"라서 허용된 유일한 예외 곱셈이다 (M2 드럼 = 0.7).
  heatGain *= num(mag.heatGainMul, 1)
  const modHeat = s.enemy.passive?.modifyHeatGain
  if (modHeat !== undefined) {
    const before = heatGain
    heatGain = safeNumber(`${s.enemy.passive?.id ?? '?'}.modifyHeatGain`, before, () =>
      modHeat(before, ctx),
    )
  }
  // 이단심문관의 화염: 이번 탄창 남은 발사의 온도 획득 2배 (중첩 없음)
  if (s.heatDoublePending) heatGain *= 2

  s.heat += heatGain
  if (s.heat > s.peakHeat) s.peakHeat = s.heat

  // 도박꾼의 성구처럼 음수 가산이 있는 부착물이 칩을 0 밑으로 밀면 "적이 회복"하는
  // 사고가 나므로 칩은 0 에서 막는다 (덧셈 규칙 자체는 그대로다).
  const chip = Math.max(0, ctx.dmg)
  const rawDamage = Math.round(chip * s.heat)

  // --- STEP 6. 적 방어 패시브 → HP 차감 --------------------------------------
  let damage = rawDamage
  const modDmg = s.enemy.passive?.modifyDamage
  if (modDmg !== undefined) {
    damage = safeNumber(`${s.enemy.passive?.id ?? '?'}.modifyDamage`, rawDamage, () =>
      modDmg(rawDamage, ctx),
    )
  }
  damage = Math.max(0, Math.round(damage))
  // 음수 HP 는 클램프하지 않는다 — 오버킬 수치가 연출에 쓰인다.
  s.enemy.hp -= damage

  out.push({
    t: 'shot',
    index,
    ammo,
    dmg: chip,
    heatBefore: ctx.heatBefore,
    heatAfter: s.heat,
    damage,
    rawDamage,
    triggered: ctx.triggered.slice(),
    enemyHpAfter: s.enemy.hp,
  })

  // --- STEP 7. 발사 후 --------------------------------------------------------
  for (const a of s.attachments) {
    const hook = a.hooks?.onAfterShot
    if (hook === undefined) continue
    ctx.self = a.id
    safeCall(`${a.id}.onAfterShot`, () => hook(ctx))
  }
  const magAfter = mag.hooks?.onAfterShot
  if (magAfter !== undefined) {
    ctx.self = mag.id
    safeCall(`${mag.id}.onAfterShot`, () => magAfter(ctx))
  }
  const passiveAfter = s.enemy.passive?.onAfterShot
  if (passiveAfter !== undefined) {
    ctx.self = s.enemy.passive?.id ?? 'passive'
    safeCall(`${ctx.self}.onAfterShot`, () => passiveAfter(ctx))
  }
  ctx.self = ''

  // 고폭탄 넉백: 거리를 되사온다.
  if (stats.knockback > 0) {
    s.distance += stats.knockback
    out.push({ t: 'knockback', meters: stats.knockback, distanceAfter: s.distance })
  }

  // 축성탄: 다음 탄 데미지 보너스 예약.
  // 대입(=)이 아니라 가산(+=)인 이유 — 성궤 탄창(M6)이 onAfterShot 에서 1배를 미리
  // 얹어 두기 때문이다. 대입하면 그 예약이 지워져 "2회 적용"이 깨진다.
  if (stats.nextDmgBonus > 0) s.pendingNextDmg += stats.nextDmgBonus

  s.magFired.push(ammo)
  s.magDamage += damage
  s.totalDamage += damage
  s.shotsFired += 1

  if (s.enemy.hp <= 0) {
    out.push({ t: 'enemyDead', overkill: Math.max(0, -s.enemy.hp) })
  }
}

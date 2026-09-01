// core 가 만든 FireEvent[] 를 연출로 번역한다. 로직은 이미 끝나 있다.
// 여기서 하는 일은 "언제 무엇을 보여줄지"뿐이며, 상태를 절대 바꾸지 않는다.
// 타임라인은 PRESENTATION.md §2 의 ms 표와 1:1 이다.

import type { CombatState, FireEvent } from '../core/types'
import { typeColor } from '../core/ammoStats'
import { ATT_BY_ID } from '../core/data/attachments'
import { MAG_BY_ID } from '../core/data/magazines'
import { PASSIVE_BY_ID } from '../core/data/enemies'
import type { GameScene } from '../view3d/Scene'
import { CombatView, nextStartHeat } from '../ui/CombatView'
import { beginSkipScope, dur, easeIn, easeOut, linear, tween, wait, waitUntil } from './tween'

export type { GameScene }

export interface SeqDeps {
  view: CombatView
  scene: GameScene
  /** 1 | 2 | 3 | Infinity(즉시) */
  speed: () => number
  /** 0(끔) ~ 1(강) */
  flashIntensity: () => number
  shakeIntensity: () => number
  haptic: (kind: 'light' | 'heavy') => void
}

// ---------------------------------------------------------------------------
// 씬 브리지
//   3D 를 직접 알지 않고 "구조적으로" 부른다. 메서드가 없으면 조용히 넘어가고,
//   fx 가 아예 없으면 DOM 오버레이(#flash / #heat-vignette)로 떨어진다.
//   → 3D 없이도(테스트/저사양 폴백) 시퀀스가 그대로 돌아간다.
// ---------------------------------------------------------------------------

interface FxLike {
  setIntensity?(flash: number, shake: number): void
  screenFlash?(alpha: number, decayMs: number): void
  aberration?(amount: number, decayMs: number): void
  heatDistortion?(v01: number): void
  setVignette?(v: number): void
  shake?(ampDeg: number, decayMs: number): void
  recoil?(pitchDeg: number, pushM: number, decayMs: number): void
  setRoll?(deg: number): void
  muzzleFlash?(pos: unknown): void
  tracer?(from: unknown, to: unknown, color: number): void
  impact?(pos: unknown, color: number, count?: number): void
  smoke?(pos: unknown): void
}

interface GunLike {
  setHeat?(heat: number): void
  kick?(strength: number): void
  boltBack?(): void
  reloadAnim?(): void
  muzzleWorld?: unknown
}

interface EnemyLike {
  setDistance?(meters: number, startDist?: number, animate?: boolean): void
  hitFlash?(): void
  shake?(): void
  die?(): void
  targetWorld?: unknown
}

interface SceneLike {
  fx?: FxLike
  gun?: GunLike
  enemy?: EnemyLike
  setZoom?(z: number): void
  /** 있으면 처치 슬로모에 쓴다 (없으면 생략) */
  setTimeScale?(v: number): void
  ambient?: { intensity: number }
  flashlight?: { intensity: number }
}

function fn(v: unknown): v is (...a: never[]) => void {
  return typeof v === 'function'
}

/** '#ff7a2a' → 0xff7a2a */
function colorInt(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  return Number.isFinite(n) ? n : 0xffffff
}

class Bridge {
  private readonly sc: SceneLike
  private readonly fx: FxLike | undefined
  /** Fx 가 접근성 강도를 스스로 적용하면(setIntensity 보유) 시퀀서는 중복 적용하지 않는다 */
  private readonly selfScaled: boolean
  private dimSaved: [number, number] | null = null

  constructor(
    scene: GameScene,
    private readonly deps: SeqDeps,
  ) {
    this.sc = scene as unknown as SceneLike
    this.fx = this.sc.fx
    this.selfScaled = this.fx !== undefined && fn(this.fx.setIntensity)
  }

  private get flashScale(): number {
    return this.selfScaled ? 1 : clamp01(this.deps.flashIntensity())
  }

  private get shakeScale(): number {
    return this.selfScaled ? 1 : clamp01(this.deps.shakeIntensity())
  }

  /** 백색 플래시. fx 가 있으면 스스로 감쇠하므로 시퀀서는 한 번만 부른다. */
  flash(alpha: number, decayMs: number): boolean {
    const a = alpha * this.flashScale
    if (this.fx !== undefined && fn(this.fx.screenFlash)) {
      this.fx.screenFlash(a, decayMs)
      return true // 자체 감쇠
    }
    const el = document.getElementById('flash')
    if (el instanceof HTMLElement) el.style.opacity = a.toFixed(3)
    return false
  }

  aberration(amount: number, decayMs: number): void {
    if (this.fx !== undefined && fn(this.fx.aberration)) {
      this.fx.aberration(amount * this.flashScale, decayMs)
    }
  }

  heatDistort(v01: number): void {
    if (this.fx !== undefined && fn(this.fx.heatDistortion)) {
      this.fx.heatDistortion(v01)
      return
    }
    const el = document.getElementById('heat-vignette')
    if (el instanceof HTMLElement) el.style.opacity = v01.toFixed(3)
  }

  vignette(v: number): void {
    if (this.fx !== undefined && fn(this.fx.setVignette)) this.fx.setVignette(v)
  }

  shake(ampDeg: number, decayMs: number): void {
    const a = ampDeg * this.shakeScale
    if (a > 0 && this.fx !== undefined && fn(this.fx.shake)) this.fx.shake(a, decayMs)
  }

  recoil(pitchDeg: number, pushM: number, decayMs: number): void {
    if (this.fx !== undefined && fn(this.fx.recoil)) {
      this.fx.recoil(pitchDeg * this.shakeScale, pushM * this.shakeScale, decayMs)
    }
  }

  roll(deg: number): void {
    if (this.fx !== undefined && fn(this.fx.setRoll)) this.fx.setRoll(deg)
  }

  muzzleFlash(): void {
    const g = this.sc.gun
    if (this.fx !== undefined && fn(this.fx.muzzleFlash) && g?.muzzleWorld !== undefined) {
      this.fx.muzzleFlash(g.muzzleWorld)
    }
  }

  tracer(color: number): void {
    const g = this.sc.gun
    const e = this.sc.enemy
    if (
      this.fx !== undefined &&
      fn(this.fx.tracer) &&
      g?.muzzleWorld !== undefined &&
      e?.targetWorld !== undefined
    ) {
      this.fx.tracer(g.muzzleWorld, e.targetWorld, color)
    }
  }

  impact(color: number, count: number): void {
    const e = this.sc.enemy
    if (this.fx !== undefined && fn(this.fx.impact) && e?.targetWorld !== undefined) {
      this.fx.impact(e.targetWorld, color, count)
    }
  }

  gunHeat(h: number): void {
    if (fn(this.sc.gun?.setHeat)) this.sc.gun.setHeat(h)
  }

  gunKick(strength: number): void {
    if (fn(this.sc.gun?.kick)) this.sc.gun.kick(strength * (0.4 + 0.6 * this.shakeScale))
  }

  reloadAnim(): void {
    if (fn(this.sc.gun?.reloadAnim)) this.sc.gun.reloadAnim()
  }

  /** 노리쇠 후퇴 (GunRig 가 총구 연기까지 같이 낸다) */
  boltBack(): void {
    if (fn(this.sc.gun?.boltBack)) this.sc.gun.boltBack()
  }

  enemyDistance(m: number, startDist: number): void {
    if (fn(this.sc.enemy?.setDistance)) this.sc.enemy.setDistance(m, startDist, false)
  }

  enemyHit(): void {
    if (fn(this.sc.enemy?.hitFlash)) this.sc.enemy.hitFlash()
    if (fn(this.sc.enemy?.shake)) this.sc.enemy.shake()
  }

  enemyDie(): void {
    if (fn(this.sc.enemy?.die)) this.sc.enemy.die()
  }

  zoom(z: number): void {
    if (fn(this.sc.setZoom)) this.sc.setZoom(z)
  }

  timeScale(v: number): void {
    if (fn(this.sc.setTimeScale)) this.sc.setTimeScale(v)
  }

  /** 연출 집중용 조명 감광. 원래 값은 한 번만 저장해 두고 복원한다. */
  dim(mul: number): void {
    const amb = this.sc.ambient
    const spot = this.sc.flashlight
    if (amb === undefined || spot === undefined) return
    if (this.dimSaved === null) this.dimSaved = [amb.intensity, spot.intensity]
    amb.intensity = this.dimSaved[0] * mul
    spot.intensity = this.dimSaved[1] * mul
  }

  restoreLights(): void {
    const amb = this.sc.ambient
    const spot = this.sc.flashlight
    if (this.dimSaved === null || amb === undefined || spot === undefined) return
    amb.intensity = this.dimSaved[0]
    spot.intensity = this.dimSaved[1]
    this.dimSaved = null
  }
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 연출 속도. Infinity 면 모든 대기가 0 이 된다. */
function spd(deps: SeqDeps): number {
  const v = deps.speed()
  if (!Number.isFinite(v)) return Infinity
  return v > 0 ? v : 1
}

/**
 * 플래시 알파.
 * WCAG 2.3.1 — ×3(발당 140ms ≈ 7Hz)은 초당 3회를 넘으므로 자동으로 0.3 배로 강등한다.
 */
function flashAlpha(base: number, speed: number): number {
  return speed >= 3 ? base * 0.3 : base
}

/**
 * 절대 시각 기준 타임라인.
 * at(120) = "이 구간 시작 후 120ms(연출속도 반영) 지점까지 기다린다".
 * 짧은 wait 를 이어 붙이면 프레임 단위 올림이 누적되어(16ms×10단계) 표의 ms 가 무너진다.
 */
function timeline(speed: number): (ms: number) => Promise<void> {
  const t0 = performance.now()
  return (ms: number) => waitUntil(t0 + dur(ms, speed))
}

/** 부착물/탄창/패시브 id → 표시용 이름 */
function procName(id: string): string {
  const a = ATT_BY_ID[id]
  if (a !== undefined) return a.name
  const m = MAG_BY_ID[id]
  if (m !== undefined) return m.name
  const p = PASSIVE_BY_ID[id]
  if (p !== undefined) return p.name
  return id
}

function fmtM(m: number): string {
  const v = Math.max(0, m)
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + 'm'
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/** 사격 행동 1회의 연출 전체 (장전 → 발사들 → 탄창 종료 → 전진). */
export async function playFireSequence(
  events: FireEvent[],
  s: CombatState,
  deps: SeqDeps,
): Promise<void> {
  await run(events, s, deps, false)
}

/** 배출 행동 연출. 이벤트는 보통 advance(+playerDead) 뿐이다. */
export async function playEjectSequence(
  events: FireEvent[],
  s: CombatState,
  deps: SeqDeps,
): Promise<void> {
  await run(events, s, deps, true)
}

// ---------------------------------------------------------------------------
// 본체
// ---------------------------------------------------------------------------

async function run(
  events: FireEvent[],
  s: CombatState,
  deps: SeqDeps,
  isEject: boolean,
): Promise<void> {
  const view = deps.view
  const br = new Bridge(deps.scene, deps)
  const speed = spd(deps)

  view.setBusy(true)
  view.setFxSpeed(speed)

  // 이번 사격에서 소모되지 않은 발사 번호 (M3 탐식의 성궤)
  const kept = new Set<number>()
  for (const ev of events) {
    if (ev.t === 'notConsumed') kept.add(ev.index)
  }

  // uid → 장전 슬롯 번호. 미소모 탄은 같은 슬롯이 여러 번 발사된다.
  const slotOf = new Map<string, number>()
  const firedSlots = new Set<number>()
  let planLen = 0
  let shownHeat = s.heat
  let dead = false
  let lastCost = s.fireCost
  let distBeforeLast = view.shownDistance

  try {
    if (isEject) {
      beginSkipScope()
      deps.haptic('light')
      await wait(180, speed)
    }

    for (const ev of events) {
      switch (ev.t) {
        case 'magStart': {
          planLen = ev.plan.length
          for (let i = 0; i < planLen; i += 1) slotOf.set(ev.plan[i].uid, i)
          shownHeat = ev.heat
          await playMagStart(ev.heat, deps, br, speed)
          break
        }

        case 'shot': {
          shownHeat = ev.heatAfter
          const sl = slotOf.get(ev.ammo.uid)
          if (sl !== undefined) firedSlots.add(sl)
          await playShot(ev, s, deps, br, speed, sl, kept.has(ev.index))
          break
        }

        case 'notConsumed':
          // shot 처리에서 이미 금색으로 남겼다
          break

        case 'attachmentProc': {
          view.showProc(procName(ev.id) + (ev.note === '' ? '' : ' ' + ev.note))
          break
        }

        case 'knockback': {
          beginSkipScope()
          const from = view.shownDistance
          const to = Math.max(0, ev.distanceAfter)
          deps.haptic('light')
          await tween(
            dur(260, speed),
            (t) => {
              const d = from + (to - from) * t
              view.setDistance(d, view.distanceStart, s.fireCost, true)
              br.enemyDistance(d, view.distanceStart)
            },
            easeOut,
          )
          break
        }

        case 'enemyDead': {
          dead = true
          await playKill(s, deps, br, speed)
          break
        }

        case 'magEnd': {
          // 중단된 탄창(열역학 패시브 등)의 미발사 슬롯도 소각된다 — 꺼진 채로 남긴다
          for (let i = 0; i < planLen; i += 1) {
            if (!firedSlots.has(i)) view.markMagSlotSpent(i)
          }
          await playMagEnd(ev.heatCarried, shownHeat, s, deps, br, speed)
          shownHeat = nextStartHeat(s)
          break
        }

        case 'advance': {
          distBeforeLast = view.shownDistance
          lastCost = ev.meters
          await playAdvance(ev.distanceAfter, s, deps, br, speed, dead)
          break
        }

        case 'playerDead': {
          await playDeath(distBeforeLast, lastCost, deps, br, speed)
          break
        }
      }
    }
  } finally {
    br.restoreLights()
    // 연출 도중 예외가 나도 화면은 최종 상태로 되돌린다.
    // 단 전투가 끝났으면 마지막 화면(배너·꺼진 슬롯)을 그대로 둔다 — 전환은 main 이 맡는다.
    if (s.outcome === 'ongoing') view.render(s)
    view.setBusy(false)
  }

  if (!dead && s.outcome === 'ongoing') {
    await view.animateTrayRefill(speed)
  }
}

// ---------------------------------------------------------------------------
// §2.1 장전 (700ms)
// ---------------------------------------------------------------------------

async function playMagStart(
  heat: number,
  deps: SeqDeps,
  br: Bridge,
  speed: number,
): Promise<void> {
  beginSkipScope()
  const view = deps.view
  const at = timeline(speed)

  // 사격 시작 온도 (M9 처형자 = 12.00 처럼 튈 수 있다)
  view.setHeat(heat)
  br.gunHeat(heat)
  br.reloadAnim()

  // t=0 카드가 슬롯으로 빨려 들어간다 (스태거 60ms)
  const load = view.animateLoadStagger(speed)

  await at(300) // 탄창 삽입 — 조작부가 8px 내려갔다 복귀
  void view.nudgeControls(speed)
  deps.haptic('light')

  await at(420) // 노리쇠 전진
  await at(560) // 조명 −20% (연출 집중)
  br.dim(0.8)

  await at(700)
  await load
}

// ---------------------------------------------------------------------------
// §2.2 1발 (420ms)
// ---------------------------------------------------------------------------

async function playShot(
  ev: Extract<FireEvent, { t: 'shot' }>,
  s: CombatState,
  deps: SeqDeps,
  br: Bridge,
  speed: number,
  slot: number | undefined,
  keptShot: boolean,
): Promise<void> {
  beginSkipScope()
  const view = deps.view
  const at = timeline(speed)
  const color = colorInt(typeColor(ev.ammo.type))
  const alpha = flashAlpha(0.88, speed)

  // t=0 — 백색 플래시 + 카메라 킥 + 햅틱
  const selfDecay = br.flash(alpha, 380)
  br.recoil(2.6 + Math.min(1.9, ev.heatBefore * 0.06), 0.08, 260)
  br.gunKick(1)
  deps.haptic('heavy')
  for (const id of ev.triggered) view.showProc(procName(id))

  // fx 가 없으면(DOM 폴백) 감쇠를 직접 만든다: 0.88 → 0.15 → 0
  if (!selfDecay) {
    void (async () => {
      await at(40)
      await tween(dur(80, speed), (t) => br.flash(alpha * (1 - 0.83 * t), 0), linear)
      await tween(dur(200, speed), (t) => br.flash(alpha * 0.17 * (1 - t), 0), linear)
    })()
  }

  // t=20 — 머즐 플래시 + 색수차
  await at(20)
  br.muzzleFlash()
  br.aberration(0.9, 260)

  // t=30 — 트레이서 (총구 → 적 흉부, 90ms)
  await at(30)
  br.tracer(color)

  // t=60 — 셰이크
  await at(60)
  br.shake(0.35 + ev.heatBefore * 0.02, 220)

  // t=120 — 적 피격 + 임팩트 스파크
  await at(120)
  br.enemyHit()
  br.impact(color, 12)
  // 패시브가 피해를 깎았다면 눈에 보이게 알린다 (숫자가 안 맞는 이유를 화면이 설명한다)
  if (ev.damage !== ev.rawDamage && s.enemy.passive !== null) {
    view.showProc('「' + s.enemy.passive.name + '」')
  }

  // t=140 — 데미지 팝업 (기다리지 않는다. 다음 발이 420ms 에 시작한다)
  await at(140)
  void view.showDamagePopup(ev.dmg, ev.heatAfter, ev.damage, speed)

  // t=200 — 적 HP 바
  await at(200)
  view.setEnemyHp(Math.max(0, ev.enemyHpAfter), s.enemy.maxHp)

  // t=250 — 온도 게이지 + 총 이미시브 + 화면 가장자리 열 왜곡
  await at(250)
  view.setHeat(ev.heatAfter)
  br.gunHeat(ev.heatAfter)
  br.heatDistort(ev.heatAfter >= 8 ? clamp01((ev.heatAfter - 8) / 22) : 0)

  // t=380 — 탄피 배출 + 슬롯 소등 (미소모면 금색으로 남는다)
  await at(380)
  if (slot !== undefined) {
    if (keptShot) view.markMagSlotKept(slot)
    else view.markMagSlotSpent(slot)
  }

  // t=420 — 다음 발
  await at(420)
}

// ---------------------------------------------------------------------------
// §2.3 탄창 종료 (앞 300ms. 뒤 300ms 는 advance 가 이어받는다)
// ---------------------------------------------------------------------------

async function playMagEnd(
  heatCarried: number,
  fromHeat: number,
  s: CombatState,
  deps: SeqDeps,
  br: Bridge,
  speed: number,
): Promise<void> {
  beginSkipScope()
  const view = deps.view
  const at = timeline(speed)

  br.boltBack() // 노리쇠 후퇴 + 총구 연기
  br.restoreLights()
  deps.haptic('light')

  await at(150) // 온도 급강하 (냉각 자켓이면 이월 지점에서 멈춘다)
  const to = nextStartHeat(s)
  void tween(
    dur(250, speed),
    (t) => {
      const h = fromHeat + (to - fromHeat) * t
      view.setHeat(h, true)
      br.gunHeat(h)
    },
    easeOut,
  )
  if (heatCarried > 0) view.flashHeatCarry()
  br.heatDistort(0)

  await at(300)
}

// ---------------------------------------------------------------------------
// §2.3 좀비 전진 (600ms, ease-in)
// ---------------------------------------------------------------------------

async function playAdvance(
  distanceAfter: number,
  s: CombatState,
  deps: SeqDeps,
  br: Bridge,
  speed: number,
  dead: boolean,
): Promise<void> {
  beginSkipScope()
  const view = deps.view
  const from = view.shownDistance
  const to = Math.max(0, distanceAfter)
  if (dead) {
    // 죽은 적은 다가오지 않는다. 게이지만 맞춘다.
    view.setDistance(to, view.distanceStart, s.fireCost)
    return
  }
  await tween(
    dur(600, speed),
    (t) => {
      const d = from + (to - from) * t
      view.setDistance(d, view.distanceStart, s.fireCost, true)
      br.enemyDistance(d, view.distanceStart)
    },
    easeIn,
  )
}

// ---------------------------------------------------------------------------
// §2.4 처치 (1.2초)
// ---------------------------------------------------------------------------

async function playKill(
  s: CombatState,
  deps: SeqDeps,
  br: Bridge,
  speed: number,
): Promise<void> {
  beginSkipScope()
  const view = deps.view
  const at = timeline(speed)

  deps.haptic('heavy')
  view.setEnemyHp(0, s.enemy.maxHp)
  br.timeScale(0.25)
  br.enemyDie()

  await at(200)
  br.timeScale(1)
  // 카메라 미세 줌인 (FOV −4° ≈ zoom 1.07)
  void tween(dur(400, speed), (t) => br.zoom(1 + 0.07 * t), easeOut)

  await at(500)
  view.showBanner(
    '정화 완료 / PURGED',
    `최고 온도 ${s.peakHeat.toFixed(2)} · 남은 거리 ${fmtM(s.distance)}`,
  )

  await at(1200) // 보상방 전환은 main 이 맡는다
  br.zoom(1)
}

// ---------------------------------------------------------------------------
// §2.5 즉사 (0.9초)
// ---------------------------------------------------------------------------

async function playDeath(
  distBefore: number,
  cost: number,
  deps: SeqDeps,
  br: Bridge,
  speed: number,
): Promise<void> {
  beginSkipScope()
  const view = deps.view
  const at = timeline(speed)

  deps.haptic('heavy')
  br.dim(0.12) // 화면이 급격히 어두워진다
  br.heatDistort(0)

  await at(250) // 카메라 롤 −18°
  br.roll(-18)
  br.shake(2.2, 400)

  await at(400) // 붉은 비네트 폭발
  br.vignette(1)

  await at(600)
  // 인과를 반드시 표기한다 (PRESENTATION §2.5)
  view.showBanner('접 촉', `마지막 행동 −${fmtM(cost)} · 남아 있던 거리 ${fmtM(distBefore)}`)

  await at(900)
}

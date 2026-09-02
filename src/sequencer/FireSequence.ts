// ============================================================================
// 사격 연출 시퀀서
//   core 의 FireEvent[] 를 연출로 "번역"만 한다. 규칙은 이미 끝나 있다.
//
//   v2 의 핵심 추가: **FILO 장전 연출**
//   탄창을 화면 앞으로 가져와, 플레이어가 지정한 발사 순서의 **마지막 탄부터**
//   차례로 밀어 넣는다. 실제 탄창이 그렇게 동작하기 때문이다 —
//   먼저 넣은 탄이 아래에 깔리고, 마지막에 넣은 탄이 맨 위에서 먼저 나간다.
//   장전이 끝나야 탄창이 총에 물리고 사격이 시작된다.
// ============================================================================
import type { CombatState, FireEvent, Round } from '../core/types'
import { BASIC_DMG } from '../core/types'
import { SPECIAL_BY_ID } from '../core/data/specials'
import type { GameScene } from '../view3d/Scene'
import type { CombatView } from '../ui/CombatView'
import { add } from '../ui/dom'
import { dur, easeIn, easeOut, easeOutBack, tween, wait } from './tween'
import { sfx, sfxShot } from '../audio/Sfx'

export interface SeqDeps {
  view: CombatView
  scene: GameScene
  speed: () => number
  flashIntensity: () => number
  shakeIntensity: () => number
  haptic: (kind: 'light' | 'heavy') => void
}

function label(r: Round): string {
  if (r.special === null) return '기본'
  return SPECIAL_BY_ID[r.special]?.name ?? '특수'
}
function colorOf(r: Round): string {
  if (r.special === null) return '#8f9aa6'
  return SPECIAL_BY_ID[r.special]?.color ?? '#8f9aa6'
}
function dmgOf(r: Round): number {
  if (r.special === null) return BASIC_DMG
  return SPECIAL_BY_ID[r.special]?.dmg ?? BASIC_DMG
}

function has3d(scene: GameScene | null): scene is GameScene {
  return scene !== null && typeof (scene as Partial<GameScene>).setMode === 'function'
}

// ---------------------------------------------------------------------------
// FILO 장전 — **전부 3D**
//   벅샷 룰렛처럼 실제 탄창을 화면 앞으로 가져와, 탄을 하나씩 밀어 넣고,
//   총에 물린 뒤 장전손잡이를 당긴다. DOM 오버레이는 자막 한 줄만 남는다.
//
//   삽탄 순서는 FILO 다 — 발사 순서의 **마지막 탄부터** 넣는다.
//   먼저 넣은 탄이 아래에 깔리고, 마지막에 넣은 탄이 맨 위에서 먼저 나간다.
// ---------------------------------------------------------------------------
function colorNum(r: Round): number {
  return parseInt(colorOf(r).slice(1), 16)
}

async function playLoadSequence(plan: Round[], d: SeqDeps): Promise<void> {
  const sp = d.speed()
  const scene = has3d(d.scene) ? d.scene : null

  // 3D 가 없으면(WebGL 실패) 자막만 띄우고 넘어간다
  if (scene === null) {
    const host = d.view.viewportEl
    const cap = add(host, 'div', 'load-caption', '장전 — 마지막 탄부터')
    await wait(420, sp)
    cap.remove()
    return
  }

  const gun = scene.gun
  gun.beginReload(plan.map(colorNum))

  const host = d.view.viewportEl
  const caption = add(host, 'div', 'load-caption', '탄창 분리')

  // ① 총을 화면 중앙으로 들어올리면서 탄창을 뺀다
  await tween(
    dur(300, sp),
    (t) => {
      scene.setInspect(t)
      gun.setMagPresent(t)
    },
    easeOut,
  )
  sfx('magOut')
  caption.textContent = '장전 — 마지막 탄부터'

  // ② FILO 삽탄
  for (let k = plan.length - 1; k >= 0; k -= 1) {
    await tween(dur(115, sp), (t) => gun.setRoundInsert(k, t), easeOutBack)
    gun.setRoundInsert(k, 1)
    sfx('roundIn', 0.92 + ((plan.length - k) % 3) * 0.06, 0)
    d.haptic('light')
    await wait(34, sp)
  }

  // ③ 탄창을 다시 물린다
  caption.textContent = '삽탄'
  sfx('magIn')
  await tween(dur(230, sp), (t) => gun.setMagSeat(t), easeIn)
  gun.setMagSeat(1)
  d.haptic('heavy')
  await wait(60, sp)

  // ④ 장전손잡이 — 당겼다 놓는다
  caption.textContent = '노리쇠 전진'
  await tween(dur(130, sp), (t) => gun.setChargingHandle(t), easeOut)
  sfx('boltBack')
  await wait(50, sp)
  await tween(dur(90, sp), (t) => gun.setChargingHandle(1 - t), easeIn)
  gun.endReload()
  sfx('boltFwd')
  d.haptic('heavy')

  // 총을 원래 자세로 되돌린다
  caption.remove()
  await tween(dur(200, sp), (t) => scene.setInspect(1 - t), easeIn)
  scene.setInspect(0)
}

// ---------------------------------------------------------------------------
// 한 발 (PRESENTATION §2.2)
// ---------------------------------------------------------------------------
async function playShot(
  ev: Extract<FireEvent, { t: 'shot' }>,
  s: CombatState,
  d: SeqDeps,
): Promise<void> {
  const sp = d.speed()
  const flash = d.flashIntensity()
  const shake = d.shakeIntensity()
  const color = parseInt(colorOf(ev.round).slice(1), 16)

  // 발동한 부착물을 먼저 랙에서 번쩍인다 (원인 → 결과 순서)
  for (const id of ev.triggered) d.view.flashRack(id)
  if (ev.triggered.length > 0) sfx('proc', 1, 60)

  // ── 발사 순간 ────────────────────────────────────────────────────────────
  //   총구 화염 · 화면 번쩍 · 반동 · 총성은 **전부 같은 프레임**이다.
  //   예전에는 번쩍/반동/총성이 t=0, 총구 화염이 t=20ms 였다 — 20ms 는 작아 보여도
  //   "총이 발사되기 전에 화면이 번쩍인다"로 또렷이 읽힌다. 원인보다 결과가 먼저
  //   보이면 타격감이 통째로 무너진다.
  sfxShot(ev.heatAfter)
  if (has3d(d.scene)) {
    const muzzle = d.scene.gun.muzzleWorld
    d.scene.fx.muzzleFlash(muzzle)
    d.scene.fx.tracer(muzzle, d.scene.enemy.targetWorld, color)
    d.scene.gun.kick(0.6 + Math.min(1, ev.heatAfter / 30))
    d.scene.fx.screenFlash(0.88 * flash, dur(40, sp))
    d.scene.fx.aberration(1 * flash, dur(90, sp))
    d.scene.fx.shake((0.35 + ev.heatAfter * 0.02) * shake, dur(220, sp))
  }
  d.haptic('heavy')

  await wait(120, sp)
  if (has3d(d.scene)) {
    sfx('hit', 0.95 + Math.random() * 0.1, 0)
    d.scene.enemy.hitFlash()
    d.scene.enemy.shake()
    d.scene.fx.impact(d.scene.enemy.targetWorld, color)
  }

  await showDamage(ev, d)
  d.view.setHeat(ev.heatAfter)
  d.view.setEnemyHp(ev.enemyHpAfter, s.enemy.maxHp)
  if (has3d(d.scene)) d.scene.gun.setHeat(ev.heatAfter)
  await wait(70, sp)
}

/** 발라트로식 카운트업 — 칩 × 온도 → 합체 */
async function showDamage(ev: Extract<FireEvent, { t: 'shot' }>, d: SeqDeps): Promise<void> {
  const sp = d.speed()
  const host = d.view.viewportEl
  const pop = add(host, 'div', 'dmg-pop')
  const chip = add(pop, 'div', 'dmg-chip', '0')
  add(pop, 'div', 'dmg-x', '×')
  const hv = add(pop, 'div', 'dmg-heat', ev.heatAfter.toFixed(2))

  await tween(
    dur(200, sp),
    (t) => {
      chip.textContent = String(Math.round(ev.dmg * t))
      const sc = (1.35 - 0.35 * t).toFixed(3)
      chip.style.transform = `translateX(${(-24 * (1 - t)).toFixed(1)}px) scale(${sc})`
      hv.style.transform = `translateX(${(24 * (1 - t)).toFixed(1)}px) scale(${sc})`
      pop.style.opacity = String(Math.min(1, t * 4))
    },
    easeOut,
  )
  pop.remove()

  const tot = add(host, 'div', 'dmg-total', '0')
  await tween(
    dur(190, sp),
    (t) => {
      tot.textContent = String(Math.round(ev.damage * t))
      const sc = t < 0.55 ? 0.7 + 0.65 * (t / 0.55) : 1.35 - 0.35 * ((t - 0.55) / 0.45)
      tot.style.transform = `translate(-50%,-50%) scale(${sc.toFixed(3)})`
    },
    easeOut,
  )
  await wait(90, sp)
  await tween(dur(120, sp), (t) => { tot.style.opacity = String(1 - t) })
  tot.remove()
}

// ---------------------------------------------------------------------------
export async function playFireSequence(
  events: readonly FireEvent[],
  s: CombatState,
  d: SeqDeps,
): Promise<void> {
  const sp = d.speed()
  d.view.setBusy(true)
  /** 화면에 지금 떠 있는 온도 — 사격 종료 냉각 연출의 출발점 */
  let shownHeat = s.heatStartBase
  try {
    for (const ev of events) {
      switch (ev.t) {
        case 'magStart':
          await playLoadSequence(ev.plan, d)
          d.view.setHeat(ev.heat)
          shownHeat = ev.heat
          break
        case 'shot':
          await playShot(ev, s, d)
          shownHeat = ev.heatAfter
          break
        case 'notConsumed':
          d.view.showProc('미소모 — ' + label(ev.round))
          await wait(120, sp)
          break
        case 'knockback':
          sfx('knock')
          d.view.showProc(ev.meters > 0 ? '밀어냄 +' + ev.meters + 'm' : ev.meters + 'm')
          d.view.setDistance(ev.distanceAfter, s.enemy.startDist, s.fireCost)
          if (has3d(d.scene)) d.scene.enemy.setDistance(ev.distanceAfter, s.enemy.startDist, true)
          await wait(180, sp)
          break
        case 'debuff':
          d.view.showProc(ev.note)
          await wait(120, sp)
          break
        // 사격이 끝나면 **총열이 식는다.**
        //   온도는 이제 전투 내내 이어지는 자원이라, 이월분(기본 50%)이 얼마인지
        //   눈으로 보여야 다음 탄창 계획이 선다. 숫자가 스르륵 내려가고
        //   총의 발열색도 같이 꺼진다 — 이 한 장면이 이월 규칙을 통째로 가르친다.
        case 'magEnd': {
          sfx('boltBack')
          if (has3d(d.scene)) d.scene.gun.boltBack()
          const from = shownHeat
          const to = ev.heatAfter
          if (to < from - 0.05) {
            d.view.showProc('냉각 ' + from.toFixed(1) + ' → ' + to.toFixed(1))
            await tween(
              dur(600, sp),
              (t) => {
                const h = from + (to - from) * t
                d.view.setHeat(h, false)
                if (has3d(d.scene)) d.scene.gun.setHeat(h)
              },
              easeOut,
            )
            shownHeat = to
          } else {
            await wait(260, sp)
          }
          break
        }
        case 'advance':
          d.view.setDistance(ev.distanceAfter, s.enemy.startDist, s.fireCost)
          if (has3d(d.scene)) d.scene.enemy.setDistance(ev.distanceAfter, s.enemy.startDist, true)
          await wait(420, sp)
          break
        case 'enemyDead':
          sfx('kill')
          if (has3d(d.scene)) {
            d.scene.enemy.die()
            d.scene.setZoom(1.06)
          }
          await wait(700, sp)
          if (has3d(d.scene)) d.scene.setZoom(1)
          break
        case 'playerDead':
          sfx('death')
          if (has3d(d.scene)) {
            d.scene.fx.setRoll(-18)
            d.scene.fx.screenFlash(0.5 * d.flashIntensity(), dur(200, sp))
            d.scene.fx.setTint(0.7, 0.05, 0.05)
          }
          await wait(800, sp)
          break
      }
    }
  } finally {
    d.view.setBusy(false)
    d.view.clearFx()
  }
}

/** v2 에는 배출 행동이 없다 — 호환용 no-op */
export async function playEjectSequence(): Promise<void> {
  return
}


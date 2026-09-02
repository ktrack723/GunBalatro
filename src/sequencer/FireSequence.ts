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
import { add, clear, el } from '../ui/dom'
import { dur, easeOut, easeOutBack, tween, wait } from './tween'
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
// FILO 장전
// ---------------------------------------------------------------------------
async function playLoadSequence(plan: Round[], d: SeqDeps): Promise<void> {
  const sp = d.speed()
  const host = d.view.viewportEl
  const stage = add(host, 'div', 'load-stage')
  const mag = add(stage, 'div', 'load-mag')
  const caption = add(stage, 'div', 'load-caption', '장전 — 마지막 탄부터')

  // 빈 슬롯을 용량만큼 그려 둔다 (아래가 1번 = 가장 먼저 나가는 탄)
  const slots: HTMLElement[] = []
  for (let i = 0; i < plan.length; i += 1) {
    slots.push(add(mag, 'div', 'load-slot', String(plan.length - i)))
  }

  // 1) 탄창이 화면 앞으로 올라온다
  await tween(
    dur(260, sp),
    (t) => {
      mag.style.transform = `translateY(${(120 * (1 - t)).toFixed(1)}%) scale(${(0.8 + 0.2 * t).toFixed(3)})`
      mag.style.opacity = String(Math.min(1, t * 2))
    },
    easeOut,
  )

  // 2) FILO — 발사 순서의 **마지막 탄부터** 넣는다.
  //    column-reverse 라 먼저 넣은 것이 바닥에 깔리고, 마지막에 넣은 것이 맨 위에 온다.
  for (let k = plan.length - 1; k >= 0; k -= 1) {
    const r = plan[k]
    const slot = slots[plan.length - 1 - k]
    const fly = add(stage, 'div', 'load-round', label(r) + ' ' + dmgOf(r))
    fly.style.setProperty('--c', colorOf(r))

    const to = slot.getBoundingClientRect()
    const box = stage.getBoundingClientRect()
    const x = to.left - box.left + to.width / 2
    const y = to.top - box.top + to.height / 2

    await tween(
      dur(120, sp),
      (t) => {
        const sx = box.width * 0.5
        const sy = box.height + 40
        fly.style.left = (sx + (x - sx) * t - 39).toFixed(1) + 'px'
        fly.style.top = (sy + (y - sy) * t - 11).toFixed(1) + 'px'
        fly.style.opacity = String(Math.min(1, t * 3))
      },
      easeOutBack,
    )
    fly.remove()
    sfx('roundIn', 0.92 + (k % 3) * 0.06, 0)
    slot.classList.add('filled')
    slot.style.setProperty('--c', colorOf(r))
    slot.textContent = label(r)
    d.haptic('light')
    await wait(40, sp)
  }

  // 3) 탄창을 총에 물린다
  caption.textContent = '삽탄'
  sfx('magIn')
  if (has3d(d.scene)) d.scene.gun.reloadAnim()
  await tween(
    dur(220, sp),
    (t) => {
      mag.style.transform = `translateY(${(t * 60).toFixed(1)}%) scale(${(1 - 0.15 * t).toFixed(3)})`
      mag.style.opacity = String(1 - t)
    },
    easeOut,
  )
  sfx('boltFwd')
  d.haptic('heavy')
  stage.remove()
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

  for (const id of ev.triggered) d.view.flashRack(id)
  if (ev.triggered.length > 0) sfx('proc', 1, 60)
  sfxShot(ev.heatAfter)

  if (has3d(d.scene)) {
    d.scene.gun.kick(0.6 + Math.min(1, ev.heatAfter / 30))
    d.scene.fx.screenFlash(0.88 * flash, dur(40, sp))
    d.scene.fx.aberration(1 * flash, dur(90, sp))
  }
  d.haptic('heavy')

  await wait(20, sp)
  if (has3d(d.scene)) {
    d.scene.fx.muzzleFlash(d.scene.gun.muzzleWorld)
    d.scene.fx.tracer(d.scene.gun.muzzleWorld, d.scene.enemy.targetWorld, color)
    d.scene.fx.shake((0.35 + ev.heatAfter * 0.02) * shake, dur(220, sp))
  }

  await wait(100, sp)
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
  try {
    for (const ev of events) {
      switch (ev.t) {
        case 'magStart':
          await playLoadSequence(ev.plan, d)
          d.view.setHeat(ev.heat)
          break
        case 'shot':
          await playShot(ev, s, d)
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
        case 'magEnd':
          sfx('boltBack')
          if (has3d(d.scene)) d.scene.gun.boltBack()
          await wait(260, sp)
          break
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

export function magLoadPreview(plan: Round[]): HTMLElement {
  const box = el('div', 'load-mag')
  clear(box)
  for (let i = plan.length - 1; i >= 0; i -= 1) {
    const slot = add(box, 'div', 'load-slot filled', label(plan[i]))
    slot.style.setProperty('--c', colorOf(plan[i]))
  }
  return box
}

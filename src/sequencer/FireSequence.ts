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
import { sfx, sfxRoundIn, sfxShot } from '../audio/Sfx'

/** 한 발을 탄창에 밀어 넣는 데 걸리는 시간 */
const INSERT_MS = 120
/** 그 소리를 얼마나 앞당길 것인가 (실측: 트윈 끝에 울리면 0.1초 늦게 들렸다) */
const INSERT_LEAD_MS = 100
/**
 * 앞당길 시간을 **이징된 진행도**로 환산한 값.
 *   트윈 콜백이 받는 것은 원시 시간 t 가 아니라 easeOutBack(t) 이므로,
 *   원시 시점 (1 − lead/dur) 에 해당하는 이징 값을 미리 구해 문턱으로 쓴다.
 *   easeOutBack 은 되튐 정점까지 단조 증가라 이 문턱을 정확히 한 번 넘는다.
 */
const INSERT_SOUND_AT = easeOutBack(Math.max(0, 1 - INSERT_LEAD_MS / INSERT_MS))

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
  const caption = add(host, 'div', 'load-caption', '')

  // 동작은 **하나씩 끝내고** 다음으로 넘어가며, 단계마다 **다른 소리**가 난다.
  //   탄창을 비우면 노리쇠는 그 자리에서 후퇴 고정된다(§2.3 magEnd). 그러니 재장전은
  //   노리쇠를 다시 당기는 데서 시작하지 않는다 — 이미 뒤에 있다.
  //   순서: 들어올리고 → 탄창을 빼고 → 삽탄하고 → 탄창을 물리고 → 노리쇠를 놓고 → 조준한다.
  //
  //   **총이 보는 방향도 동작을 따라간다.** 탄창은 총 왼쪽에서 빠지고 장전손잡이는
  //   오른쪽에 있다 — 한 방향으로 고정하면 둘 중 하나는 총몸 뒤에 숨는다.
  //   왼쪽(탄창 해제·삽탄) → 정면(탄창 장착) → 오른쪽(노리쇠 전진) 으로 돌려 세운다.
  //   회전과 그 자리에서 하는 동작은 **겹치지 않는다**: 다 돌고 나서 움직인다.
  const step = async (
    text: string,
    ms: number,
    fn: (t: number) => void,
    ease?: (t: number) => number,
  ): Promise<void> => {
    caption.textContent = text
    await tween(dur(ms, sp), fn, ease)
    fn(1)
  }

  // 노리쇠는 마지막 탄을 쏜 그대로 **후퇴 고정** 상태다. 눈에 보이게 못 박아 둔다.
  gun.setChargingHandle(1)

  // ① 총을 카메라 앞으로 들어올리면서 **왼쪽**으로 돌린다 — 탄창이 빠지는 면이다
  sfx('poseUp', 1, 0)
  await step('총을 든다', 300, (t) => {
    scene.setInspect(t)
    scene.gun.setCant(-t)
  }, easeOut)
  await wait(90, sp)

  // ② 탄창 해제 — 멈치를 누르고, 탄창이 빠진다
  sfx('magRelease', 1, 0)
  await wait(90, sp)
  sfx('magOut', 1, 0)
  d.haptic('light')
  await step('탄창 해제', 230, (t) => gun.setMagPresent(t), easeOut)
  await wait(110, sp)

  // ③ 삽탄 — 한 발마다 탁. 마지막 탄부터 넣는다(FILO)
  caption.textContent = '삽탄 — 마지막 탄부터'
  for (let k = plan.length - 1; k >= 0; k -= 1) {
    // 소리는 **트윈이 끝나기 전에** 울린다. 예전에는 트윈이 다 끝난 뒤에 울려서
    //   그림보다 한 박자 늦게 들렸다 — 탄은 이미 들어갔는데 소리가 따라왔다.
    //   INSERT_LEAD_MS 만큼 앞당긴 시점을 이징된 진행도로 환산해 그 지점에서 낸다
    //   (트윈 콜백은 원시 시간이 아니라 이징된 값을 받는다).
    let rang = false
    const ring = (): void => {
      if (rang) return
      rang = true
      // 발마다 피치를 조금씩 흔든다 — 같은 소리가 연달아 나도 기계 반복으로 안 들린다
      sfxRoundIn(0.94 + ((plan.length - k) % 4) * 0.045)
      d.haptic('light')
    }
    await tween(
      dur(INSERT_MS, sp),
      (t) => {
        gun.setRoundInsert(k, t)
        if (t >= INSERT_SOUND_AT) ring()
      },
      easeOutBack,
    )
    gun.setRoundInsert(k, 1)
    ring() // 스킵으로 콜백이 곧장 1 로 온 경우에도 한 번은 반드시 운다
    await wait(80, sp)
  }
  await wait(90, sp)

  // ④ 탄창 장착 — 먼저 **정면**으로 되돌리고, 다 돌고 나서 물린다
  await step('탄창 장착', 220, (t) => gun.setCant(-1 + t), easeOut)
  gun.setCant(0)
  await wait(90, sp)
  // 소리는 **물리는 순간** 난다 — setMagSeat(1) 이 mag.seat 를 쏘고, 그게
  //   녹음된 장착음으로 이어진다. 여기서 미리 울리면 그림보다 230ms 앞선다.
  d.haptic('heavy')
  await step('탄창 장착', 230, (t) => gun.setMagSeat(t), easeIn)
  await wait(150, sp)

  // ⑤ 노리쇠 전진 — 손잡이가 있는 **오른쪽**으로 마저 돌리고, 회전이 끝난 다음에
  //   놓아 약실에 문다. 여기서 재장전이 '끝났다' 는 신호가 나므로 **완결에 시간을
  //   준다**: 전진 자체를 길게 끌고, 물린 뒤에도 한 박자 머문 다음에 넘어간다.
  await step('노리쇠 전진', 220, (t) => gun.setCant(t), easeOut)
  gun.setCant(1)
  await wait(110, sp)
  sfx('boltFwd', 1, 0)
  d.haptic('heavy')
  await step('노리쇠 전진', 240, (t) => gun.setChargingHandle(1 - t), easeIn)
  gun.setChargingHandle(0)
  gun.endReload()
  await wait(300, sp)

  // ⑥ 노리쇠가 돌아온 **다음에** 조준선을 정렬한다
  sfx('aimUp', 1, 0)
  await step('조준', 260, (t) => {
    scene.setInspect(1 - t)
    scene.gun.setCant(1 - t)
    scene.setAim(t)
  }, easeOut)
  scene.setInspect(0)
  scene.gun.setCant(0)
  scene.setAim(1)
  caption.remove()
  await wait(90, sp)
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

  const scene = has3d(d.scene) ? d.scene : null

  // ── ① 발사 순간 ─────────────────────────────────────────────────────────
  //   총구 화염 · 광원 · 반동 · 총성이 전부 같은 프레임이다.
  //   **화면을 흰색으로 덮지 않는다.** 대신 총구에 진짜 점광이 켜져 복도 전체가
  //   한 순간 밝아진다 — 벽도 기물도 적도 각자의 거리만큼 밝아지므로
  //   "어디서 빛이 났는지" 가 화면에 남는다. 오버레이는 그걸 못 한다.
  sfxShot(ev.heatAfter)
  // 탄이 날아가는 **선을 그리지 않는다.** 총구 화염 → (짧은 사이) → 적에게 박히는
  //   스파크. 궤적을 지우면 "쐈다" 를 알리는 건 총의 반동뿐이라 그 튐을 크게 준다.
  let flightMs = 62
  if (scene !== null) {
    const from = scene.gun.muzzleWorld.clone()
    flightMs = Math.round(Math.min(96, Math.max(50, 44 + scene.enemy.targetWorld.distanceTo(from) * 1.6)))
    scene.fx.muzzleFlash(from)
    scene.gun.kick(1.0 + Math.min(1.2, ev.heatAfter / 24))
    scene.gun.ejectCasing()
    // 화면 흔들림은 **반동과 같은 프레임**에 온다. 총이 튀는데 화면이 가만히
    //   있으면 반동이 총만의 일이 된다 — 짧고 세게 흔들어 손에 붙인다.
    scene.fx.shake((0.85 + Math.min(0.5, ev.heatAfter / 60)) * shake, dur(190, sp))
  }
  d.haptic('heavy')

  // ── ② 탄이 날아가는 동안 ────────────────────────────────────────────────
  await wait(flightMs, sp)

  // ── ③ 착탄 — 여기가 이 게임의 '한 컷' 이다 ──────────────────────────────
  //   스파크가 터지고, 적이 뒤로 밀리며 다리가 꺾이고, **시간이 멈춘다.**
  //   히트스톱이 없으면 스파크가 그냥 스쳐 지나가서 타격이 사건으로 안 읽힌다.
  if (scene !== null) {
    const hit = scene.enemy.targetWorld.clone()
    const power = 0.7 + Math.min(1.1, (ev.damage / Math.max(1, s.enemy.maxHp)) * 5)
    sfx('hit', 0.95 + Math.random() * 0.1, 0)
    scene.enemy.hitFlash()
    scene.enemy.shake(power)
    scene.fx.impactFrame(hit, color, power * flash)
    scene.fx.shake((0.55 + ev.heatAfter * 0.02) * shake, dur(240, sp))
    scene.fx.aberration(0.9 * flash, dur(110, sp))
    // 프레임 정지 없음. 시퀀서의 대기는 실시간이라 템포는 그대로다.
    scene.setZoom(1.028)
  }

  // 히트스톱이 도는 동안 숫자가 올라간다 — 멈춘 화면 위에 결과가 얹힌다.
  //   리듬: 쏘고 → 숫자 → 아주 잠깐 멈춤 → 거의 바로 다음 발. 숫자가 사라지는
  //   시간은 기다리지 않는다(다음 발의 비행 동안 알아서 지워진다).
  await showDamage(ev, d)
  if (scene !== null) scene.setZoom(1)
  d.view.setHeat(ev.heatAfter)
  d.view.setEnemyHp(ev.enemyHpAfter, s.enemy.maxHp)
  if (scene !== null) scene.gun.setHeat(ev.heatAfter)
  await wait(55, sp)
}

/**
 * 발라트로식 카운트업 — 칩 × 온도 → 합체.
 *   예전엔 한 발당 200+190+90+120ms 를 전부 기다렸다(≈0.6초). 지금은 칩·합계가
 *   각각 110/120ms 에 튀어나오고, 합계의 페이드는 기다리지 않는다 — 다음 발이
 *   날아가는 동안 지워진다. 한 발의 체감 길이는 비행 + 숫자 + 55ms 멈춤이다.
 */
async function showDamage(ev: Extract<FireEvent, { t: 'shot' }>, d: SeqDeps): Promise<void> {
  const sp = d.speed()
  const host = d.view.viewportEl
  // 아직 지워지는 중인 이전 합계는 즉시 치운다 — 숫자가 겹쳐 보이면 안 된다
  for (const stale of Array.from(host.querySelectorAll('.dmg-total'))) stale.remove()
  const pop = add(host, 'div', 'dmg-pop')
  const chip = add(pop, 'div', 'dmg-chip', '0')
  add(pop, 'div', 'dmg-x', '×')
  const hv = add(pop, 'div', 'dmg-heat', ev.heatAfter.toFixed(2))

  await tween(
    dur(110, sp),
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
    dur(120, sp),
    (t) => {
      tot.textContent = String(Math.round(ev.damage * t))
      const sc = t < 0.55 ? 0.7 + 0.65 * (t / 0.55) : 1.35 - 0.35 * ((t - 0.55) / 0.45)
      tot.style.transform = `translate(-50%,-50%) scale(${sc.toFixed(3)})`
    },
    easeOut,
  )
  // 페이드는 비동기 — 다음 발을 막지 않는다
  void (async (): Promise<void> => {
    await wait(140, sp)
    await tween(dur(160, sp), (t) => { tot.style.opacity = String(1 - t) })
    tot.remove()
  })()
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
          // 사격이 끝났으니 조준을 풀고 원래 자세로 돌아간다 (이것도 한 동작이다)
          if (has3d(d.scene)) {
            const sc = d.scene
            sfx('poseDown', 1, 0)
            await tween(dur(220, sp), (t) => sc.setAim(1 - t), easeIn)
            sc.setAim(0)
          }
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
            const at = d.scene.enemy.targetWorld.clone()
            d.scene.fx.impactFrame(at, 0xffd0a0, 2.0 * d.flashIntensity())
            d.scene.fx.impact(at, 0xff6a2a, 40)
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


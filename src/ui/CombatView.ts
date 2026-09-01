// 전투 화면 전체 (HUD / 거리 / 온도 / 탄창 / 트레이 / 액션).
// style.css 의 클래스 이름을 그대로 쓴다. 3D 는 이 DOM 뒤에 깔린다.
//
// 이 뷰의 유일한 규칙 지식은 "탄을 어떤 순서로 넣었는가(plan)" 뿐이다.
// 데미지 예측은 전부 core 의 previewDamage 에 위임한다 — 예측과 실제가 어긋날 수 없다.

import type { Ammo, CombatState } from '../core/types'
import { BASE_HEAT } from '../core/types'
import { ammoLabel, ammoStats, gradeRoman, typeColor, typeShort } from '../core/ammoStats'
import { maxEject, previewDamage } from '../core/combat'
import {
  Bin,
  add,
  clamp,
  clear,
  closestFrom,
  el,
  fmtInt,
  on,
  orderMark,
  pct,
  setClass,
} from './dom'
import { closePopover, confirmPop, infoPop } from './popover'
import { toast } from './toast'
import {
  dur,
  easeOut,
  easeOutBack,
  fxRange,
  fxSigned,
  killTweens,
  linear,
  requestSkip,
  tween,
  wait,
} from '../sequencer/tween'

export interface CombatViewCallbacks {
  onFire(plan: Ammo[]): void
  onEject(uids: string[]): void
  onOpenLoadout(): void
}

/** 드래그 판정 임계값 (TECH §4.1) */
const DRAG_PX = 8
/** 롱프레스 (PRESENTATION §4.4) */
const LONG_MS = 400
/** 온도 게이지 로그 스케일 상한 */
const HEAT_TOP = 50
/** 온도 눈금 위치 */
const HEAT_TICKS = [3, 8, 16, 30]

type PressKind = 'tray' | 'mag' | 'hud'

interface Press {
  kind: PressKind
  pointerId: number
  x0: number
  y0: number
  uid: string
  index: number
  moved: boolean
  dragging: boolean
  long: boolean
  timer: number
}

/** 온도 → 단계(0~4). PRESENTATION §3 표. */
function heatStage(h: number): number {
  if (h < 3) return 0
  if (h < 8) return 1
  if (h < 16) return 2
  if (h < 30) return 3
  return 4
}

/** 로그 스케일 위치 (1 → 0, 50 → 1) */
function heatFrac(h: number): number {
  const v = h < 1 ? 1 : h
  return clamp(Math.log(v) / Math.log(HEAT_TOP), 0, 1)
}

/** 거리 표기 — 넉백으로 소수가 생길 수 있다 */
function fmtMeters(m: number): string {
  const v = Math.max(0, m)
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + 'm'
}

/**
 * 대기 상태에서 보여줄 온도.
 * 사격이 끝난 뒤 s.heat 는 아직 "식지 않은" 값이라, 그대로 보여주면
 * 다음 사격이 1.00 에서 시작한다는 사실을 감춰 버린다 (combat.fire §2 와 같은 규칙).
 */
export function nextStartHeat(s: CombatState): number {
  if (s.magsFired === 0) return s.heat
  if (s.flags['eternalFlame'] === true) return Math.max(BASE_HEAT, s.heat - 5)
  return s.heatStartBase
}

export class CombatView {
  private readonly host: HTMLElement
  private readonly cb: CombatViewCallbacks
  private readonly bin = new Bin()
  private readonly timers = new Set<number>()

  private state: CombatState | null = null
  /** 장전 계획 = 이 화면의 유일한 편집 상태 */
  private plan: Ammo[] = []
  private busy = false
  private fxSpeed = 1
  private distStart = 30
  private shownDist = 30
  private lastStage = -1
  private heatImmediate = false
  private distImmediate = false
  private press: Press | null = null
  private wide: boolean | null = null

  // --- DOM ---
  private readonly root: HTMLDivElement
  private readonly hudTop: HTMLDivElement
  private readonly enemyName: HTMLDivElement
  private readonly enemyThreat: HTMLDivElement
  private readonly passiveChip: HTMLDivElement
  private readonly hpNum: HTMLDivElement
  private readonly hpFill: HTMLDivElement
  private readonly viewport: HTMLDivElement
  private readonly procRail: HTMLDivElement
  private readonly side: HTMLDivElement
  private readonly distRow: HTMLDivElement
  private readonly distNum: HTMLDivElement
  private readonly distTrack: HTMLDivElement
  private readonly distFill: HTMLDivElement
  private readonly distCost: HTMLDivElement
  private readonly heatRow: HTMLDivElement
  private readonly heatNum: HTMLDivElement
  private readonly heatTrack: HTMLDivElement
  private readonly heatFill: HTMLDivElement
  private readonly magRow: HTMLDivElement
  private readonly magSlots: HTMLDivElement
  private readonly previewNum: HTMLDivElement
  private readonly trayRow: HTMLDivElement
  private readonly actRow: HTMLDivElement
  private readonly btnEject: HTMLButtonElement
  private readonly btnEjectSub: HTMLElement
  private readonly btnFire: HTMLButtonElement
  private readonly btnFireSub: HTMLElement
  private readonly overlay: HTMLDivElement

  private slotEls: HTMLDivElement[] = []
  private readonly trayCards = new Map<string, HTMLDivElement>()
  private readonly fxNodes: HTMLElement[] = []
  private readonly mq: MediaQueryList

  constructor(host: HTMLElement, cb: CombatViewCallbacks) {
    this.host = host
    this.cb = cb

    // ---- 골격 ----
    this.root = el('div', 'combat-root')
    // 팝업/오버레이 기준점. 레이아웃에는 영향이 없다.
    this.root.style.position = 'relative'

    this.hudTop = add(this.root, 'div', 'hud-top')
    this.hudTop.setAttribute('role', 'button')
    this.hudTop.setAttribute('aria-label', '장비 보기')
    const topRow = add(this.hudTop, 'div', 'hud-top-row')
    this.enemyName = add(topRow, 'div', 'enemy-name')
    this.enemyThreat = add(topRow, 'div', 'enemy-threat')
    this.passiveChip = add(topRow, 'div', 'passive-chip')
    this.passiveChip.style.display = 'none'
    this.hpNum = add(topRow, 'div', 'enemy-hp-num')
    const hpbar = add(this.hudTop, 'div', 'hpbar')
    this.hpFill = add(hpbar, 'div', 'hpbar-fill')

    this.viewport = add(this.root, 'div', 'viewport-space')
    this.procRail = add(this.viewport, 'div', 'proc-rail')

    // 가로 모드에서만 쓰는 래퍼 (style.css 의 .combat-root > .side)
    this.side = el('div', 'side')

    this.distRow = el('div', 'dist-row')
    this.distNum = add(this.distRow, 'div', 'dist-num')
    this.distTrack = add(this.distRow, 'div', 'dist-track')
    this.distFill = add(this.distTrack, 'div', 'dist-fill')
    this.distCost = add(this.distRow, 'div', 'dist-cost')

    this.heatRow = el('div', 'heat-row')
    add(this.heatRow, 'div', 'heat-label', '온도')
    this.heatNum = add(this.heatRow, 'div', 'heat-num', '1.00')
    this.heatTrack = add(this.heatRow, 'div', 'heat-track')
    this.heatFill = add(this.heatTrack, 'div', 'heat-fill')
    for (const v of HEAT_TICKS) {
      const tick = add(this.heatTrack, 'div', 'heat-tick')
      tick.style.left = pct(heatFrac(v))
      tick.title = String(v)
    }

    this.magRow = el('div', 'mag-row')
    this.magSlots = add(this.magRow, 'div', 'mag-slots')
    const prev = add(this.magRow, 'div', 'mag-preview')
    add(prev, 'div', 'mag-preview-label', '예상 피해')
    this.previewNum = add(prev, 'div', 'mag-preview-num', '—')
    this.previewNum.setAttribute('aria-live', 'polite')

    this.trayRow = el('div', 'tray-row')

    this.actRow = el('div', 'act-row')
    this.btnEject = add(this.actRow, 'button', 'btn')
    this.btnEject.type = 'button'
    add(this.btnEject, 'span', undefined, '배출')
    this.btnEjectSub = add(this.btnEject, 'small', undefined, '')
    this.btnFire = add(this.actRow, 'button', 'btn primary')
    this.btnFire.type = 'button'
    add(this.btnFire, 'span', undefined, '사 격')
    this.btnFireSub = add(this.btnFire, 'small', undefined, '')

    // 연출 중 입력 차단 + 탭하면 스킵
    this.overlay = el('div')
    this.overlay.style.cssText =
      'position:absolute;inset:0;z-index:30;display:none;background:transparent;'
    this.overlay.setAttribute('aria-hidden', 'true')
    this.root.appendChild(this.overlay)

    this.mq = window.matchMedia('(orientation: landscape) and (max-height: 560px)')
    this.applyLayout()

    host.appendChild(this.root)
    this.bindEvents()
  }

  // =========================================================================
  // 레이아웃 (세로: .combat-root 직계 / 가로: .side 래퍼)
  // =========================================================================

  private applyLayout(): void {
    const wide = this.mq.matches
    if (wide === this.wide) return
    this.wide = wide
    const rows = [this.distRow, this.heatRow, this.magRow, this.trayRow, this.actRow]
    if (wide) {
      for (const r of rows) this.side.appendChild(r)
      this.root.insertBefore(this.side, this.overlay)
    } else {
      this.side.remove()
      for (const r of rows) this.root.insertBefore(r, this.overlay)
    }
  }

  // =========================================================================
  // 이벤트 배선
  // =========================================================================

  private bindEvents(): void {
    const b = this.bin
    b.add(on<PointerEvent>(this.trayRow, 'pointerdown', (e) => this.onTrayDown(e)))
    b.add(on<PointerEvent>(this.magSlots, 'pointerdown', (e) => this.onMagDown(e)))
    b.add(on<PointerEvent>(this.hudTop, 'pointerdown', (e) => this.onHudDown(e)))
    b.add(on<PointerEvent>(window, 'pointermove', (e) => this.onMove(e)))
    b.add(on<PointerEvent>(window, 'pointerup', (e) => this.onUp(e)))
    b.add(on<PointerEvent>(window, 'pointercancel', () => this.cancelPress()))
    b.add(on(this.btnFire, 'click', () => void this.onFireClick()))
    b.add(on(this.btnEject, 'click', () => this.onEjectClick()))
    b.add(on<PointerEvent>(this.overlay, 'pointerdown', () => requestSkip()))
    b.add(on(this.mq, 'change', () => this.applyLayout()))
  }

  private later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id)
      fn()
    }, Math.max(0, ms))
    this.timers.add(id)
  }

  // =========================================================================
  // 렌더
  // =========================================================================

  /** 상태를 통째로 다시 그린다 (전투 시작, 사격/배출 후). 장전 계획은 초기화된다. */
  render(s: CombatState): void {
    const fresh = this.state === null || this.state.enemy !== s.enemy
    this.state = s
    this.plan = []
    this.clearFxNodes()
    if (fresh) {
      this.distStart = Math.max(1, s.distance)
      this.lastStage = -1
    }
    this.distStart = Math.max(this.distStart, s.distance, 1)

    // 적
    this.enemyName.textContent = s.enemy.archetype.name
    this.enemyThreat.textContent = s.enemy.label.replace(/[^◆]/g, '')
    const p = s.enemy.passive
    if (p !== null) {
      this.passiveChip.style.display = ''
      this.passiveChip.textContent = '「' + p.name + '」'
      this.passiveChip.setAttribute('aria-label', p.name + '. ' + p.text)
    } else {
      this.passiveChip.style.display = 'none'
      this.passiveChip.textContent = ''
    }
    this.setEnemyHp(s.enemy.hp, s.enemy.maxHp)
    this.setDistance(s.distance, this.distStart, s.fireCost)
    this.setHeat(nextStartHeat(s))

    this.buildSlots(s.cap)
    this.renderMag()
    this.renderTray()
    this.updatePreview()
    this.updateButtons()
  }

  private buildSlots(cap: number): void {
    clear(this.magSlots)
    this.slotEls = []
    const n = Math.max(1, Math.min(cap, 24))
    for (let i = 0; i < n; i += 1) {
      const sl = el('div', 'mag-slot')
      sl.dataset['i'] = String(i)
      this.magSlots.appendChild(sl)
      this.slotEls.push(sl)
    }
  }

  private makeCard(a: Ammo, hiddenFace: boolean, mini: boolean): HTMLDivElement {
    const c = el('div', 'card' + (mini ? ' mini' : '') + (hiddenFace ? ' hidden-card' : ''))
    c.style.setProperty('--c', typeColor(a.type))
    if (mini) {
      // .card.mini 는 38×54 고정이라 슬롯 안쪽(테두리 제외)보다 2px 크다 → 꽉 채운다
      c.style.width = '100%'
      c.style.height = '100%'
    }
    add(c, 'div', 'card-type', typeShort(a.type))
    add(c, 'div', 'card-grade', gradeRoman(a.grade))
    const st = ammoStats(a)
    add(c, 'div', 'card-dmg', String(st.dmg))
    c.dataset['uid'] = a.uid
    c.setAttribute('role', 'button')
    c.setAttribute(
      'aria-label',
      hiddenFace ? '가려진 탄' : `${ammoLabel(a)}, 피해 ${st.dmg}, 온도 ${st.heat.toFixed(2)}`,
    )
    return c
  }

  private renderTray(): void {
    const s = this.state
    if (s === null) return
    clear(this.trayRow)
    this.trayCards.clear()
    setClass(this.trayRow, 'wide', s.tray.length + s.reserve.length > 8 || s.traySize > 8)
    const hidden = clamp(s.hiddenTrayCount, 0, s.tray.length)
    for (let i = 0; i < s.tray.length; i += 1) {
      const a = s.tray[i]
      const c = this.makeCard(a, i < hidden, false)
      this.trayRow.appendChild(c)
      this.trayCards.set(a.uid, c)
    }
    // 예비칸(탄약 주머니 등이 만든 전투 한정 탄)도 손에 든 탄이다 — 안 보여주면 못 쓴다
    for (const a of s.reserve) {
      const c = this.makeCard(a, false, false)
      c.style.borderColor = 'var(--brass-dim)'
      c.style.borderStyle = 'dashed'
      const badge = add(c, 'div', 'card-order', '예')
      badge.style.left = '3px'
      badge.style.right = 'auto'
      c.setAttribute('aria-label', (c.getAttribute('aria-label') ?? '') + ', 예비칸')
      this.trayRow.appendChild(c)
      this.trayCards.set(a.uid, c)
    }
    this.syncTraySelection()
  }

  private syncTraySelection(): void {
    const inPlan = new Set(this.plan.map((a) => a.uid))
    for (const [uid, c] of this.trayCards) setClass(c, 'selected', inPlan.has(uid))
  }

  /** 슬롯 내용만 갱신한다 (요소 자체는 유지 — 드래그 중 포인터 캡처가 살아 있어야 한다) */
  private renderMag(): void {
    for (let i = 0; i < this.slotEls.length; i += 1) {
      const sl = this.slotEls[i]
      const a = this.plan[i]
      clear(sl)
      sl.style.transform = ''
      sl.style.zIndex = ''
      sl.style.opacity = ''
      sl.style.boxShadow = ''
      if (a === undefined) {
        setClass(sl, 'filled', false)
        sl.style.borderColor = ''
        sl.textContent = String(i + 1)
        sl.setAttribute('aria-label', `${i + 1}번 빈 슬롯`)
        continue
      }
      setClass(sl, 'filled', true)
      sl.style.borderColor = typeColor(a.type)
      const card = this.makeCard(a, false, true)
      add(card, 'div', 'card-order', orderMark(i + 1))
      sl.appendChild(card)
      sl.setAttribute('aria-label', `${i + 1}번 ${ammoLabel(a)}`)
    }
  }

  private updateButtons(): void {
    const s = this.state
    const n = this.plan.length
    const live = s !== null && s.outcome === 'ongoing' && !this.busy
    this.btnEject.disabled = !live || n === 0
    this.btnFire.disabled = !live || n === 0
    if (s === null) return
    const ejectN = Math.min(n, maxEject(s))
    this.btnEjectSub.textContent = `−${s.ejectCost}m · ${ejectN}장`
    this.btnFireSub.textContent = `−${s.fireCost}m · ${n}/${s.cap}발`
    this.btnEject.setAttribute('aria-label', `배출, 거리 ${s.ejectCost}미터 소모`)
    this.btnFire.setAttribute('aria-label', `사격, 거리 ${s.fireCost}미터 소모`)
  }

  /** 이 게임을 가르치는 장치 — 슬롯이 바뀔 때마다 즉시 갱신된다 */
  private updatePreview(): void {
    const s = this.state
    if (s === null) return
    if (this.plan.length === 0) {
      this.previewNum.textContent = '—'
      setClass(this.previewNum, 'lethal', false)
      return
    }
    const r = previewDamage(s, this.plan)
    // 확률 요소가 섞이면 '≈' 대신 '~' (PRESENTATION §4.5)
    this.previewNum.textContent = (r.approximate ? '~' : '≈') + ' ' + fmtInt(r.expected)
    setClass(this.previewNum, 'lethal', r.expected >= s.enemy.hp)
  }

  // =========================================================================
  // 부분 갱신 (연출용)
  // =========================================================================

  setBusy(busy: boolean): void {
    this.busy = busy
    this.overlay.style.display = busy ? 'block' : 'none'
    if (busy) this.cancelPress()
    this.updateButtons()
  }

  /** 연출 속도를 알려 주면 장식 트윈도 같이 빨라진다 */
  setFxSpeed(speed: number): void {
    this.fxSpeed = speed > 0 ? speed : 1
  }

  /**
   * @param immediate 매 프레임 갱신(연출 트윈)일 때 true.
   *   CSS transition(.25s)이 켜진 채로 프레임마다 목표값을 바꾸면 게이지가 값을 못 따라간다.
   */
  setHeat(heat: number, immediate = false): void {
    const h = Number.isFinite(heat) ? heat : BASE_HEAT
    if (immediate !== this.heatImmediate) {
      this.heatImmediate = immediate
      this.heatFill.style.transition = immediate ? 'none' : ''
    }
    const st = heatStage(h)
    const c = `var(--heat-${st})`
    this.heatNum.textContent = h.toFixed(2)
    this.heatNum.style.color = c
    this.heatNum.style.textShadow = st >= 3 ? '0 0 10px rgba(255,196,77,.55)' : 'none'
    this.heatFill.style.width = pct(heatFrac(h))
    this.heatFill.style.background = c
    if (st !== this.lastStage) {
      if (this.lastStage >= 0 && st > this.lastStage) this.pulseHeatRow()
      this.lastStage = st
    }
  }

  /** 온도 단계가 올라간 순간 한 번 번쩍인다 (임계점 통과를 몸으로 알린다) */
  private pulseHeatRow(): void {
    const row = this.heatRow
    void tween(
      dur(360, this.fxSpeed),
      (t) => {
        const a = Math.sin(Math.PI * t)
        row.style.boxShadow = `inset 0 0 ${(22 * a).toFixed(1)}px rgba(255,140,40,${(0.5 * a).toFixed(3)})`
      },
      linear,
    ).then(() => {
      row.style.boxShadow = ''
    })
  }

  setEnemyHp(hp: number, max: number): void {
    const m = Math.max(1, Math.round(max))
    const h = clamp(Math.round(hp), 0, m)
    this.hpNum.textContent = `${fmtInt(h)}/${fmtInt(m)}`
    this.hpFill.style.width = pct(h / m)
  }

  setDistance(d: number, start: number, cost: number, immediate = false): void {
    const dd = Math.max(0, d)
    if (immediate !== this.distImmediate) {
      this.distImmediate = immediate
      this.distFill.style.transition = immediate ? 'none' : ''
    }
    this.shownDist = dd
    this.distStart = Math.max(1, start, dd)
    const f = clamp(dd / this.distStart, 0, 1)
    this.distNum.textContent = fmtMeters(dd)
    this.distFill.style.width = pct(f)
    setClass(this.distTrack, 'warn', f <= 0.4 && f > 0.2)
    setClass(this.distTrack, 'danger', f <= 0.2)
    this.distNum.style.color =
      f <= 0.2 ? 'var(--blood-bright)' : f <= 0.4 ? 'var(--brass)' : 'var(--text)'
    this.distCost.textContent = `▶${fmtMeters(cost)}/행동`
  }

  get distanceStart(): number {
    return this.distStart
  }

  get shownDistance(): number {
    return this.shownDist
  }

  get planCount(): number {
    return this.plan.length
  }

  /** 부착물 발동 표시 (뷰포트 좌측에서 0.3초 튀어나온다) */
  showProc(name: string): void {
    const chip = add(this.procRail, 'div', 'proc-chip', name)
    while (this.procRail.childElementCount > 4) {
      const first = this.procRail.firstElementChild
      if (first === null) break
      first.remove()
    }
    this.later(() => {
      chip.style.transition = 'opacity .18s linear, transform .18s ease-in'
      chip.style.opacity = '0'
      chip.style.transform = 'translateX(-10px)'
      this.later(() => chip.remove(), 200)
    }, dur(900, this.fxSpeed))
  }

  /**
   * 발라트로식 데미지 팝업. 좌(칩) × 우(온도) → 중앙 합체.
   * PRESENTATION §2.2 t=140~360.
   */
  async showDamagePopup(dmg: number, heat: number, total: number, speed: number): Promise<void> {
    this.clearFxNodes()
    const pop = el('div', 'dmg-pop')
    const chip = add(pop, 'div', 'dmg-chip', '0')
    add(pop, 'div', 'dmg-x', '×')
    const hv = add(pop, 'div', 'dmg-heat', heat.toFixed(2))
    this.viewport.appendChild(pop)
    this.fxNodes.push(pop)

    await tween(
      dur(220, speed),
      (t) => {
        chip.textContent = fmtInt(dmg * t)
        const sc = (1.4 - 0.4 * t).toFixed(3)
        chip.style.transform = `translateX(${(-26 * (1 - t)).toFixed(1)}px) scale(${sc})`
        hv.style.transform = `translateX(${(26 * (1 - t)).toFixed(1)}px) scale(${sc})`
        pop.style.opacity = String(clamp(t * 4, 0, 1))
      },
      easeOut,
    )

    pop.remove()
    const tot = el('div', 'dmg-total', '0')
    this.viewport.appendChild(tot)
    this.fxNodes.push(tot)
    await tween(
      dur(160, speed),
      (t) => {
        tot.textContent = fmtInt(total * t)
        const sc = t < 0.6 ? 0.6 + (1.15 - 0.6) * (t / 0.6) : 1.15 - 0.15 * ((t - 0.6) / 0.4)
        tot.style.transform = `translate(-50%,-50%) scale(${sc.toFixed(3)})`
      },
      easeOut,
    )

    // 잔상은 기다리지 않는다 (다음 발이 이미 시작한다)
    void tween(
      dur(260, speed),
      (t) => {
        tot.style.opacity = String(1 - t)
        tot.style.transform = `translate(-50%,-52%) scale(${(1 - 0.08 * t).toFixed(3)})`
      },
      linear,
    ).then(() => tot.remove())
  }

  /** 처치/즉사 배너 */
  showBanner(main: string, sub?: string): void {
    const box = el('div')
    box.style.cssText =
      'position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);text-align:center;pointer-events:none;'
    const t = add(box, 'div', 'dmg-total', main)
    t.style.position = 'static'
    t.style.transform = 'none'
    t.style.fontSize = '30px'
    t.style.letterSpacing = '.08em'
    if (sub !== undefined) {
      const s = add(box, 'div', undefined, sub)
      s.style.cssText =
        'font-size:12px;color:var(--text-dim);margin-top:6px;text-shadow:0 2px 8px #000;'
    }
    this.viewport.appendChild(box)
    this.fxNodes.push(box)
    void tween(
      dur(320, this.fxSpeed),
      (t2) => {
        box.style.opacity = String(clamp(t2 * 2, 0, 1))
        box.style.transform = `translate(-50%,-50%) scale(${(0.9 + 0.1 * t2).toFixed(3)})`
      },
      easeOutBack,
    )
  }

  private clearFxNodes(): void {
    for (const n of this.fxNodes) n.remove()
    this.fxNodes.length = 0
  }

  /** 소모된 탄: 슬롯 소등 + 탄피 배출 */
  markMagSlotSpent(index: number): void {
    const sl = this.slotEls[index]
    if (sl === undefined) return
    sl.style.borderColor = 'var(--line)'
    sl.style.opacity = '.42'
    const card = sl.firstElementChild
    if (card instanceof HTMLElement) card.style.filter = 'grayscale(1) brightness(.6)'
    this.spawnShell(sl)
  }

  /** 미소모(M3 탐식의 성궤): 금색으로 번쩍이고 남는다 */
  markMagSlotKept(index: number): void {
    const sl = this.slotEls[index]
    if (sl === undefined) return
    sl.style.borderColor = 'var(--brass)'
    void tween(
      dur(420, this.fxSpeed),
      (t) => {
        const a = Math.sin(Math.PI * t)
        sl.style.boxShadow = `0 0 ${(16 * a).toFixed(1)}px rgba(200,164,77,${(0.9 * a).toFixed(3)})`
      },
      linear,
    ).then(() => {
      sl.style.boxShadow = ''
    })
  }

  /** 탄피 1개. Points 파티클이 아니라 DOM 이지만 발당 1개라 예산에 영향 없다. */
  private spawnShell(from: HTMLElement): void {
    const r = from.getBoundingClientRect()
    const sh = el('div')
    const x0 = r.left + r.width * 0.5
    const y0 = r.top + r.height * 0.35
    sh.style.cssText =
      'position:fixed;width:3px;height:8px;border-radius:1px;z-index:40;pointer-events:none;' +
      'background:linear-gradient(180deg,#e6c877,#8a7133);'
    sh.style.left = x0.toFixed(1) + 'px'
    sh.style.top = y0.toFixed(1) + 'px'
    this.root.appendChild(sh)
    const dx = fxRange(26, 54)
    const rot = fxRange(220, 520) * (fxSigned() < 0 ? -1 : 1)
    const up = fxRange(16, 30)
    void tween(
      dur(420, this.fxSpeed),
      (t) => {
        const y = -up * Math.sin(Math.PI * Math.min(1, t * 0.9)) + 70 * t * t
        sh.style.transform = `translate(${(dx * t).toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(rot * t).toFixed(0)}deg)`
        sh.style.opacity = String(1 - clamp((t - 0.6) / 0.4, 0, 1))
      },
      linear,
    ).then(() => sh.remove())
  }

  // =========================================================================
  // 연출 보조 (FireSequence 가 부른다)
  // =========================================================================

  /** 장전: 트레이 카드가 슬롯으로 빨려 들어간다 (스태거 60ms, ease-out-back) */
  async animateLoadStagger(speed: number): Promise<void> {
    const jobs: Promise<void>[] = []
    for (let i = 0; i < this.plan.length; i += 1) {
      const sl = this.slotEls[i]
      const a = this.plan[i]
      if (sl === undefined || a === undefined) continue
      const card = sl.firstElementChild
      if (!(card instanceof HTMLElement)) continue
      const src = this.trayCards.get(a.uid)
      let dx = 0
      let dy = 52
      if (src !== undefined) {
        const r1 = src.getBoundingClientRect()
        const r2 = sl.getBoundingClientRect()
        dx = r1.left + r1.width / 2 - (r2.left + r2.width / 2)
        dy = r1.top + r1.height / 2 - (r2.top + r2.height / 2)
      }
      card.style.opacity = '0'
      jobs.push(
        (async () => {
          await wait(60 * i, speed)
          card.style.opacity = '1'
          await tween(
            dur(240, speed),
            (t) => {
              const k = 1 - t
              card.style.transform = `translate(${(dx * k).toFixed(1)}px,${(dy * k).toFixed(1)}px) scale(${(1 + 0.2 * k).toFixed(3)})`
            },
            easeOutBack,
          )
          card.style.transform = ''
        })(),
      )
    }
    await Promise.all(jobs)
  }

  /** 탄창 삽입 반동: 조작부가 8px 내려갔다 돌아온다 */
  async nudgeControls(speed: number): Promise<void> {
    const targets =
      this.wide === true ? [this.side] : [this.magRow, this.trayRow, this.actRow]
    await tween(
      dur(180, speed),
      (t) => {
        const k = Math.sin(Math.PI * t)
        const v = `translateY(${(8 * k).toFixed(2)}px)`
        for (const el2 of targets) el2.style.transform = v
      },
      linear,
    )
    for (const el2 of targets) el2.style.transform = ''
  }

  /** 트레이 재보충: 카드가 아래에서 스태거로 올라온다 */
  async animateTrayRefill(speed: number): Promise<void> {
    const cards = Array.from(this.trayCards.values())
    const jobs: Promise<void>[] = []
    for (let i = 0; i < cards.length; i += 1) {
      const c = cards[i]
      c.style.opacity = '0'
      jobs.push(
        (async () => {
          await wait(28 * i, speed)
          await tween(
            dur(260, speed),
            (t) => {
              c.style.opacity = String(t)
              c.style.transform = `translateY(${(18 * (1 - t)).toFixed(1)}px)`
            },
            easeOut,
          )
          c.style.transform = ''
          c.style.opacity = ''
        })(),
      )
    }
    await Promise.all(jobs)
  }

  /** 냉각 자켓 이월: 파란 플래시로 "여기서 멈춘다"를 강조 */
  flashHeatCarry(): void {
    const row = this.heatRow
    void tween(
      dur(420, this.fxSpeed),
      (t) => {
        const a = Math.sin(Math.PI * t)
        row.style.boxShadow = `inset 0 0 ${(24 * a).toFixed(1)}px rgba(90,170,255,${(0.55 * a).toFixed(3)})`
      },
      linear,
    ).then(() => {
      row.style.boxShadow = ''
    })
  }

  // =========================================================================
  // 입력
  // =========================================================================

  private beginPress(kind: PressKind, uid: string, index: number, e: PointerEvent): void {
    this.cancelPress()
    const timer = window.setTimeout(() => this.onLongPress(), LONG_MS)
    this.timers.add(timer)
    this.press = {
      kind,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      uid,
      index,
      moved: false,
      dragging: false,
      long: false,
      timer,
    }
  }

  private cancelPress(): void {
    const p = this.press
    if (p === null) return
    window.clearTimeout(p.timer)
    this.timers.delete(p.timer)
    if (p.dragging) this.renderMag()
    try {
      if (this.magSlots.hasPointerCapture(p.pointerId)) {
        this.magSlots.releasePointerCapture(p.pointerId)
      }
    } catch {
      // 이미 사라진 포인터
    }
    this.press = null
  }

  private onTrayDown(e: PointerEvent): void {
    if (this.busy || this.state === null) return
    const card = closestFrom(e, '.card')
    if (card === null) return
    const uid = card.dataset['uid']
    if (uid === undefined) return
    this.beginPress('tray', uid, -1, e)
  }

  private onMagDown(e: PointerEvent): void {
    if (this.busy || this.state === null) return
    const idx = this.slotIndexAt(e.clientX)
    if (idx < 0 || idx >= this.plan.length) return
    this.beginPress('mag', this.plan[idx].uid, idx, e)
    try {
      this.magSlots.setPointerCapture(e.pointerId)
    } catch {
      // 캡처 실패해도 window 리스너로 계속 추적한다
    }
  }

  private onHudDown(e: PointerEvent): void {
    if (this.busy) return
    const chip = closestFrom(e, '.passive-chip')
    if (chip !== null) {
      this.showPassiveInfo()
      return
    }
    this.beginPress('hud', '', -1, e)
  }

  private onMove(e: PointerEvent): void {
    const p = this.press
    if (p === null || p.pointerId !== e.pointerId) return
    const dx = e.clientX - p.x0
    const dy = e.clientY - p.y0
    if (!p.moved && Math.hypot(dx, dy) > DRAG_PX) {
      p.moved = true
      window.clearTimeout(p.timer)
      this.timers.delete(p.timer)
      if (p.kind === 'mag' && !p.long) p.dragging = true
      if (p.kind === 'hud' && dy > 24) {
        // 아래로 스와이프 = 장비 오버레이
        this.cancelPress()
        this.cb.onOpenLoadout()
        return
      }
    }
    if (p.dragging) this.dragTo(e.clientX)
  }

  private onUp(e: PointerEvent): void {
    const p = this.press
    if (p === null || p.pointerId !== e.pointerId) return
    window.clearTimeout(p.timer)
    this.timers.delete(p.timer)
    try {
      if (this.magSlots.hasPointerCapture(p.pointerId)) {
        this.magSlots.releasePointerCapture(p.pointerId)
      }
    } catch {
      // 무시
    }
    this.press = null

    if (p.dragging) {
      this.renderMag()
      this.updatePreview()
      return
    }
    if (p.long || p.moved) return

    if (p.kind === 'tray') {
      if (this.plan.some((a) => a.uid === p.uid)) this.unloadUid(p.uid)
      else this.load(p.uid)
    } else if (p.kind === 'mag') {
      this.unloadAt(p.index)
    } else {
      this.cb.onOpenLoadout()
    }
  }

  private onLongPress(): void {
    const p = this.press
    if (p === null) return
    this.timers.delete(p.timer)
    p.long = true
    if (p.kind === 'hud') {
      this.cb.onOpenLoadout()
      return
    }
    const a = this.findAmmo(p.uid)
    if (a !== null) void this.showAmmoInfo(a)
  }

  private findAmmo(uid: string): Ammo | null {
    const s = this.state
    if (s === null) return null
    for (const a of s.tray) if (a.uid === uid) return a
    for (const a of s.reserve) if (a.uid === uid) return a
    for (const a of this.plan) if (a.uid === uid) return a
    return null
  }

  /** 슬롯 사이 간격(5px)에서도 탭이 먹도록 "가장 가까운 슬롯"으로 판정한다 */
  private slotIndexAt(clientX: number, maxDist = 30): number {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < this.slotEls.length; i += 1) {
      const r = this.slotEls[i].getBoundingClientRect()
      const d = Math.abs(clientX - (r.left + r.width / 2))
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return bestD <= maxDist ? best : -1
  }

  /** 드래그 중: 계획 배열을 실제로 옮기고 나머지 슬롯을 즉시 다시 그린다 */
  private dragTo(clientX: number): void {
    const p = this.press
    if (p === null) return
    const n = this.plan.length
    let to = 0
    for (let i = 0; i < n; i += 1) {
      const r = this.slotEls[i].getBoundingClientRect()
      if (clientX > r.left + r.width / 2) to = i
      else break
    }
    to = clamp(to, 0, n - 1)
    if (to !== p.index) {
      const moved = this.plan.splice(p.index, 1)
      if (moved.length > 0) {
        this.plan.splice(to, 0, moved[0])
        p.index = to
        this.renderMag()
        this.updatePreview()
      }
    }
    const sl = this.slotEls[p.index]
    if (sl === undefined) return
    const r = sl.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    sl.style.transform = `translateX(${dx.toFixed(1)}px) scale(1.1)`
    sl.style.zIndex = '6'
  }

  // =========================================================================
  // 조작 결과
  // =========================================================================

  private load(uid: string): void {
    const s = this.state
    if (s === null) return
    if (this.plan.length >= s.cap) {
      toast(`탄창이 가득 찼다 (${s.cap}발)`)
      return
    }
    const a = s.tray.find((x) => x.uid === uid) ?? s.reserve.find((x) => x.uid === uid)
    if (a === undefined) return
    if (this.plan.some((x) => x.uid === uid)) return
    this.plan.push(a)
    this.afterPlanChange()
  }

  private unloadAt(index: number): void {
    if (index < 0 || index >= this.plan.length) return
    this.plan.splice(index, 1)
    this.afterPlanChange()
  }

  private unloadUid(uid: string): void {
    const i = this.plan.findIndex((a) => a.uid === uid)
    this.unloadAt(i)
  }

  private afterPlanChange(): void {
    this.renderMag()
    this.syncTraySelection()
    this.updatePreview()
    this.updateButtons()
  }

  private async showAmmoInfo(a: Ammo): Promise<void> {
    const st = ammoStats(a)
    const rows: Array<[string, string]> = [
      ['기본 피해(칩)', String(st.dmg)],
      ['온도 획득', '+' + st.heat.toFixed(2)],
    ]
    if (st.knockback > 0) rows.push(['넉백', '+' + st.knockback.toFixed(1) + 'm'])
    if (st.nextDmgBonus > 0) rows.push(['다음 탄 피해', '+' + st.nextDmgBonus])
    const s = this.state
    if (s !== null) rows.push(['현재 온도 기준 피해', fmtInt(Math.round(st.dmg * s.heat))])
    await infoPop({
      title: ammoLabel(a),
      accent: typeColor(a.type),
      lines: [TYPE_TEXT[a.type]],
      rows,
      host: this.host,
    })
  }

  private showPassiveInfo(): void {
    const s = this.state
    if (s === null || s.enemy.passive === null) return
    void infoPop({
      title: s.enemy.passive.name,
      lines: [s.enemy.passive.text],
      rows: [
        ['적', s.enemy.label],
        ['접근 속도', fmtMeters(s.enemy.speed) + '/행동'],
      ],
      host: this.host,
    })
  }

  private async onFireClick(): Promise<void> {
    const s = this.state
    if (s === null || this.busy || this.plan.length === 0) return
    if (this.plan.length < s.cap) {
      const ok = await confirmPop({
        title: '탄창이 덜 찼다',
        body: `${s.cap}발 중 ${this.plan.length}발만 장전했다. 그대로 사격할까?`,
        ok: '사격',
        cancel: '취소',
        host: this.host,
      })
      if (!ok) return
      // 다이얼로그를 여는 동안 상태가 바뀌었을 수 있다
      if (this.busy || this.state !== s || this.plan.length === 0) return
    }
    this.cb.onFire(this.plan.slice())
  }

  private onEjectClick(): void {
    const s = this.state
    if (s === null || this.busy || this.plan.length === 0) return
    const limit = maxEject(s)
    const picked = this.plan.slice(0, limit)
    if (this.plan.length > limit) toast(`한 번에 ${limit}발까지만 배출된다`)
    this.cb.onEject(picked.map((a) => a.uid))
  }

  // =========================================================================
  // 정리
  // =========================================================================

  destroy(): void {
    this.cancelPress()
    this.bin.clear()
    for (const id of this.timers) window.clearTimeout(id)
    this.timers.clear()
    killTweens()
    closePopover()
    this.clearFxNodes()
    this.root.remove()
    this.state = null
    this.plan = []
    this.trayCards.clear()
    this.slotEls = []
  }
}

/** 탄종 한 줄 설명 (팝오버용) */
const TYPE_TEXT: Record<Ammo['type'], string> = {
  AP: '철갑탄 — 피해는 최고, 온도는 거의 오르지 않는다. 마무리용.',
  INC: '소이탄 — 피해는 낮지만 온도를 크게 올린다. 앞쪽에 둘수록 이득.',
  HE: '고폭탄 — 균형형. 폭발 반동으로 거리를 되사온다.',
  SANC: '축성탄 — 다음 탄의 피해를 올린다. 모든 탄종을 겸한다(성별 거부 제외).',
}

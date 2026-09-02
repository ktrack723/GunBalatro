// ============================================================================
// 전투 화면 (v2)
//   구성: 적 HP / 3D 뷰포트 / 거리 / 온도(가장 큰 숫자) / 탄창 슬롯+예상피해
//         / 탄 선택(기본탄 무한 + 보유 특수탄) / ★부착물 랙 / 사격 버튼
//
//   부착물 랙은 화면에서 사라지지 않는다 — v2 에서 빌드는 부착물이 전부이므로
//   "지금 내 총이 무엇인가"가 항상 보여야 한다. 사격 전이면 탭해서 교체할 수 있다.
// ============================================================================
import type { Attachment, CombatState, Round, SlotKind } from '../core/types'
import { BASIC_DMG, BASIC_HEAT, SLOT_LABEL } from '../core/types'
import { SPECIAL_BY_ID } from '../core/data/specials'
import { basicRound, makeRound, previewDamage, swapAttachment } from '../core/combat'
import { add, Bin, clamp, clear, el, fmtInt, on, orderMark, setClass } from './dom'
import { popover } from './popover'

const HEAT_TIERS = [
  { at: 0, color: '#8d949c', name: '냉각' },
  { at: 3, color: '#e0682a', name: '가열' },
  { at: 8, color: '#ff8b1e', name: '적열' },
  { at: 16, color: '#ffc44d', name: '백열' },
  { at: 30, color: '#fff6e0', name: '성화' },
]

export function heatColor(heat: number): string {
  let c = HEAT_TIERS[0].color
  for (const t of HEAT_TIERS) if (heat >= t.at) c = t.color
  return c
}

/** 온도 게이지는 로그 스케일 — 1~60 이 한 바에 들어가야 한다 */
function heatFrac(heat: number): number {
  return clamp(Math.log(Math.max(1, heat)) / Math.log(60), 0, 1)
}

export interface CombatViewCallbacks {
  onFire(plan: Round[]): void
  onOpenRack(slot: SlotKind, railIndex?: number): void
}

export class CombatView {
  private readonly host: HTMLElement
  private readonly cb: CombatViewCallbacks
  private readonly bin = new Bin()
  private root!: HTMLElement

  private hpFill!: HTMLElement
  private hpNum!: HTMLElement
  private enemyName!: HTMLElement
  private passiveBox!: HTMLElement
  private viewport!: HTMLElement
  private procRail!: HTMLElement
  private distNum!: HTMLElement
  private distFill!: HTMLElement
  private distTrack!: HTMLElement
  private distCost!: HTMLElement
  private heatNum!: HTMLElement
  private heatFill!: HTMLElement
  private magSlots!: HTMLElement
  private previewNum!: HTMLElement
  private ammoRow!: HTMLElement
  private rackRow!: HTMLElement
  private fireBtn!: HTMLButtonElement

  private s: CombatState | null = null
  private plan: Round[] = []
  private busy = false
  private fxNodes: HTMLElement[] = []

  constructor(host: HTMLElement, cb: CombatViewCallbacks) {
    this.host = host
    this.cb = cb
    this.build()
  }

  // -------------------------------------------------------------------------
  private build(): void {
    clear(this.host)
    const root = add(this.host, 'div', 'combat-root')
    this.root = root

    // --- 적 ---
    const top = add(root, 'div', 'hud-top')
    const row = add(top, 'div', 'hud-top-row')
    this.enemyName = add(row, 'span', 'enemy-name', '—')
    this.passiveBox = add(row, 'span')
    this.hpNum = add(row, 'span', 'enemy-hp-num', '')
    const bar = add(top, 'div', 'hpbar')
    this.hpFill = add(bar, 'div', 'hpbar-fill')

    // --- 3D 가 비치는 영역 ---
    this.viewport = add(root, 'div', 'viewport-space')
    this.procRail = add(this.viewport, 'div', 'proc-rail')

    // --- 거리 ---
    const dist = add(root, 'div', 'dist-row')
    this.distNum = add(dist, 'span', 'dist-num', '—')
    this.distTrack = add(dist, 'div', 'dist-track')
    this.distFill = add(this.distTrack, 'div', 'dist-fill')
    this.distCost = add(dist, 'span', 'dist-cost', '')

    // --- 온도 (가장 큰 숫자) ---
    const heat = add(root, 'div', 'heat-row')
    add(heat, 'span', 'heat-label', '온도')
    add(heat, 'span', 'heat-x', '×')
    this.heatNum = add(heat, 'span', 'heat-num', '1.00')
    const ht = add(heat, 'div', 'heat-track')
    this.heatFill = add(ht, 'div', 'heat-fill')
    for (const t of [3, 8, 16, 30]) {
      const tick = add(ht, 'div', 'heat-tick')
      tick.style.left = (heatFrac(t) * 100).toFixed(1) + '%'
    }

    // --- 탄창 ---
    const mag = add(root, 'div', 'mag-row')
    this.magSlots = add(mag, 'div', 'mag-slots')
    const pv = add(mag, 'div', 'mag-preview')
    add(pv, 'div', 'mag-preview-label', '예상 피해')
    this.previewNum = add(pv, 'div', 'mag-preview-num', '—')

    // --- 탄 선택 ---
    this.ammoRow = add(root, 'div', 'ammo-row')

    // --- 부착물 랙 ---
    this.rackRow = add(root, 'div', 'rack-row')

    // --- 액션 ---
    const act = add(root, 'div', 'act-row')
    this.fireBtn = add(act, 'button', 'btn primary') as HTMLButtonElement
    add(this.fireBtn, 'span', undefined, '사 격')
    const sub = add(this.fireBtn, 'small', undefined, '')
    this.bin.add(
      on(this.fireBtn, 'click', () => {
        if (this.busy || this.s === null) return
        if (this.plan.length === 0) return
        void this.confirmAndFire(sub)
      }),
    )
  }

  private async confirmAndFire(_sub: HTMLElement): Promise<void> {
    const s = this.s
    if (s === null) return
    if (this.plan.length < s.cap) {
      const ok = await popover({
        title: '탄창이 비었다',
        lines: [this.plan.length + '/' + s.cap + '발만 장전했다. 그대로 쏠까?'],
        actions: [
          { id: 'no', label: '되돌아가기' },
          { id: 'yes', label: '그대로 사격', kind: 'primary' },
        ],
      })
      if (ok !== 'yes') return
    }
    const plan = this.plan.slice()
    this.plan = []
    this.cb.onFire(plan)
  }

  // -------------------------------------------------------------------------
  render(s: CombatState): void {
    this.s = s
    this.plan = this.plan.filter((r) => this.stillAvailable(s, r))
    this.renderEnemy(s)
    this.setDistance(s.distance, s.enemy.startDist, s.fireCost)
    this.setHeat(s.heat)
    this.renderMag(s)
    this.renderAmmo(s)
    this.renderRack(s)
  }

  private stillAvailable(s: CombatState, r: Round): boolean {
    if (r.special === null) return true
    const used = this.plan.filter((x) => x.special === r.special).length
    return (s.specials[r.special] ?? 0) >= used
  }

  private renderEnemy(s: CombatState): void {
    const e = s.enemy
    this.enemyName.textContent = e.label
    clear(this.passiveBox)
    if (e.passive !== null) {
      const chip = add(this.passiveBox, 'span', 'passive-chip', e.passive.name)
      this.bin.add(
        on(chip, 'click', () => {
          void popover({ title: e.passive?.name ?? '', lines: [e.passive?.text ?? ''] })
        }),
      )
    }
    this.setEnemyHp(e.hp, e.maxHp)
  }

  setEnemyHp(hp: number, max: number): void {
    const v = clamp(hp / Math.max(1, max), 0, 1)
    this.hpFill.style.width = (v * 100).toFixed(2) + '%'
    this.hpNum.textContent = fmtInt(Math.max(0, hp)) + ' / ' + fmtInt(max)
  }

  setDistance(d: number, start: number, cost: number): void {
    const v = clamp(d / Math.max(1, start), 0, 1)
    this.distNum.textContent = d.toFixed(d % 1 === 0 ? 0 : 1) + 'm'
    this.distFill.style.width = (v * 100).toFixed(2) + '%'
    setClass(this.distTrack, 'warn', v <= 0.4 && v > 0.2)
    setClass(this.distTrack, 'danger', v <= 0.2)
    this.distCost.textContent = '▶ ' + cost + 'm/사격'
  }

  setHeat(heat: number): void {
    this.heatNum.textContent = heat.toFixed(2)
    const c = heatColor(heat)
    this.heatNum.style.color = c
    this.heatNum.style.textShadow = heat >= 8 ? '0 0 18px ' + c + '99' : 'none'
    this.heatFill.style.width = (heatFrac(heat) * 100).toFixed(1) + '%'
    this.heatFill.style.background = 'linear-gradient(90deg,#5a2a10,' + c + ')'
    this.heatNum.classList.add('bump')
    window.setTimeout(() => this.heatNum.classList.remove('bump'), 130)
  }

  // --- 탄창 슬롯 -----------------------------------------------------------
  private renderMag(s: CombatState): void {
    clear(this.magSlots)
    for (let i = 0; i < s.cap; i += 1) {
      const r = this.plan[i]
      const slot = add(this.magSlots, 'div', 'mag-slot')
      if (r === undefined) {
        add(slot, 'span', undefined, String(i + 1))
        continue
      }
      slot.classList.add('filled')
      const def = r.special === null ? null : SPECIAL_BY_ID[r.special]
      const color = def?.color ?? '#8f9aa6'
      slot.style.setProperty('--c', color)
      slot.style.borderColor = color
      add(slot, 'div', 'card-type', def === null ? '기본' : def.name.slice(0, 3))
      add(slot, 'div', 'card-dmg', String(def?.dmg ?? BASIC_DMG))
      const badge = add(slot, 'div', 'card-order', orderMark(i + 1))
      badge.style.color = color
      this.bin.add(
        on(slot, 'click', () => {
          if (this.busy) return
          this.plan.splice(i, 1)
          this.refreshPlan()
        }),
      )
    }
    this.updatePreview()
  }

  private updatePreview(): void {
    const s = this.s
    if (s === null) return
    if (this.plan.length === 0) {
      this.previewNum.textContent = '—'
      this.previewNum.classList.remove('lethal')
      this.fireBtn.disabled = true
      return
    }
    const { expected, approximate } = previewDamage(s, this.plan)
    this.previewNum.textContent = (approximate ? '~' : '') + fmtInt(expected)
    setClass(this.previewNum, 'lethal', expected >= s.enemy.hp)
    this.fireBtn.disabled = this.busy
    const sub = this.fireBtn.querySelector('small')
    if (sub !== null) {
      sub.textContent = '−' + s.fireCost + 'm · ' + this.plan.length + '/' + s.cap + '발'
    }
  }

  private refreshPlan(): void {
    const s = this.s
    if (s === null) return
    this.renderMag(s)
    this.renderAmmo(s)
  }

  // --- 탄 선택 -------------------------------------------------------------
  private renderAmmo(s: CombatState): void {
    clear(this.ammoRow)

    // 기본탄 — 무한
    const basic = add(this.ammoRow, 'div', 'ammo-card basic')
    basic.style.setProperty('--c', '#8f9aa6')
    add(basic, 'div', 'ammo-name', '기본탄')
    add(basic, 'div', 'ammo-stat', BASIC_DMG + ' · ' + BASIC_HEAT.toFixed(2))
    add(basic, 'div', 'ammo-count', '∞')
    this.bin.add(on(basic, 'click', () => this.push(basicRound())))
    this.bin.add(
      on(basic, 'contextmenu', (e) => {
        e.preventDefault()
        void popover({ title: '기본탄', lines: ['수량 무한. 자체 효과는 없고 부착물 수치만 얹힌다.'] })
      }),
    )

    // 보유 특수탄
    const ids = Object.keys(s.specials).filter((k) => (s.specials[k] ?? 0) > 0)
    ids.sort()
    for (const id of ids) {
      const def = SPECIAL_BY_ID[id]
      if (def === undefined) continue
      const left = (s.specials[id] ?? 0) - this.plan.filter((r) => r.special === id).length
      const card = add(this.ammoRow, 'div', 'ammo-card')
      card.style.setProperty('--c', def.color)
      add(card, 'div', 'ammo-name', def.name)
      add(card, 'div', 'ammo-stat', def.dmg + ' · ' + def.heat.toFixed(1))
      add(card, 'div', 'ammo-count', String(left))
      setClass(card, 'out', left <= 0)
      this.bin.add(
        on(card, 'click', () => {
          if (left <= 0) return
          this.push(makeRound(id))
        }),
      )
      this.bin.add(
        on(card, 'contextmenu', (e) => {
          e.preventDefault()
          void popover({
            title: def.name,
            accent: def.color,
            lines: [def.text],
            rows: [
              ['데미지', String(def.dmg)],
              ['온도', '+' + def.heat.toFixed(2)],
              ['보유', String(s.specials[id] ?? 0) + '발'],
            ],
          })
        }),
      )
    }
  }

  private push(r: Round): void {
    const s = this.s
    if (s === null || this.busy) return
    if (this.plan.length >= s.cap) return
    this.plan.push(r)
    this.refreshPlan()
  }

  // --- ★ 부착물 랙 ---------------------------------------------------------
  private renderRack(s: CombatState): void {
    clear(this.rackRow)
    const l = s.loadout
    const entries: Array<{ slot: SlotKind; att: Attachment | null; railIndex?: number }> = [
      { slot: 'barrel', att: l.barrel },
      { slot: 'handguard', att: l.handguard },
      { slot: 'optic', att: l.optic },
      { slot: 'stock', att: l.stock },
      { slot: 'magazine', att: l.magazine },
    ]
    l.rails.forEach((r, i) => entries.push({ slot: 'rail', att: r, railIndex: i }))

    for (const e of entries) {
      const box = add(this.rackRow, 'div', 'rack-slot')
      box.dataset['att'] = e.att?.id ?? ''
      add(box, 'div', 'rack-kind', SLOT_LABEL[e.slot])
      add(box, 'div', 'rack-name', e.att?.name ?? '비어 있음')
      if (e.att === null) box.classList.add('empty')
      else box.classList.add('r-' + e.att.rarity)
      this.bin.add(
        on(box, 'click', () => {
          if (this.busy) return
          this.cb.onOpenRack(e.slot, e.railIndex)
        }),
      )
    }
  }

  /** 부착물이 발동했다 — 랙에서 그 칸을 번쩍인다 (연출) */
  flashRack(id: string): void {
    const box = this.rackRow.querySelector<HTMLElement>('[data-att="' + id + '"]')
    if (box === null) return
    box.classList.add('proc')
    window.setTimeout(() => box.classList.remove('proc'), 320)
  }

  showProc(name: string): void {
    const chip = add(this.procRail, 'div', 'proc-chip', name)
    this.fxNodes.push(chip)
    window.setTimeout(() => chip.remove(), 900)
  }

  setBusy(b: boolean): void {
    this.busy = b
    this.fireBtn.disabled = b || this.plan.length === 0
    setClass(this.root, 'busy', b)
  }

  get viewportEl(): HTMLElement {
    return this.viewport
  }

  clearFx(): void {
    for (const n of this.fxNodes) n.remove()
    this.fxNodes = []
  }

  destroy(): void {
    this.bin.clear()
    this.clearFx()
    clear(this.host)
  }
}

/** 부착물 교체 시트 — 전투 중 사격 전에 호출된다 */
export async function showSwapSheet(
  host: HTMLElement,
  s: CombatState,
  slot: SlotKind,
  railIndex?: number,
): Promise<boolean> {
  const l = s.loadout
  const current = slot === 'rail' ? (l.rails[railIndex ?? 0] ?? null) : l[slot as 'barrel']
  const options = l.stash.filter((a) => a.slot === slot)

  const screen = el('div', 'screen')
  host.appendChild(screen)
  add(screen, 'h1', undefined, SLOT_LABEL[slot])
  add(
    screen,
    'p',
    undefined,
    current === null ? '비어 있다.' : '현재: ' + current.name + ' — ' + current.text,
  )
  add(screen, 'div', 'swap-hint', '사격 전이면 언제든 바꿀 수 있다. 벗은 것은 보관함으로 간다.')

  const list = add(screen, 'div', 'swap-list')
  let changed = false

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      screen.remove()
      resolve()
    }
    if (options.length === 0) {
      add(list, 'p', undefined, '보관함에 이 부위의 부착물이 없다.')
    }
    for (const a of options) {
      const pick = add(list, 'div', 'pick')
      const icon = add(pick, 'div', 'pick-icon')
      add(icon, 'div', 'rack-kind', SLOT_LABEL[a.slot])
      const body = add(pick, 'div', 'pick-body')
      add(body, 'div', 'pick-name', a.name)
      add(body, 'div', 'pick-text', a.text)
      const meta = add(body, 'div', 'pick-meta')
      add(meta, 'span', 'rar ' + a.rarity, a.rarity)
      pick.addEventListener('click', () => {
        if (swapAttachment(s, a.id, railIndex)) changed = true
        finish()
      })
    }
    add(screen, 'div', 'spacer')
    const close = add(screen, 'button', 'btn ghost', '닫기')
    close.addEventListener('click', finish)
  })

  return changed
}

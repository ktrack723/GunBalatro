// ============================================================================
// 전투 화면 (v2)
//   구성: 적 HP / 3D 뷰포트 / 거리 / 온도(가장 큰 숫자) / 탄창 슬롯+예상피해
//         / 탄 선택(기본탄 무한 + 보유 특수탄) / ★부착물 랙 / 사격 버튼
//
//   부착물 랙은 화면에서 사라지지 않는다 — v2 에서 빌드는 부착물이 전부이므로
//   "지금 내 총이 무엇인가"가 항상 보여야 한다. 사격 전이면 탭해서 교체할 수 있다.
// ============================================================================
import type { Attachment, CombatState, Round, SlotKind } from '../core/types'
import { BASIC_DMG, BASIC_HEAT, RAIL_ACCEPTS, RARITY_LABEL, SLOT_LABEL } from '../core/types'
import { SPECIAL_BY_ID } from '../core/data/specials'
import { basicRound, makeRound, swapAttachment } from '../core/combat'
import { computeHeatCarry } from '../core/pipeline'
import { add, Bin, clamp, clear, el, fmtInt, longPress, on, orderMark, setClass } from './dom'
import { popover } from './popover'
import { sfx } from '../audio/Sfx'

/** 등급을 글자로 — 색만으로 구분하면 색각 이상에서 정보가 통째로 사라진다 */
export const RARITY_KO: Record<string, string> = RARITY_LABEL

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

/**
 * 탄 설명 팝오버. 탄 선택 줄과 장전된 탄창 슬롯이 같은 내용을 보여준다 —
 * 같은 것을 두 군데서 다르게 설명하면 그게 더 헷갈린다.
 */
function showRoundInfo(id: string | null, own?: number): void {
  if (id === null) {
    void popover({
      title: '기본탄',
      lines: ['수량 무한. 자체 효과는 없고 부착물이 얹어주는 수치만 갖는다.'],
      rows: [
        ['데미지', String(BASIC_DMG)],
        ['온도', '+' + BASIC_HEAT.toFixed(2)],
        ['보유', '무한'],
      ],
    })
    return
  }
  const def = SPECIAL_BY_ID[id]
  if (def === undefined) return
  void popover({
    title: def.name,
    accent: def.color,
    lines: [def.text, '같은 탄을 한 탄창에 겹치면 자기 값이 준다 — 2번째 68%, 3번째부터 45%.'],
    rows: [
      ['데미지', String(def.dmg)],
      ['온도', '+' + def.heat.toFixed(2)],
      ...(own === undefined ? [] : ([['보유', String(own) + '발']] as Array<[string, string]>)),
    ],
  })
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
  private carryLabel!: HTMLElement
  private magSlots!: HTMLElement
  private previewNum!: HTMLElement
  private ammoRow!: HTMLElement
  private rackRow!: HTMLElement
  private fireBtn!: HTMLButtonElement

  private s: CombatState | null = null
  private plan: Round[] = []
  private busy = false
  private lastHeat = 1
  /** 탄 카드의 잔량 표시 노드 — 탭마다 전체를 다시 그리지 않고 숫자만 고친다 */
  private countNodes = new Map<string, HTMLElement>()
  private fxNodes: HTMLElement[] = []

  constructor(host: HTMLElement, cb: CombatViewCallbacks) {
    this.host = host
    this.cb = cb
    this.build()
  }

  // -------------------------------------------------------------------------
  private build(): void {
    clear(this.host)
    // 전투 UI 는 적이 등장하고 카메라가 자세를 고쳐잡은 다음에 떠오른다 (§진입 연출)
    const root = add(this.host, 'div', 'combat-root intro')
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
    this.carryLabel = add(heat, 'span', 'heat-carry', '')
    for (const t of [3, 8, 16, 30]) {
      const tick = add(ht, 'div', 'heat-tick')
      tick.style.left = (heatFrac(t) * 100).toFixed(1) + '%'
    }

    // --- 탄창 ---
    const mag = add(root, 'div', 'mag-row')
    this.magSlots = add(mag, 'div', 'mag-slots')
    const pv = add(mag, 'div', 'mag-preview')
    add(pv, 'div', 'mag-preview-label', '장전')
    this.previewNum = add(pv, 'div', 'mag-preview-num', '0/0')

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
    sfx('confirm')
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
    this.renderCarry(s)
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

  /** 사격 사이 이월 비율을 상시 표시한다 — 이제 온도는 전투 내내 이어지는 자원이다 */
  private renderCarry(s: CombatState): void {
    // 심연 패시브는 이월 자체를 막는다 — 라벨이 50% 라고 거짓말하면 안 된다
    const noCarry = s.flags['noCarry'] === true
    const pctVal = noCarry ? 0 : Math.round(computeHeatCarry(s.loadout) * 100)
    this.carryLabel.textContent = noCarry ? '이월 0% · 심연' : '이월 ' + pctVal + '%'
    this.carryLabel.style.color = pctVal >= 65 ? 'var(--inc)' : pctVal <= 35 ? '#7fe3ff' : 'var(--text-faint)'
  }

  /** bump=false 는 연속 보간용 (냉각 연출) — 매 프레임 튀는 애니메이션을 끈다 */
  setHeat(heat: number, bump = true): void {
    const tierOf = (h: number): number => (h >= 30 ? 4 : h >= 16 ? 3 : h >= 8 ? 2 : h >= 3 ? 1 : 0)
    if (tierOf(heat) > tierOf(this.lastHeat)) sfx('heatUp')
    this.lastHeat = heat
    this.heatNum.textContent = heat.toFixed(2)
    const c = heatColor(heat)
    this.heatNum.style.color = c
    this.heatNum.style.textShadow = heat >= 8 ? '0 0 18px ' + c + '99' : 'none'
    this.heatFill.style.width = (heatFrac(heat) * 100).toFixed(1) + '%'
    this.heatFill.style.background = 'linear-gradient(90deg,#5a2a10,' + c + ')'
    if (!bump) return
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
          sfx('back')
          this.refreshPlan()
        }),
      )
      // 장전해 놓고 나서 "이게 뭐였더라" 가 제일 잦다 — 슬롯에서도 바로 볼 수 있어야 한다
      this.bin.add(longPress(slot, () => showRoundInfo(r.special, s.specials[r.special ?? ''])))
    }
    this.updatePreview()
  }

  /**
   * 예상 피해는 **보여주지 않는다.**
   * 대신 플레이어가 실제로 알아야 하는 것 — 장전 수와 다음 사격으로 넘어갈 온도 —
   * 를 띄운다. 온도가 사격 사이에 이월되므로 "지금 얼마나 남기고 끝내는가"가
   * 다음 탄창의 시작점이 된다.
   */
  private updatePreview(): void {
    const s = this.s
    if (s === null) return
    this.previewNum.textContent = this.plan.length + '/' + s.cap
    setClass(this.previewNum, 'lethal', this.plan.length >= s.cap)
    this.fireBtn.disabled = this.busy || this.plan.length === 0
    const sub = this.fireBtn.querySelector('small')
    if (sub !== null) {
      sub.textContent = '−' + s.fireCost + 'm · ' + this.plan.length + '/' + s.cap + '발'
    }
  }

  /**
   * 탭 한 번에 탄 선택 줄을 통째로 다시 그리면 DOM 이 detach 되어
   * 빠른 연타가 씹힌다. 잔량 숫자만 제자리에서 고친다.
   */
  private refreshPlan(): void {
    const s = this.s
    if (s === null) return
    this.renderMag(s)
    this.updateCounts()
  }

  private updateCounts(): void {
    for (const [id, node] of this.countNodes) {
      const left = this.remaining(id)
      node.textContent = String(left)
      const card = node.parentElement
      if (card !== null) setClass(card, 'out', left <= 0)
    }
  }

  // --- 탄 선택 -------------------------------------------------------------
  private renderAmmo(s: CombatState): void {
    clear(this.ammoRow)
    this.countNodes.clear()

    // 기본탄 — 무한
    const basic = add(this.ammoRow, 'div', 'ammo-card basic')
    basic.style.setProperty('--c', '#8f9aa6')
    add(basic, 'div', 'ammo-name', '기본탄')
    add(basic, 'div', 'ammo-stat', BASIC_DMG + ' · ' + BASIC_HEAT.toFixed(2))
    add(basic, 'div', 'ammo-count', '∞')
    this.bin.add(on(basic, 'click', () => this.push(basicRound())))
    this.bin.add(longPress(basic, () => showRoundInfo(null)))

    // 보유 특수탄
    const ids = Object.keys(s.specials).filter((k) => (s.specials[k] ?? 0) > 0)
    ids.sort()
    for (const id of ids) {
      const def = SPECIAL_BY_ID[id]
      if (def === undefined) continue
      const left = (s.specials[id] ?? 0) - this.plan.filter((r) => r.special === id).length
      const card = add(this.ammoRow, 'div', 'ammo-card r-' + def.rarity)
      card.style.setProperty('--c', def.color)
      add(card, 'div', 'ammo-name', def.name)
      add(card, 'div', 'ammo-stat', def.dmg + ' · ' + def.heat.toFixed(1))
      const cnt = add(card, 'div', 'ammo-count', String(left))
      this.countNodes.set(id, cnt)
      setClass(card, 'out', left <= 0)
      // 잔량은 **살아 있는 상태**(this.s)에서 읽는다. 여기서 렌더 시점의 s 를
      //   가둬 두면, 재고가 0 이 된 뒤에도 그때의 숫자를 보고 통과시킨다.
      this.bin.add(
        on(card, 'click', () => {
          if (this.remaining(id) <= 0) return
          this.push(makeRound(id))
        }),
      )
      this.bin.add(longPress(card, () => showRoundInfo(id, this.s?.specials[id] ?? 0)))
    }
  }

  /** 지금 이 순간 더 넣을 수 있는 발수 (보유 - 이미 계획에 넣은 수) */
  private remaining(id: string): number {
    const s = this.s
    if (s === null) return 0
    return (s.specials[id] ?? 0) - this.plan.filter((r) => r.special === id).length
  }

  private push(r: Round): void {
    const s = this.s
    if (s === null || this.busy) return
    if (this.plan.length >= s.cap) return
    // 마지막 관문 — 어느 경로로 들어왔든 없는 탄은 계획에 못 들어간다
    if (r.special !== null && this.remaining(r.special) <= 0) return
    this.plan.push(r)
    sfx('tap', 1 + this.plan.length * 0.03)
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
      // 부위·이름·등급을 전부 **글자로** 적는다. 아이콘이나 색만으로는
      // "지금 내 총이 무엇인가"가 읽히지 않는다 — 이 줄이 v2 빌드의 전부다.
      const kind = e.railIndex === undefined
        ? SLOT_LABEL[e.slot]
        : SLOT_LABEL[e.slot] + ' ' + (e.railIndex + 1)
      add(box, 'div', 'rack-kind', kind)
      add(box, 'div', 'rack-name', e.att?.name ?? '비어 있음')
      add(box, 'div', 'rack-rar', e.att === null ? '장착 없음' : RARITY_KO[e.att.rarity])
      if (e.att === null) box.classList.add('empty')
      else box.classList.add('r-' + e.att.rarity)
      this.bin.add(
        on(box, 'click', () => {
          if (this.busy) return
          this.cb.onOpenRack(e.slot, e.railIndex)
        }),
      )
      // 탭 = 교체, 꾹 = 설명. 랙이 v2 빌드의 전부이므로 여기서 효과를 못 읽으면
      // 무엇을 끼고 있는지는 알아도 그게 무슨 뜻인지는 모른다.
      const att = e.att
      this.bin.add(
        longPress(box, () => {
          if (att === null) {
            void popover({
              title: kind,
              lines: [
                e.slot === 'rail'
                  ? '비어 있다. 보조 레일은 그 자체로는 효과가 없고 광학을 하나 더 다는 자리다.'
                  : '비어 있다. 탭하면 보관함의 부착물로 채울 수 있다.',
              ],
            })
            return
          }
          void popover({
            title: att.name,
            lines: [att.text],
            rows: [
              ['부위', kind],
              ['등급', RARITY_KO[att.rarity] ?? att.rarity],
            ],
          })
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
  const isRail = slot === 'rail'
  const current = isRail ? (l.rails[railIndex ?? 0] ?? null) : l[slot as 'barrel']
  // 보조 레일 칸은 그 자체로는 아무 효과가 없다 — 광학을 하나 더 다는 자리일 뿐이다.
  const accepts: SlotKind = isRail ? RAIL_ACCEPTS : slot
  const options = l.stash.filter((a) => a.slot === accepts)

  const screen = el('div', 'screen')
  host.appendChild(screen)
  add(screen, 'h1', undefined, SLOT_LABEL[slot])
  add(
    screen,
    'p',
    undefined,
    current === null ? '비어 있다.' : '현재: ' + current.name + ' — ' + current.text,
  )
  add(
    screen,
    'div',
    'swap-hint',
    isRail
      ? '보조 레일은 그 자체로는 효과가 없다 — 광학을 하나 더 다는 자리다. 사격 전이면 언제든 바꿀 수 있다.'
      : '사격 전이면 언제든 바꿀 수 있다. 벗은 것은 보관함으로 간다.',
  )

  const list = add(screen, 'div', 'swap-list')
  let changed = false

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      screen.remove()
      resolve()
    }
    if (options.length === 0) {
      add(list, 'p', undefined, isRail ? '보관함에 여분의 광학이 없다.' : '보관함에 이 부위의 부착물이 없다.')
    }
    for (const a of options) {
      const pick = add(list, 'div', 'pick')
      const icon = add(pick, 'div', 'pick-icon')
      add(icon, 'div', 'rack-kind', SLOT_LABEL[slot])
      const body = add(pick, 'div', 'pick-body')
      add(body, 'div', 'pick-name', a.name)
      add(body, 'div', 'pick-text', a.text)
      const meta = add(body, 'div', 'pick-meta')
      add(meta, 'span', 'rar ' + a.rarity, RARITY_KO[a.rarity])
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

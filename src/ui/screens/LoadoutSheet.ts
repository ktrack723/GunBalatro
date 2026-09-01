// 부착물 시트 (읽기 전용) + **화면 공용 위젯**.
//
// 담당 파일 목록 밖에 새 파일을 만들지 않기 위해, 모든 .screen 이 공유하는 위젯
// (화면 프레임 / 버튼 / 로드아웃 스트립 / 레어도 뱃지 / 탄 아이콘)을 여기 모아 두었다.
// 다른 화면들은 전부 이 파일에서 위젯을 가져다 쓴다.

import type { Ammo, Attachment, Grade, Loadout, Rarity, RunState, SlotKind } from '../../core/types'
import { ammoStats, gradeRoman, typeColor, typeName, typeShort } from '../../core/ammoStats'
import { computeCap, computeTraySize } from '../../core/pipeline'
import { Bin, add, el, fmtInt, on } from '../dom'
import { infoPop, isPopoverOpen } from '../popover'

// ===========================================================================
// 화면 프레임
// ===========================================================================

export interface ScreenHandle {
  root: HTMLDivElement
  /** 이 화면이 만든 리스너/타이머 보관함. close() 가 전부 해제한다. */
  bin: Bin
  close(): void
}

/**
 * host 에 .screen 을 붙이고 핸들을 돌려준다.
 * 해소되면 close() 로 스스로 제거한다 (짧은 페이드 후 DOM 에서 사라진다).
 */
export function openScreen(host: HTMLElement, label: string, extraClass?: string): ScreenHandle {
  const root = el('div', extraClass !== undefined ? 'screen ' + extraClass : 'screen')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', label)
  root.tabIndex = -1
  // #app 이 touch-action:none 이라 iOS 에서 화면 내부 스크롤이 막힐 수 있다.
  // 스크롤 컨테이너인 .screen 자신에게 세로 팬을 허용해 되살린다 (TECH §4).
  root.style.touchAction = 'pan-y'
  root.style.overscrollBehavior = 'contain'
  host.appendChild(root)
  try {
    root.focus({ preventScroll: true })
  } catch {
    // 포커스 실패는 무시 (구형 사파리)
  }

  const bin = new Bin()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    bin.clear()
    root.style.animation = 'none'
    root.style.transition = 'opacity .12s linear'
    root.style.opacity = '0'
    root.style.pointerEvents = 'none'
    window.setTimeout(() => root.remove(), 140)
  }
  return { root, bin, close }
}

/** 화면 제목 + 부제 */
export function header(root: HTMLElement, title: string, sub?: string): HTMLElement {
  const h = add(root, 'h1', undefined, title)
  if (sub !== undefined) add(root, 'p', undefined, sub)
  return h
}

/** 화면 하단 버튼 줄 (가로 배치) */
export function buttonRow(parent: HTMLElement): HTMLElement {
  const row = add(parent, 'div')
  row.style.display = 'flex'
  row.style.gap = '8px'
  row.style.flexWrap = 'wrap'
  return row
}

export interface BtnOpts {
  sub?: string
  kind?: 'primary' | 'ghost' | 'brass'
  disabled?: boolean
  /** 가로 배치에서의 비중 */
  grow?: number
}

/** 44pt 이상 보장되는 .btn */
export function button(
  parent: HTMLElement,
  label: string,
  opts: BtnOpts = {},
): HTMLButtonElement {
  const b = add(parent, 'button', opts.kind !== undefined ? 'btn ' + opts.kind : 'btn')
  b.type = 'button'
  add(b, 'span', undefined, label)
  if (opts.sub !== undefined) add(b, 'small', undefined, opts.sub)
  if (opts.disabled === true) b.disabled = true
  if (opts.grow !== undefined) b.style.flex = String(opts.grow)
  return b
}

/** 얇은 구분 소제목 */
export function section(parent: HTMLElement, text: string): HTMLElement {
  const h = add(parent, 'h2', undefined, text)
  h.style.marginTop = '6px'
  return h
}

/** .stat-row 한 줄 */
export function statRow(parent: HTMLElement, k: string, v: string): HTMLElement {
  const r = add(parent, 'div', 'stat-row')
  add(r, 'span', undefined, k)
  add(r, 'span', undefined, v)
  return r
}

// ===========================================================================
// 공용 조각
// ===========================================================================

const SLOT_NAME: Record<SlotKind, string> = {
  barrel: '총열',
  handguard: '총열덮개',
  optic: '광학',
  stock: '개머리판',
  rail: '보조 레일',
}

const RARITY_NAME: Record<Rarity, string> = {
  common: '일반',
  uncommon: '희귀',
  rare: '영웅',
  relic: '유물',
}

const RARITY_COLOR: Record<Rarity, string> = {
  common: '#7b828c',
  uncommon: '#4d90c8',
  rare: '#a763d8',
  relic: '#e0b23c',
}

export function slotName(s: SlotKind): string {
  return SLOT_NAME[s]
}

export function rarityName(r: Rarity): string {
  return RARITY_NAME[r]
}

export function rarityColor(r: Rarity): string {
  return RARITY_COLOR[r]
}

/** .rar 뱃지 */
export function rarityTag(r: Rarity): HTMLElement {
  return el('span', 'rar ' + r, RARITY_NAME[r])
}

/** 레어도 점 표기 ●○○○ (문 보상 힌트용) */
export function rarityDots(r: Rarity): string {
  const n = r === 'common' ? 1 : r === 'uncommon' ? 2 : r === 'rare' ? 3 : 4
  return '●'.repeat(n) + '○'.repeat(4 - n)
}

/** 탄 1발을 카드처럼 보여주는 .pick-icon (색맹 패턴을 위해 data-type 을 붙인다) */
export function ammoIcon(a: Ammo): HTMLElement {
  const box = el('div', 'pick-icon')
  box.dataset['type'] = a.type
  box.style.setProperty('--c', typeColor(a.type))
  const t = add(box, 'div', 'card-type', typeShort(a.type))
  t.style.color = typeColor(a.type)
  add(box, 'div', 'card-grade', gradeRoman(a.grade))
  add(box, 'div', 'card-dmg', String(ammoStats(a).dmg))
  return box
}

/** 부착물 아이콘 (부위 글리프 + 레어도 색 테두리) */
export function attachmentIcon(a: Attachment): HTMLElement {
  const box = el('div', 'pick-icon')
  box.style.borderColor = RARITY_COLOR[a.rarity]
  const g = add(box, 'div', 'card-type', SLOT_NAME[a.slot])
  g.style.color = RARITY_COLOR[a.rarity]
  g.style.fontSize = '9px'
  const mark = add(box, 'div', 'card-grade', slotGlyph(a.slot))
  mark.style.fontSize = '20px'
  return box
}

function slotGlyph(s: SlotKind): string {
  switch (s) {
    case 'barrel':
      return '│'
    case 'handguard':
      return '▤'
    case 'optic':
      return '◎'
    case 'stock':
      return '◣'
    case 'rail':
      return '⋮'
  }
}

/** 탄 1발 설명 줄: "피해 58 · 온도 +0.10" */
export function ammoDesc(a: Ammo): string {
  const st = ammoStats(a)
  const parts = ['피해 ' + fmtInt(st.dmg), '온도 +' + st.heat.toFixed(2)]
  if (st.knockback > 0) parts.push('넉백 ' + st.knockback.toFixed(1) + 'm')
  if (st.nextDmgBonus > 0) parts.push('다음 탄 +' + st.nextDmgBonus)
  return parts.join(' · ')
}

// ===========================================================================
// 장착 요약 (.loadout-strip)
// ===========================================================================

interface StripEntry {
  label: string
  att: Attachment | null
}

function stripEntries(l: Loadout): StripEntry[] {
  const out: StripEntry[] = [
    { label: SLOT_NAME.barrel, att: l.barrel },
    { label: SLOT_NAME.handguard, att: l.handguard },
    { label: SLOT_NAME.optic, att: l.optic },
    { label: SLOT_NAME.stock, att: l.stock },
  ]
  for (let i = 0; i < l.railSlots; i += 1) {
    out.push({ label: '레일' + (i + 1), att: l.rails[i] ?? null })
  }
  return out
}

/**
 * 현재 장착 부착물 한 줄 요약. 보상/상점 화면 상단에 늘 띄워 비교 가능하게 한다.
 * 칩을 누르면 부착물 상세가 뜬다.
 */
export function loadoutStrip(l: Loadout, bin?: Bin): HTMLElement {
  const strip = el('div', 'loadout-strip')
  for (const e of stripEntries(l)) {
    const a = e.att
    const chip = add(strip, 'div', a === null ? 'att-chip empty' : 'att-chip')
    const dot = add(chip, 'span', 'dot')
    dot.style.background = a === null ? '#333a42' : RARITY_COLOR[a.rarity]
    add(chip, 'span', undefined, a === null ? e.label + ' —' : a.name)
    chip.setAttribute('aria-label', a === null ? e.label + ' 비어 있음' : e.label + ' ' + a.name)
    if (a !== null) {
      chip.setAttribute('role', 'button')
      const off = on(chip, 'click', () => {
        void infoPop({
          title: a.name,
          accent: RARITY_COLOR[a.rarity],
          lines: [a.text],
          rows: [
            ['부위', SLOT_NAME[a.slot]],
            ['등급', RARITY_NAME[a.rarity]],
          ],
        })
      })
      if (bin !== undefined) bin.add(off)
    }
  }
  // 탄창도 같은 줄에 붙인다 (빌드 비교에 반드시 필요한 정보다)
  const mag = add(strip, 'div', 'att-chip')
  const md = add(mag, 'span', 'dot')
  md.style.background = '#c8a44d'
  add(mag, 'span', undefined, l.magazine.name + ' (' + l.magazine.cap + ')')
  return strip
}

// ===========================================================================
// 가방 구성
// ===========================================================================

export interface BagCounts {
  total: number
  /** [탄종][등급] 개수 */
  matrix: Record<string, number[]>
  byType: Record<string, number>
  byGrade: number[]
  avgGrade: number
}

const TYPE_ORDER = ['AP', 'INC', 'HE', 'SANC'] as const

export function bagCounts(bag: readonly Ammo[]): BagCounts {
  const matrix: Record<string, number[]> = {}
  const byType: Record<string, number> = {}
  for (const t of TYPE_ORDER) {
    matrix[t] = [0, 0, 0, 0, 0]
    byType[t] = 0
  }
  const byGrade = [0, 0, 0, 0, 0]
  let gradeSum = 0
  for (const a of bag) {
    const row = matrix[a.type]
    if (row === undefined) continue
    row[a.grade - 1] += 1
    byType[a.type] += 1
    byGrade[a.grade - 1] += 1
    gradeSum += a.grade
  }
  return {
    total: bag.length,
    matrix,
    byType,
    byGrade,
    avgGrade: bag.length > 0 ? gradeSum / bag.length : 0,
  }
}

/** 탄종 × 등급 히스토그램 표 */
export function bagHistogram(bag: readonly Ammo[]): HTMLElement {
  const c = bagCounts(bag)
  const box = el('div')
  box.style.border = '1px solid var(--line)'
  box.style.borderRadius = '6px'
  box.style.background = 'var(--bg-panel)'
  box.style.padding = '8px'

  const grid = add(box, 'div')
  grid.style.display = 'grid'
  grid.style.gridTemplateColumns = '58px repeat(5, 1fr) 34px'
  grid.style.gap = '3px'
  grid.style.fontSize = '11px'
  grid.style.fontVariantNumeric = 'tabular-nums'

  const head = (text: string): HTMLElement => {
    const n = add(grid, 'div', undefined, text)
    n.style.color = 'var(--text-faint)'
    n.style.fontSize = '10px'
    n.style.textAlign = 'center'
    return n
  }
  head('탄종')
  for (let g = 1 as Grade; g <= 5; g = (g + 1) as Grade) head(gradeRoman(g))
  head('계')

  const max = Math.max(1, ...Object.values(c.matrix).flat())
  for (const t of TYPE_ORDER) {
    const name = add(grid, 'div', undefined, typeName(t) + ' ' + t)
    name.style.color = typeColor(t)
    name.style.fontSize = '10px'
    for (let i = 0; i < 5; i += 1) {
      const n = c.matrix[t][i]
      const cell = add(grid, 'div')
      cell.style.position = 'relative'
      cell.style.textAlign = 'center'
      cell.style.borderRadius = '2px'
      cell.style.background = n > 0 ? 'rgba(255,255,255,.05)' : 'transparent'
      // 개수 비례 채움 (히스토그램)
      if (n > 0) {
        const bar = add(cell, 'div')
        bar.style.position = 'absolute'
        bar.style.left = '0'
        bar.style.bottom = '0'
        bar.style.right = '0'
        bar.style.height = ((n / max) * 100).toFixed(0) + '%'
        bar.style.background = typeColor(t)
        bar.style.opacity = '.32'
        bar.style.borderRadius = '2px'
      }
      const lab = add(cell, 'div', undefined, n > 0 ? String(n) : '·')
      lab.style.position = 'relative'
      lab.style.color = n > 0 ? 'var(--text)' : 'var(--text-faint)'
    }
    const sum = add(grid, 'div', undefined, String(c.byType[t]))
    sum.style.textAlign = 'center'
    sum.style.color = 'var(--text-dim)'
  }
  return box
}

// ===========================================================================
// 부착물 시트 본체
// ===========================================================================

interface SlotRow {
  label: string
  att: Attachment | null
  locked?: boolean
}

function slotRows(l: Loadout): SlotRow[] {
  const rows: SlotRow[] = [
    { label: SLOT_NAME.barrel, att: l.barrel },
    { label: SLOT_NAME.handguard, att: l.handguard },
    { label: SLOT_NAME.optic, att: l.optic },
    { label: SLOT_NAME.stock, att: l.stock },
  ]
  // 레일은 항상 2칸을 보여준다. 열리지 않은 칸은 "잠김".
  for (let i = 0; i < 2; i += 1) {
    const open = i < l.railSlots
    rows.push({
      label: '보조 레일 ' + (i + 1),
      att: open ? l.rails[i] ?? null : null,
      locked: !open,
    })
  }
  return rows
}

/** 정적 보정을 사람이 읽는 문장으로 */
function modsText(a: Attachment): string | null {
  const m = a.mods
  if (m === undefined) return null
  const out: string[] = []
  if (m.tray !== undefined) out.push('트레이 ' + signed(m.tray))
  if (m.cap !== undefined) out.push('탄창 ' + signed(m.cap))
  if (m.startDist !== undefined) out.push('시작 거리 ' + signed(m.startDist) + 'm')
  if (m.fireCost !== undefined) out.push('사격 비용 ' + signed(m.fireCost) + 'm')
  if (m.ejectCost !== undefined) out.push('배출 비용 ' + signed(m.ejectCost) + 'm')
  if (m.enemySpeed !== undefined) out.push('적 속도 ' + signed(m.enemySpeed))
  if (m.railSlots !== undefined) out.push('보조 레일 ' + signed(m.railSlots) + '칸')
  return out.length > 0 ? out.join(' · ') : null
}

function signed(n: number): string {
  return n >= 0 ? '+' + n : String(n)
}

/**
 * 현재 장착 6칸 + 탄창 + 가방 구성. 읽기 전용이다.
 * 전투 중에도 열 수 있으므로 어떤 상태도 바꾸지 않는다.
 */
export function showLoadout(host: HTMLElement, run: RunState): Promise<void> {
  const l = run.loadout
  const sc = openScreen(host, '장비 시트')
  const { root, bin } = sc

  header(root, '장비', '섹터 ' + run.sector + ' · 탄피 ' + fmtInt(l.brass))
  root.appendChild(loadoutStrip(l, bin))

  section(root, '부착물 6칸')
  const list = add(root, 'div', 'pick-grid')
  for (const r of slotRows(l)) {
    const row = add(list, 'div', 'pick')
    const a = r.att
    if (a !== null) {
      row.appendChild(attachmentIcon(a))
    } else {
      const box = add(row, 'div', 'pick-icon')
      const mk = add(box, 'div', 'card-grade', r.locked === true ? '×' : '—')
      mk.style.color = 'var(--text-faint)'
    }
    const body = add(row, 'div', 'pick-body')
    const nameRow = add(body, 'div', 'pick-name', a !== null ? a.name : r.label)
    if (a === null) nameRow.style.color = 'var(--text-faint)'
    const meta = add(body, 'div', 'pick-meta')
    add(meta, 'span', 'slotname', r.label)
    if (a !== null) meta.appendChild(rarityTag(a.rarity))
    const desc =
      a !== null ? a.text : r.locked === true ? '아직 열리지 않은 칸이다.' : '비어 있다.'
    add(body, 'div', 'pick-text', desc)
    const mods = a !== null ? modsText(a) : null
    if (mods !== null) {
      const m = add(body, 'div', 'pick-text', mods)
      m.style.color = 'var(--brass-dim)'
    }
  }

  section(root, '탄창')
  const magRow = add(root, 'div', 'pick')
  const magIcon = add(magRow, 'div', 'pick-icon')
  const magCap = add(magIcon, 'div', 'card-grade', String(l.magazine.cap))
  magCap.style.color = 'var(--brass)'
  add(magIcon, 'div', 'card-dmg', '발')
  const magBody = add(magRow, 'div', 'pick-body')
  add(magBody, 'div', 'pick-name', l.magazine.name)
  add(magBody, 'div', 'pick-text', l.magazine.text)

  section(root, '가방 구성')
  const counts = bagCounts(l.bag)
  const nums = add(root, 'div')
  statRow(nums, '총 탄 수', fmtInt(counts.total) + '발')
  statRow(nums, '평균 등급', counts.avgGrade.toFixed(2))
  statRow(nums, '트레이 / 탄창', computeTraySize(l) + ' / ' + computeCap(l))
  root.appendChild(bagHistogram(l.bag))

  add(root, 'div', 'spacer')
  const row = buttonRow(root)
  const closeBtn = button(row, '닫기', { kind: 'ghost', grow: 1 })

  return new Promise<void>((resolve) => {
    const done = (): void => {
      sc.close()
      resolve()
    }
    bin.add(on(closeBtn, 'click', done))
    bin.add(
      on(window, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !isPopoverOpen()) done()
      }),
    )
  })
}

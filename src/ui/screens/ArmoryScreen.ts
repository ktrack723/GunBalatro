// 정비소 / 성소 — armoryStock(run) · reliquaryStock(run) 의 진열을 .pick 리스트로 판다.
// 여러 번 살 수 있고, 결과 문장은 buy() 가 돌려준 그대로 토스트에 띄운다.
// 구매 성공 판정은 문자열이 아니라 **탄피 잔액 변화**로 한다 (문구가 바뀌어도 안 깨진다).

import type { Ammo, AmmoType, Attachment, Grade, Magazine, RunState } from '../../core/types'
import type { ArmoryEntry } from '../../core/run'
import { armoryStock, buy } from '../../core/run'
import { ammoLabel, gradeRoman, typeColor } from '../../core/ammoStats'
import { ATT_BY_ID } from '../../core/data/attachments'
import { MAG_BY_ID } from '../../core/data/magazines'
import { add, clear, closestFrom, el, fmtInt, on } from '../dom'
import { closePopover, infoPop, popover } from '../popover'
import { toast } from '../toast'
import {
  ammoDesc,
  ammoIcon,
  attachmentIcon,
  button,
  buttonRow,
  header,
  loadoutStrip,
  openScreen,
  rarityColor,
  rarityName,
  rarityTag,
  section,
  showLoadout,
  slotName,
} from './LoadoutSheet'

/** 가방이 이보다 얇아지는 제거는 core 가 거절한다 (run.ts MIN_BAG) */
const MIN_BAG = 6

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 진열 payload 에서 부착물을 되찾는다 (payload 는 unknown 계약) */
function payloadAttachment(p: unknown): Attachment | null {
  if (!isRec(p)) return null
  const raw = p['attachment']
  if (!isRec(raw)) return null
  const id = raw['id']
  return typeof id === 'string' ? ATT_BY_ID[id] ?? null : null
}

function payloadMagazine(p: unknown): Magazine | null {
  if (!isRec(p)) return null
  const raw = p['magazine']
  if (!isRec(raw)) return null
  const id = raw['id']
  return typeof id === 'string' ? MAG_BY_ID[id] ?? null : null
}

function payloadAmmo(p: unknown): { type: AmmoType; grade: Grade } | null {
  if (!isRec(p)) return null
  const t = p['type']
  const g = p['grade']
  if (typeof t !== 'string' || typeof g !== 'number') return null
  if (t !== 'AP' && t !== 'INC' && t !== 'HE' && t !== 'SANC') return null
  if (g < 1 || g > 5) return null
  return { type: t, grade: Math.floor(g) as Grade }
}

/** 가방에서 탄 1발 고르기 (제거 대상 지정) */
async function pickBagAmmo(bag: readonly Ammo[]): Promise<string | null> {
  interface Group {
    uid: string
    label: string
    type: AmmoType
    n: number
    grade: Grade
  }
  const groups: Group[] = []
  for (const a of bag) {
    const g = groups.find((x) => x.label === ammoLabel(a))
    if (g !== undefined) g.n += 1
    else groups.push({ uid: a.uid, label: ammoLabel(a), type: a.type, n: 1, grade: a.grade })
  }
  groups.sort((x, y) => x.grade - y.grade || x.label.localeCompare(y.label))

  const wrap = el('div')
  wrap.style.display = 'flex'
  wrap.style.flexDirection = 'column'
  wrap.style.gap = '6px'
  wrap.style.maxHeight = '46vh'
  wrap.style.overflowY = 'auto'

  let chosen: string | null = null
  for (const g of groups) {
    const b = add(wrap, 'button', 'btn')
    b.type = 'button'
    b.style.flexDirection = 'row'
    b.style.justifyContent = 'space-between'
    b.style.padding = '0 12px'
    const name = add(b, 'span', undefined, gradeRoman(g.grade) + ' ' + g.label)
    name.style.color = typeColor(g.type)
    add(b, 'small', undefined, '가방에 ' + g.n + '발')
    b.addEventListener('click', () => {
      chosen = g.uid
      closePopover()
    })
  }

  await popover({
    title: '어느 탄을 덜어낼까',
    lines: ['가방이 얇을수록 원하는 탄이 손에 자주 온다.', wrap],
    actions: [{ id: 'no', label: '취소', kind: 'ghost' }],
  })
  return chosen
}

export function showArmory(
  host: HTMLElement,
  run: RunState,
  title: string,
  stock: ArmoryEntry[],
): Promise<void> {
  const sc = openScreen(host, title)
  const { root, bin } = sc

  const h = header(root, title)
  const sub = add(root, 'p', undefined, '')
  const stripBox = add(root, 'div')

  section(root, '진열')
  const list = add(root, 'div', 'pick-grid')

  add(root, 'div', 'spacer')
  const row = buttonRow(root)
  const loadoutBtn = button(row, '장비 보기', { kind: 'ghost', grow: 1 })
  const exitBtn = button(row, '나가기', { kind: 'primary', grow: 1.4 })

  // 진열은 로컬 사본으로 다룬다 (호출부 배열을 건드리지 않는다)
  const entries: ArmoryEntry[] = stock.slice()
  const sold = new Set<number>()

  const canAfford = (e: ArmoryEntry): boolean => run.loadout.brass >= e.price

  /** 제거/승급은 살 때마다 가격·대상이 변한다 → 좌표 고정 진열에서 다시 읽어온다 */
  const refreshDynamic = (): void => {
    const dyn = entries.some((e) => e.kind === 'removal' || e.kind === 'upgrade')
    if (!dyn) return
    const fresh = armoryStock(run)
    for (let i = 0; i < entries.length; i += 1) {
      const k = entries[i].kind
      if (k !== 'removal' && k !== 'upgrade') continue
      const f = fresh.find((e) => e.kind === k)
      if (f !== undefined) entries[i] = f
      else sold.add(i) // 더 이상 살 수 없다 (예: 가방이 전부 Mk.V)
    }
  }

  const describe = (e: ArmoryEntry): { text: string; icon: HTMLElement; meta: HTMLElement } => {
    const meta = el('div', 'pick-meta')
    let text = ''
    let icon: HTMLElement

    const att = payloadAttachment(e.payload)
    const mag = payloadMagazine(e.payload)
    const am = payloadAmmo(e.payload)

    if (att !== null) {
      text = att.text
      icon = attachmentIcon(att)
      meta.appendChild(rarityTag(att.rarity))
      add(meta, 'span', 'slotname', slotName(att.slot))
      if (att.slot === 'rail' && run.loadout.railSlots <= 0) {
        const w = add(meta, 'span', 'slotname', '보조 레일 없음')
        w.style.color = 'var(--blood-bright)'
      }
    } else if (mag !== null) {
      text = mag.text
      icon = el('div', 'pick-icon')
      const cap = add(icon, 'div', 'card-grade', String(mag.cap))
      cap.style.color = 'var(--brass)'
      add(icon, 'div', 'card-dmg', '발')
      add(meta, 'span', 'slotname', '지금: ' + run.loadout.magazine.name)
    } else if (am !== null) {
      const a: Ammo = { uid: '#shop', type: am.type, grade: am.grade }
      text = ammoDesc(a)
      icon = ammoIcon(a)
      add(meta, 'span', 'slotname', '가방 ' + run.loadout.bag.length + '발 → ' + (run.loadout.bag.length + 1) + '발')
    } else {
      icon = el('div', 'pick-icon')
      const glyph =
        e.kind === 'removal' ? '−' : e.kind === 'upgrade' ? '↑' : e.kind === 'rail' ? '⋮' : '+'
      const gm = add(icon, 'div', 'card-grade', glyph)
      gm.style.color = 'var(--brass)'
      if (e.kind === 'removal') {
        text = '가방을 얇게 만든다. 살 때마다 20씩 비싸진다.'
        add(meta, 'span', 'slotname', '가방 ' + run.loadout.bag.length + '발')
      } else if (e.kind === 'upgrade') {
        text = '가장 낮은 등급의 탄을 전부 한 단계 올린다.'
      } else if (e.kind === 'rail') {
        text = '보조 레일 칸을 연다. 부착물 슬롯이 늘어난다.'
      } else {
        text = '다음 전투를 더 멀리서 시작한다.'
      }
    }
    return { text, icon, meta }
  }

  const render = (): void => {
    h.textContent = title
    sub.textContent =
      '탄피 ' +
      fmtInt(run.loadout.brass) +
      ' · 가방 ' +
      run.loadout.bag.length +
      '발 · 레일 ' +
      run.loadout.railSlots +
      '칸'

    clear(stripBox)
    stripBox.appendChild(loadoutStrip(run.loadout, bin))

    clear(list)
    let shown = 0
    entries.forEach((e, i) => {
      if (sold.has(i)) return
      shown += 1
      const rowEl = add(list, 'div', 'pick')
      rowEl.dataset['i'] = String(i)
      rowEl.setAttribute('role', 'button')
      rowEl.tabIndex = 0

      const d = describe(e)
      rowEl.appendChild(d.icon)
      const body = add(rowEl, 'div', 'pick-body')
      add(body, 'div', 'pick-name', e.label)
      add(body, 'div', 'pick-text', d.text)
      body.appendChild(d.meta)

      const price = add(rowEl, 'div')
      price.style.marginLeft = 'auto'
      price.style.textAlign = 'right'
      price.style.flex = '0 0 auto'
      price.style.fontFamily = 'var(--font-num)'
      price.style.fontWeight = '800'
      price.style.fontSize = '14px'
      const afford = canAfford(e)
      const blocked = e.kind === 'removal' && run.loadout.bag.length <= MIN_BAG
      price.textContent = fmtInt(e.price)
      price.style.color = afford && !blocked ? 'var(--brass)' : 'var(--blood-bright)'
      const unit = add(price, 'div', undefined, '탄피')
      unit.style.fontSize = '9px'
      unit.style.fontWeight = '500'
      unit.style.color = 'var(--text-faint)'

      if (!afford || blocked) rowEl.style.opacity = '.45'
      rowEl.setAttribute(
        'aria-label',
        e.label + ', ' + e.price + ' 탄피' + (afford ? '' : ', 탄피 부족'),
      )
    })

    if (shown === 0) {
      const empty = add(list, 'p', undefined, '진열이 비었다. 더 팔 것이 없다.')
      empty.style.textAlign = 'center'
    }
  }

  const purchase = async (i: number): Promise<void> => {
    const e = entries[i]
    if (e === undefined || sold.has(i)) return

    let entry = e
    if (e.kind === 'removal' && run.loadout.bag.length > MIN_BAG && canAfford(e)) {
      const uid = await pickBagAmmo(run.loadout.bag)
      if (uid === null) return
      entry = { ...e, payload: { uid } }
    }

    const before = run.loadout.brass
    const msg = buy(run, entry)
    const spent = before - run.loadout.brass
    toast(msg)

    if (spent > 0) {
      // 1회성 물건은 진열에서 내린다
      if (e.kind === 'attachment' || e.kind === 'magazine' || e.kind === 'rail') sold.add(i)
      refreshDynamic()
    }
    render()
  }

  render()

  let settled = false
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      if (settled) return
      settled = true
      sc.close()
      resolve()
    }

    bin.add(
      on(list, 'click', (ev: MouseEvent) => {
        const rowEl = closestFrom(ev, '.pick')
        if (rowEl === null) return
        const i = Number(rowEl.dataset['i'])
        if (Number.isFinite(i)) void purchase(i)
      }),
    )
    bin.add(
      on(list, 'keydown', (ev: KeyboardEvent) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return
        const rowEl = closestFrom(ev, '.pick')
        if (rowEl === null) return
        ev.preventDefault()
        const i = Number(rowEl.dataset['i'])
        if (Number.isFinite(i)) void purchase(i)
      }),
    )
    bin.add(
      on(loadoutBtn, 'click', () => {
        void showLoadout(host, run)
      }),
    )
    bin.add(on(exitBtn, 'click', finish))
  })
}

/** 진열품 상세 (다른 화면에서 재사용 가능) */
export function armoryEntryInfo(e: ArmoryEntry): Promise<void> {
  const att = payloadAttachment(e.payload)
  return infoPop({
    title: e.label,
    accent: att !== null ? rarityColor(att.rarity) : undefined,
    lines: att !== null ? [att.text] : undefined,
    rows: [
      ['가격', fmtInt(e.price) + ' 탄피'],
      ...(att !== null
        ? ([
            ['부위', slotName(att.slot)],
            ['등급', rarityName(att.rarity)],
          ] as Array<[string, string]>)
        : []),
    ],
  })
}

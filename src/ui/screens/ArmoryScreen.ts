// 정비소 / 성소 — 탄피로 특수탄·부착물·레일·응급 보급을 산다. 여러 번 살 수 있다.
import type { Attachment, RunState } from '../../core/types'
import { SLOT_LABEL } from '../../core/types'
import type { ArmoryEntry } from '../../core/run'
import { armoryStock, buy, reliquaryStock } from '../../core/run'
import { add, clear, fmtInt, on } from '../dom'
import { toast } from '../toast'
import {
  attachmentIcon,
  button,
  buttonRow,
  header,
  loadoutStrip,
  modsText,
  openScreen,
  rarityTag,
  specialIcon,
} from './LoadoutSheet'

function attachmentOf(e: ArmoryEntry): Attachment | null {
  const p = e.payload as { attachment?: Attachment } | undefined
  return p?.attachment ?? null
}

/**
 * 진열 아이콘. 예전에는 부착물이 전부 '＋' 하나였다 — 탄창인지 총열인지 아이콘만
 * 봐서는 알 수 없었다. 부착물은 부위 이름이 박힌 아이콘을 그대로 쓴다.
 */
function iconFor(e: ArmoryEntry): HTMLElement {
  if (e.kind === 'special') {
    const p = e.payload as { id?: string } | undefined
    if (p?.id !== undefined) return specialIcon(p.id)
  }
  if (e.kind === 'attachment') {
    const a = attachmentOf(e)
    if (a !== null) return attachmentIcon(a)
  }
  const wrap = document.createElement('div')
  wrap.className = 'pick-icon'
  const t = add(wrap, 'div', 'card-type', e.kind === 'rail' ? '레일' : '보급')
  t.style.fontSize = '9px'
  add(wrap, 'div', 'card-grade', e.kind === 'rail' ? '◎' : '✚')
  return wrap
}

/** 이게 무엇인지 — 부착물이면 부위, 특수탄이면 발수, 나머지는 종류 */
function kindText(e: ArmoryEntry): string {
  if (e.kind === 'attachment') {
    const a = attachmentOf(e)
    return a !== null ? '부착물 · ' + SLOT_LABEL[a.slot] : '부착물'
  }
  if (e.kind === 'special') return '특수탄'
  if (e.kind === 'rail') return '보조 광학 칸'
  return '보급'
}

export function showArmory(
  host: HTMLElement,
  run: RunState,
  title: string,
  stock: ArmoryEntry[],
): Promise<void> {
  const sc = openScreen(host, title)
  const { root, bin } = sc
  const isReliquary = title.includes('성소')

  header(root, title)
  // 탄피 잔액. 예전에는 h1 안에서 <p> 를 찾고 있어서(형제인데) 영영 못 찾았다 —
  // 상점에서 내 돈이 얼마인지 안 보이는 화면이었다.
  const brassLine = add(root, 'p', 'shop-brass')
  const strip = add(root, 'div')
  const list = add(root, 'div', 'pick-grid')

  const refreshHeader = (): void => {
    brassLine.textContent = '보유 탄피 ' + fmtInt(run.loadout.brass)
    clear(strip)
    strip.appendChild(loadoutStrip(run.loadout, bin))
  }

  const render = (): void => {
    clear(list)
    const entries = isReliquary ? reliquaryStock(run) : armoryStock(run)
    for (const e of entries) {
      const row = add(list, 'div', 'pick' + (e.rarity !== undefined ? ' r-' + e.rarity : ''))
      const afford = run.loadout.brass >= e.price
      if (!afford) row.style.opacity = '0.42'
      row.appendChild(iconFor(e))
      const body = add(row, 'div', 'pick-body')
      add(body, 'div', 'pick-name', e.label)
      if (e.sub !== undefined) add(body, 'div', 'pick-text', e.sub)
      const a = attachmentOf(e)
      const m = a !== null ? modsText(a) : null
      if (m !== null) {
        const line = add(body, 'div', 'pick-text', m)
        line.style.color = 'var(--brass-dim)'
      }
      const meta = add(body, 'div', 'pick-meta')
      if (e.rarity !== undefined) meta.appendChild(rarityTag(e.rarity))
      add(meta, 'span', 'slotname', kindText(e))
      const price = add(meta, 'span', 'slotname', '탄피 ' + fmtInt(e.price))
      price.style.color = afford ? 'var(--brass)' : 'var(--blood-bright)'

      bin.add(
        on(row, 'click', () => {
          if (run.loadout.brass < e.price) {
            toast('탄피가 부족하다.')
            return
          }
          toast(buy(run, e), 2200)
          refreshHeader()
          render()
        }),
      )
    }
    if (entries.length === 0) add(list, 'p', undefined, '진열이 비었다.')
  }

  refreshHeader()
  render()
  void stock

  return new Promise<void>((resolve) => {
    add(root, 'div', 'spacer')
    const row = buttonRow(root)
    const close = button(row, '나가기', { kind: 'primary', grow: 1 })
    bin.add(
      on(close, 'click', () => {
        sc.close()
        resolve()
      }),
    )
  })
}

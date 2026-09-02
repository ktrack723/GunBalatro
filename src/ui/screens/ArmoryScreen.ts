// 정비소 / 성소 — 탄피로 특수탄·부착물·레일·응급 보급을 산다. 여러 번 살 수 있다.
import type { RunState } from '../../core/types'
import type { ArmoryEntry } from '../../core/run'
import { armoryStock, buy, reliquaryStock } from '../../core/run'
import { add, clear, fmtInt, on } from '../dom'
import { toast } from '../toast'
import {
  button,
  buttonRow,
  header,
  loadoutStrip,
  openScreen,
  rarityTag,
  specialIcon,
} from './LoadoutSheet'

function iconFor(e: ArmoryEntry): HTMLElement {
  if (e.kind === 'special') {
    const p = e.payload as { id?: string } | undefined
    if (p?.id !== undefined) return specialIcon(p.id)
  }
  const box = add(document.createElement('div'), 'div', 'card-grade', e.kind === 'rail' ? '⋮' : '＋')
  const wrap = document.createElement('div')
  wrap.className = 'pick-icon'
  wrap.appendChild(box)
  return wrap
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

  const head = header(root, title, '')
  const strip = add(root, 'div')
  const list = add(root, 'div', 'pick-grid')

  const refreshHeader = (): void => {
    const sub = head.querySelector('p')
    if (sub !== null) sub.textContent = '탄피 ' + fmtInt(run.loadout.brass)
    clear(strip)
    strip.appendChild(loadoutStrip(run.loadout, bin))
  }

  const render = (): void => {
    clear(list)
    const entries = isReliquary ? reliquaryStock(run) : armoryStock(run)
    for (const e of entries) {
      const row = add(list, 'div', 'pick')
      const afford = run.loadout.brass >= e.price
      if (!afford) row.style.opacity = '0.42'
      row.appendChild(iconFor(e))
      const body = add(row, 'div', 'pick-body')
      add(body, 'div', 'pick-name', e.label)
      if (e.sub !== undefined) add(body, 'div', 'pick-text', e.sub)
      const meta = add(body, 'div', 'pick-meta')
      if (e.rarity !== undefined) meta.appendChild(rarityTag(e.rarity))
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

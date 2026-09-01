// 폐허 이벤트 — 본문 + 선택지. 고르면 결과 문장을 보여주고 "계속" 을 기다린다.
//
// ★ 주의: 결과 문장을 보여주려면 apply() 의 리턴값이 필요하므로 **이 화면이 직접 apply 한다.**
//   rng 는 core 의 runRng(run) 을 써서 run.rngState 를 정상적으로 소비/보존한다.
//   호출부는 리턴된 인덱스를 기록만 하고 절대 다시 apply 하지 마라.

import type { DerelictEvent, RunState } from '../../core/types'
import { runRng } from '../../core/run'
import { add, clear, closestFrom, fmtInt, on } from '../dom'
import {
  button,
  buttonRow,
  header,
  loadoutStrip,
  openScreen,
  section,
  showLoadout,
} from './LoadoutSheet'

export function showDerelict(
  host: HTMLElement,
  run: RunState,
  ev: DerelictEvent,
): Promise<number> {
  const sc = openScreen(host, '폐허')
  const { root, bin } = sc

  header(root, ev.name)
  const body = add(root, 'p', undefined, ev.body)
  body.style.fontSize = '14px'
  body.style.lineHeight = '1.5'

  const info = add(root, 'p', undefined, '탄피 ' + fmtInt(run.loadout.brass) + ' · 가방 ' + run.loadout.bag.length + '발')
  info.style.fontSize = '11px'
  root.appendChild(loadoutStrip(run.loadout, bin))

  section(root, '선택')
  const list = add(root, 'div', 'pick-grid')
  ev.options.forEach((o, i) => {
    const rowEl = add(list, 'div', 'pick')
    rowEl.dataset['i'] = String(i)
    rowEl.setAttribute('role', 'button')
    rowEl.tabIndex = 0
    rowEl.style.minHeight = '56px'
    const b = add(rowEl, 'div', 'pick-body')
    add(b, 'div', 'pick-name', o.label)
  })

  const spacer = add(root, 'div', 'spacer')
  const row = buttonRow(root)
  const loadoutBtn = button(row, '장비 보기', { kind: 'ghost', grow: 1 })

  let settled = false
  return new Promise<number>((resolve) => {
    const choose = (i: number): void => {
      if (settled) return
      const opt = ev.options[i]
      if (opt === undefined) return
      settled = true

      // 실제 효과 적용 (rngState 를 정상 소비한다)
      let msg = ''
      try {
        msg = opt.apply(run, runRng(run))
      } catch {
        msg = '아무 일도 일어나지 않았다.'
      }

      // 선택지를 결과로 갈아끼운다
      clear(list)
      const res = add(list, 'div', 'pick')
      res.style.borderColor = 'var(--brass-dim)'
      res.style.background = '#151109'
      const rb = add(res, 'div', 'pick-body')
      add(rb, 'div', 'pick-name', opt.label)
      const t = add(rb, 'div', 'pick-text', msg)
      t.style.color = 'var(--text)'
      t.style.fontSize = '13px'
      add(rb, 'div', 'pick-meta').textContent =
        '탄피 ' + fmtInt(run.loadout.brass) + ' · 가방 ' + run.loadout.bag.length + '발'

      clear(row)
      const goBtn = button(row, '계속', { kind: 'primary', grow: 1 })
      bin.add(
        on(goBtn, 'click', () => {
          sc.close()
          resolve(i)
        }),
      )
      spacer.scrollIntoView({ block: 'end', behavior: 'auto' })
    }

    bin.add(
      on(list, 'click', (e: MouseEvent) => {
        const rowEl = closestFrom(e, '.pick')
        if (rowEl === null) return
        const i = Number(rowEl.dataset['i'])
        if (Number.isFinite(i)) choose(i)
      }),
    )
    bin.add(
      on(list, 'keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        const rowEl = closestFrom(e, '.pick')
        if (rowEl === null) return
        e.preventDefault()
        const i = Number(rowEl.dataset['i'])
        if (Number.isFinite(i)) choose(i)
      }),
    )
    bin.add(
      on(loadoutBtn, 'click', () => {
        void showLoadout(host, run)
      }),
    )
  })
}

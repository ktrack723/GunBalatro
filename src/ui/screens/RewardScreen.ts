// 보상방 — 3~4개 중 하나를 고르거나 건너뛴다.
// 상단에 현재 장착(.loadout-strip)을 늘 띄워 "지금 것과 비교"가 가능하게 한다.
// 이 화면은 상태를 바꾸지 않는다. 실제 획득은 호출부의 applyReward(run, item) 몫이다.

import type { Attachment, Loadout, RewardItem, RunState } from '../../core/types'
import { ammoLabel } from '../../core/ammoStats'
import { skipRewardBrass } from '../../core/economy'
import { add, closestFrom, fmtInt, on } from '../dom'
import { confirmPop, infoPop, popover } from '../popover'
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

export interface RewardPick {
  /** 고른 항목 인덱스. null = 건너뛰기 */
  pick: number | null
  /**
   * 레일 부착물을 어느 칸에 달지 (교체 대상이 있을 때만).
   * 호출부는 applyReward(run, item, railIndex) 로 넘기면 된다. 없으면 core 기본값(첫 빈칸).
   */
  railIndex?: number
}

/** 하드포인트에 이미 붙어 있는 부착물 */
function occupant(l: Loadout, a: Attachment): Attachment | null {
  switch (a.slot) {
    case 'barrel':
      return l.barrel
    case 'handguard':
      return l.handguard
    case 'optic':
      return l.optic
    case 'stock':
      return l.stock
    case 'rail':
      return null // 레일은 칸이 여러 개라 따로 처리한다
  }
}

function itemTitle(it: RewardItem): string {
  switch (it.t) {
    case 'attachment':
      return it.attachment.name
    case 'ammo':
      return ammoLabel(it.ammo)
    case 'magazine':
      return it.magazine.name
  }
}

function itemText(it: RewardItem): string {
  switch (it.t) {
    case 'attachment':
      return it.attachment.text
    case 'ammo':
      return ammoDesc(it.ammo)
    case 'magazine':
      return it.magazine.text
  }
}

export function showRewards(
  host: HTMLElement,
  run: RunState,
  items: RewardItem[],
  brass: number,
): Promise<RewardPick> {
  const sc = openScreen(host, '보상')
  const { root, bin } = sc
  const l = run.loadout

  header(root, '보상', brass > 0 ? '정화 완료 · 탄피 +' + fmtInt(brass) : '정화 완료')

  section(root, '지금 장착')
  root.appendChild(loadoutStrip(l, bin))

  section(root, '하나만 가져간다')
  const list = add(root, 'div', 'pick-grid')

  items.forEach((it, i) => {
    const row = add(list, 'div', 'pick')
    row.dataset['i'] = String(i)
    row.setAttribute('role', 'button')
    row.tabIndex = 0

    if (it.t === 'attachment') row.appendChild(attachmentIcon(it.attachment))
    else if (it.t === 'ammo') row.appendChild(ammoIcon(it.ammo))
    else {
      const box = add(row, 'div', 'pick-icon')
      const cap = add(box, 'div', 'card-grade', String(it.magazine.cap))
      cap.style.color = 'var(--brass)'
      add(box, 'div', 'card-dmg', '발')
    }

    const body = add(row, 'div', 'pick-body')
    add(body, 'div', 'pick-name', itemTitle(it))
    add(body, 'div', 'pick-text', itemText(it))

    const meta = add(body, 'div', 'pick-meta')
    if (it.t === 'attachment') {
      meta.appendChild(rarityTag(it.attachment.rarity))
      add(meta, 'span', 'slotname', slotName(it.attachment.slot))
      const cur = occupant(l, it.attachment)
      if (cur !== null) {
        const warn = add(meta, 'span', 'slotname', '교체: ' + cur.name)
        warn.style.color = 'var(--brass-dim)'
      }
      if (it.attachment.slot === 'rail' && l.railSlots <= 0) {
        const warn = add(meta, 'span', 'slotname', '보조 레일 없음 — 달 수 없다')
        warn.style.color = 'var(--blood-bright)'
        row.style.opacity = '.5'
      }
    } else if (it.t === 'ammo') {
      add(meta, 'span', 'slotname', '가방에 추가')
    } else {
      add(meta, 'span', 'slotname', '탄창 교체: ' + l.magazine.name)
    }

    const detail = add(row, 'button', 'btn ghost')
    detail.type = 'button'
    detail.style.flex = '0 0 auto'
    detail.style.minWidth = '44px'
    detail.style.maxWidth = '44px'
    detail.style.padding = '0'
    detail.setAttribute('aria-label', itemTitle(it) + ' 상세')
    add(detail, 'span', undefined, 'ⓘ')
    detail.dataset['detail'] = String(i)
  })

  add(root, 'div', 'spacer')

  const skipBrass = skipRewardBrass(run.stake)
  const row2 = buttonRow(root)
  const loadoutBtn = button(row2, '장비 보기', { kind: 'ghost', grow: 1 })
  const skipBtn = button(row2, '건너뛰기', {
    grow: 1.4,
    sub: skipBrass > 0 ? '탄피 +' + skipBrass : '보상 없음 (성전 등급 2+)',
  })

  let settled = false
  return new Promise<RewardPick>((resolve) => {
    const finish = (r: RewardPick): void => {
      if (settled) return
      settled = true
      sc.close()
      resolve(r)
    }

    const detailOf = (i: number): void => {
      const it = items[i]
      const rows: Array<[string, string]> = []
      if (it.t === 'attachment') {
        rows.push(['부위', slotName(it.attachment.slot)])
        rows.push(['등급', rarityName(it.attachment.rarity)])
        const cur = occupant(l, it.attachment)
        if (cur !== null) rows.push(['현재 장착', cur.name + ' — ' + cur.text])
      } else if (it.t === 'ammo') {
        rows.push(['가방', run.loadout.bag.length + '발 → ' + (run.loadout.bag.length + 1) + '발'])
      } else {
        rows.push(['용량', String(it.magazine.cap)])
        rows.push(['현재 탄창', l.magazine.name + ' — ' + l.magazine.text])
      }
      void infoPop({
        title: itemTitle(it),
        accent: it.t === 'attachment' ? rarityColor(it.attachment.rarity) : undefined,
        lines: [itemText(it)],
        rows,
      })
    }

    /** 슬롯이 차 있으면 확인을 받는다 */
    const take = async (i: number): Promise<void> => {
      const it = items[i]

      if (it.t === 'attachment') {
        const a = it.attachment
        if (a.slot === 'rail') {
          if (l.railSlots <= 0) {
            await infoPop({
              title: a.name,
              lines: ['보조 레일 칸이 없어 달 수 없다. 성소에서 레일을 먼저 열어야 한다.'],
            })
            return
          }
          const empty = l.rails.findIndex((x) => x === null)
          if (empty < 0) {
            // 두 칸 다 차 있다 — 어느 것을 버릴지 고른다
            const acts = l.rails.map((x, idx) => ({
              id: String(idx),
              label: '레일 ' + (idx + 1) + ' 교체',
              sub: x !== null ? x.name : '빈 칸',
            }))
            const r = await popover({
              title: a.name + ' 을(를) 어디에?',
              lines: [a.text],
              actions: [{ id: 'no', label: '취소', kind: 'ghost' }, ...acts],
            })
            if (r === null || r === 'no') return
            finish({ pick: i, railIndex: Number(r) })
            return
          }
          finish({ pick: i, railIndex: empty })
          return
        }

        const cur = occupant(l, a)
        if (cur !== null) {
          const ok = await confirmPop({
            title: cur.name + ' 을(를) 버리고 교체?',
            body: a.name + ' — ' + a.text,
            rows: [
              ['지금', cur.name + ' — ' + cur.text],
              ['새로', a.name + ' — ' + a.text],
            ],
            ok: '교체한다',
            cancel: '아니다',
          })
          if (!ok) return
        }
        finish({ pick: i })
        return
      }

      if (it.t === 'magazine') {
        const ok = await confirmPop({
          title: '탄창을 바꿀까?',
          body: it.magazine.name + ' — ' + it.magazine.text,
          rows: [
            ['지금', l.magazine.name + ' (' + l.magazine.cap + '발)'],
            ['새로', it.magazine.name + ' (' + it.magazine.cap + '발)'],
          ],
          ok: '바꾼다',
          cancel: '아니다',
        })
        if (!ok) return
        finish({ pick: i })
        return
      }

      finish({ pick: i })
    }

    bin.add(
      on(list, 'click', (e: MouseEvent) => {
        const det = closestFrom(e, '[data-detail]')
        if (det !== null) {
          const di = Number(det.dataset['detail'])
          if (Number.isFinite(di)) detailOf(di)
          return
        }
        const row = closestFrom(e, '.pick')
        if (row === null) return
        const i = Number(row.dataset['i'])
        if (!Number.isFinite(i)) return
        void take(i)
      }),
    )

    bin.add(
      on(list, 'keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        const row = closestFrom(e, '.pick')
        if (row === null) return
        e.preventDefault()
        const i = Number(row.dataset['i'])
        if (Number.isFinite(i)) void take(i)
      }),
    )

    bin.add(
      on(loadoutBtn, 'click', () => {
        void showLoadout(host, run)
      }),
    )
    bin.add(
      on(skipBtn, 'click', () => {
        finish({ pick: null })
      }),
    )
  })
}

// 전투 보상방 (슬더스식) — 항목을 하나씩 눌러서 가져간다.
//   예전에는 3~4장 중 **하나만** 고르고 나머지는 사라졌다. 그래서 탄피는 자동으로 들어오고
//   특수탄은 '부착물 대신 고르는 것' 이었다 — 획득이 선택의 비용이라 매 전투가 손해로 읽혔다.
//   지금은 탄피 · 특수탄 · 부착물 세 항목이 각각 놓여 있고, 부착물만 그 자리에서 3택이다.
import type { Attachment, RewardRoom, RunState } from '../../core/types'
import { SLOT_LABEL } from '../../core/types'
import { claimAttachment, claimBrass, claimSpecial } from '../../core/run'
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

/** 부착물 3택 시트. 고르면 그 부착물, 닫으면 null */
function pickAttachment(host: HTMLElement, list: Attachment[]): Promise<Attachment | null> {
  const sc = openScreen(host, '부착물 선택')
  const { root, bin } = sc
  header(root, '부착물', '하나를 고른다 — 고르지 않고 나갈 수도 있다')

  return new Promise<Attachment | null>((resolve) => {
    const finish = (a: Attachment | null): void => {
      sc.close()
      resolve(a)
    }
    const grid = add(root, 'div', 'pick-grid')
    for (const a of list) {
      const row = add(grid, 'div', 'pick r-' + a.rarity)
      row.appendChild(attachmentIcon(a))
      const body = add(row, 'div', 'pick-body')
      add(body, 'div', 'pick-name', a.name)
      add(body, 'div', 'pick-text', a.text)
      const m = modsText(a)
      if (m !== null) {
        const line = add(body, 'div', 'pick-text', m)
        line.style.color = 'var(--brass-dim)'
      }
      const meta = add(body, 'div', 'pick-meta')
      meta.appendChild(rarityTag(a.rarity))
      add(meta, 'span', 'slotname', '부착물 · ' + SLOT_LABEL[a.slot])
      bin.add(on(row, 'click', () => finish(a)))
    }
    if (list.length === 0) add(root, 'p', undefined, '가져갈 부착물이 남아 있지 않다.')

    add(root, 'div', 'spacer')
    const close = button(buttonRow(root), '고르지 않는다', { kind: 'ghost', grow: 1 })
    bin.add(on(close, 'click', () => finish(null)))
  })
}

export function showRewards(host: HTMLElement, run: RunState, room: RewardRoom): Promise<void> {
  const sc = openScreen(host, '보상')
  const { root, bin } = sc

  const head = header(root, '전리품', '')
  void head
  const sub = add(root, 'p', 'shop-brass')
  const strip = add(root, 'div')
  const list = add(root, 'div', 'pick-grid')

  const claimed = { brass: false, special: room.special === null, attachment: false }

  const refresh = (): void => {
    sub.textContent = '보유 탄피 ' + fmtInt(run.loadout.brass)
    clear(strip)
    strip.appendChild(loadoutStrip(run.loadout, bin))
  }

  /** 항목 한 줄. 가져가면 흐려지고 '획득' 으로 잠긴다 */
  const rowOf = (
    icon: HTMLElement,
    name: string,
    text: string,
    metaText: string,
    rarityCls: string,
    done: () => boolean,
    take: () => void,
  ): void => {
    const row = add(list, 'div', 'pick' + (rarityCls !== '' ? ' r-' + rarityCls : ''))
    row.appendChild(icon)
    const body = add(row, 'div', 'pick-body')
    add(body, 'div', 'pick-name', name)
    add(body, 'div', 'pick-text', text)
    const meta = add(body, 'div', 'pick-meta')
    const tag = add(meta, 'span', 'slotname', metaText)
    const mark = (): void => {
      if (!done()) return
      row.style.opacity = '0.4'
      row.style.pointerEvents = 'none'
      tag.textContent = '획득함'
      tag.style.color = 'var(--brass)'
    }
    bin.add(
      on(row, 'click', () => {
        if (done()) return
        take()
        refresh()
        mark()
      }),
    )
    mark()
  }

  const render = (): void => {
    clear(list)

    // ① 탄피
    const brassIcon = document.createElement('div')
    brassIcon.className = 'pick-icon'
    const bt = add(brassIcon, 'div', 'card-type', '탄피')
    bt.style.color = 'var(--brass)'
    const bg = add(brassIcon, 'div', 'card-grade', '+' + room.brass)
    bg.style.color = 'var(--brass)'
    bg.style.fontSize = '15px'
    rowOf(
      brassIcon,
      '탄피 +' + fmtInt(room.brass),
      '정비소와 성소에서 쓴다.',
      '재화',
      '',
      () => claimed.brass,
      () => {
        toast(claimBrass(run, room.brass))
        claimed.brass = true
      },
    )

    // ② 특수탄
    const sp = room.special
    if (sp !== null) {
      rowOf(
        specialIcon(sp.def.id),
        sp.def.name + ' ×' + sp.count,
        sp.def.text,
        '특수탄 · DMG ' + sp.def.dmg + ' · HEAT +' + sp.def.heat.toFixed(2),
        sp.def.rarity,
        () => claimed.special,
        () => {
          toast(claimSpecial(run, sp.def, sp.count), 2200)
          claimed.special = true
        },
      )
    }

    // ③ 부착물 3택
    const box = document.createElement('div')
    box.className = 'pick-icon'
    const t = add(box, 'div', 'card-type', '부착물')
    t.style.fontSize = '9px'
    add(box, 'div', 'card-grade', String(room.attachments.length))
    const best = room.attachments.length > 0 ? room.attachments[0]!.rarity : ''
    rowOf(
      box,
      '부착물 ' + room.attachments.length + '종 중 하나',
      room.attachments.map((a) => a.name).join(' · ') || '남은 부착물이 없다.',
      '눌러서 고른다',
      best,
      () => claimed.attachment,
      () => {
        void (async (): Promise<void> => {
          const a = await pickAttachment(host, room.attachments)
          if (a === null) return
          toast(claimAttachment(run, a), 2200)
          claimed.attachment = true
          refresh()
          render()
        })()
      },
    )
  }

  refresh()
  render()

  return new Promise<void>((resolve) => {
    add(root, 'div', 'spacer')
    const go = button(buttonRow(root), '계속', { kind: 'primary', grow: 1 })
    bin.add(
      on(go, 'click', () => {
        // 안 가져간 게 있으면 한 번만 되묻는다 — 실수로 버리는 일은 막고, 고집은 존중한다
        const left = (!claimed.brass ? 1 : 0) + (!claimed.special ? 1 : 0) + (!claimed.attachment ? 1 : 0)
        if (left > 0 && go.dataset['warned'] !== '1') {
          go.dataset['warned'] = '1'
          toast('아직 안 챙긴 보상이 ' + left + '개 있다. 한 번 더 누르면 두고 간다.', 2400)
          return
        }
        sc.close()
        resolve()
      }),
    )
  })
}

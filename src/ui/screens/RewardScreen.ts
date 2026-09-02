// 전투 보상방 — 부착물/특수탄 중 하나를 무료로 고른다. 건너뛰면 탄피를 받는다.
import type { RewardItem, RunState } from '../../core/types'
import { applyReward } from '../../core/run'
import { skipRewardBrass } from '../../core/economy'
import { SLOT_LABEL } from '../../core/types'
import { add, fmtInt, on } from '../dom'
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

export interface RewardPick {
  pick: number | null
}

export function showRewards(
  host: HTMLElement,
  run: RunState,
  items: RewardItem[],
  brass: number,
): Promise<RewardPick> {
  const sc = openScreen(host, '보상')
  const { root, bin } = sc

  header(root, '전리품', '탄피 +' + fmtInt(brass) + ' · 보유 ' + fmtInt(run.loadout.brass))
  root.appendChild(loadoutStrip(run.loadout, bin))

  return new Promise<RewardPick>((resolve) => {
    const finish = (pick: number | null): void => {
      sc.close()
      resolve({ pick })
    }

    const grid = add(root, 'div', 'pick-grid')
    items.forEach((item, i) => {
      const row = add(grid, 'div', 'pick r-' + (item.t === 'attachment' ? item.attachment.rarity : item.special.rarity))

      if (item.t === 'attachment') {
        const a = item.attachment
        row.appendChild(attachmentIcon(a))
        const body = add(row, 'div', 'pick-body')
        add(body, 'div', 'pick-name', a.name)
        add(body, 'div', 'pick-text', a.text)
        const meta = add(body, 'div', 'pick-meta')
        meta.appendChild(rarityTag(a.rarity))
        add(meta, 'span', 'slotname', '부착물 · ' + SLOT_LABEL[a.slot])
        const m = modsText(a)
        if (m !== null) {
          const line = add(body, 'div', 'pick-text', m)
          line.style.color = 'var(--brass-dim)'
        }
      } else {
        const def = item.special
        row.appendChild(specialIcon(def.id))
        const body = add(row, 'div', 'pick-body')
        add(body, 'div', 'pick-name', def.name + ' ×' + item.count)
        add(body, 'div', 'pick-text', def.text)
        const meta = add(body, 'div', 'pick-meta')
        meta.appendChild(rarityTag(def.rarity))
        add(meta, 'span', 'slotname', '특수탄 · DMG ' + def.dmg + ' · HEAT +' + def.heat.toFixed(2))
      }

      bin.add(
        on(row, 'click', () => {
          const msg = applyReward(run, item)
          toast(msg, 2200)
          finish(i)
        }),
      )
    })

    add(root, 'div', 'spacer')
    const skipGain = skipRewardBrass(run.stake)
    const rowBtn = buttonRow(root)
    const skip = button(rowBtn, '건너뛰기', {
      kind: 'ghost',
      grow: 1,
      sub: skipGain > 0 ? '탄피 +' + skipGain : '보상 없음',
    })
    bin.add(
      on(skip, 'click', () => {
        if (skipGain > 0) {
          run.loadout.brass += skipGain
          run.stats.brassEarned += skipGain
        }
        finish(null)
      }),
    )
  })
}

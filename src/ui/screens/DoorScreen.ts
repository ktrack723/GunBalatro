// 갈림길 — 문 2개. 위험도 ◆ / 적 이름 / 패시브 / 보상 레어도 점만 보여준다.
// ★ HP 수치는 절대 표시하지 않는다 (기획 의도: 위험은 숫자가 아니라 분위기로 읽혀야 한다).

import type { DoorOption, RunState, Threat } from '../../core/types'
import { ARCH_BY_ID, PASSIVE_BY_ID } from '../../core/data/enemies'
import { add, fmtInt, on } from '../dom'
import { infoPop } from '../popover'
import {
  button,
  buttonRow,
  header,
  loadoutStrip,
  openScreen,
  rarityColor,
  rarityDots,
  rarityName,
  showLoadout,
} from './LoadoutSheet'

/** ◆ 채움 + ◇ 빈칸 */
function threatMark(t: Threat): string {
  return '◆'.repeat(t) + '◇'.repeat(3 - t)
}

const THREAT_MOOD: Record<Threat, string> = {
  1: '문틈에서 흰빛. 조용하다.',
  2: '주황빛이 새어나온다. 뭔가 있다.',
  3: '붉은 빛. 피 냄새가 진하다.',
}

function archName(d: DoorOption): string {
  if (d.archetype !== null) {
    const a = ARCH_BY_ID[d.archetype]
    if (a !== undefined) return a.name
  }
  return d.label
}

function archFlavor(d: DoorOption): string | null {
  if (d.archetype === null) return null
  const a = ARCH_BY_ID[d.archetype]
  return a !== undefined ? a.flavor : null
}

export function showDoors(host: HTMLElement, run: RunState, doors: DoorOption[]): Promise<number> {
  const sc = openScreen(host, '갈림길')
  const { root, bin } = sc

  header(root, '갈림길', '섹터 ' + run.sector + ' · 노드 ' + (run.nodeIndex + 1) + '/5')

  // --- 이번 섹터 보스 미리 공개 (섹터 시작에서 특히 크게) ---
  if (run.bossPassiveId !== null) {
    const p = PASSIVE_BY_ID[run.bossPassiveId]
    if (p !== undefined) {
      const banner = add(root, 'div', 'pick')
      const first = run.nodeIndex === 0
      banner.style.borderColor = first ? '#7d2229' : 'var(--line)'
      banner.style.background = first ? '#160d0f' : 'var(--bg-panel)'
      const body = add(banner, 'div', 'pick-body')
      add(body, 'div', 'pick-name', '이번 섹터 보스: ' + p.name)
      add(body, 'div', 'pick-text', p.text)
      banner.setAttribute('aria-label', '이번 섹터 보스 패시브 ' + p.name + '. ' + p.text)
    }
  }

  // --- 문 2개 ---
  const box = add(root, 'div', 'doors')
  const buttons: HTMLElement[] = []

  doors.forEach((d, i) => {
    const door = add(box, 'div', 'door t' + d.threat)
    door.setAttribute('role', 'button')
    door.tabIndex = 0
    door.style.minHeight = '160px'

    add(door, 'div', 'door-threat', threatMark(d.threat))
    add(door, 'div', 'door-enemy', archName(d))

    const passive = d.passiveId !== null ? PASSIVE_BY_ID[d.passiveId] ?? null : null
    if (passive !== null) {
      const chip = add(door, 'div', 'passive-chip')
      add(chip, 'span', undefined, '「' + passive.name + '」')
      add(door, 'div', 'door-sub', passive.text)
    } else {
      const fl = archFlavor(d)
      if (fl !== null) add(door, 'div', 'door-sub', fl)
    }

    add(door, 'div', 'door-sub', THREAT_MOOD[d.threat])

    const rw = add(door, 'div', 'door-reward')
    const dots = add(rw, 'span', undefined, rarityDots(d.rewardHint))
    dots.style.color = rarityColor(d.rewardHint)
    dots.style.letterSpacing = '.08em'
    add(rw, 'span', undefined, ' 보상 ' + rarityName(d.rewardHint) + '급')

    door.setAttribute(
      'aria-label',
      '위험도 ' +
        d.threat +
        ', ' +
        archName(d) +
        (passive !== null ? ', 패시브 ' + passive.name : '') +
        ', 보상 ' +
        rarityName(d.rewardHint) +
        '급',
    )
    buttons.push(door)
  })

  // --- 참고 정보: 지금 내 빌드 ---
  add(root, 'div', 'spacer')
  const info = add(root, 'div')
  info.style.display = 'flex'
  info.style.flexDirection = 'column'
  info.style.gap = '6px'
  add(info, 'p', undefined, '탄피 ' + fmtInt(run.loadout.brass) + ' · 가방 ' + run.loadout.bag.length + '발')
  info.appendChild(loadoutStrip(run.loadout, bin))

  const row = buttonRow(root)
  const loadoutBtn = button(row, '장비 보기', { kind: 'ghost', grow: 1 })
  const helpBtn = button(row, '위험도란?', { kind: 'ghost', grow: 1 })

  let settled = false
  return new Promise<number>((resolve) => {
    const finish = (i: number): void => {
      if (settled) return
      settled = true
      sc.close()
      resolve(i)
    }

    buttons.forEach((el2, i) => {
      bin.add(on(el2, 'click', () => finish(i)))
      bin.add(
        on(el2, 'keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            finish(i)
          }
        }),
      )
    })

    bin.add(
      on(loadoutBtn, 'click', () => {
        void showLoadout(host, run)
      }),
    )
    bin.add(
      on(helpBtn, 'click', () => {
        void infoPop({
          title: '위험도 ◆',
          lines: [
            '◆ 가 많을수록 적이 단단하고 빠르다. 대신 보상 레어도와 탄피가 오른다.',
            '적의 체력 수치는 알려주지 않는다 — 문 앞에서 알 수 있는 것은 분위기뿐이다.',
          ],
          rows: [
            ['◆◇◇', '보상 3개 · 추가 탄피 없음'],
            ['◆◆◇', '보상 3개 · 탄피 +15'],
            ['◆◆◆', '보상 4개 · 탄피 +35'],
          ],
        })
      }),
    )
  })
}

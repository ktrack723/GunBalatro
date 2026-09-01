// 타이틀 화면.
// 첫 실행에서 광과민성 경고를 반드시 1회 노출하고 (PRESENTATION §6, WCAG 2.3.1),
// prefers-reduced-motion 이 감지되면 "약" 프리셋을 제안한다.

import { hashSeed } from '../../core/rng'
import { add, el, fmtInt, on } from '../dom'
import { confirmPop, popover } from '../popover'
import { loadMeta } from '../save'
import {
  hasAskedReducedMotion,
  hasSeenWarning,
  initSettings,
  loadSettings,
  markReducedMotionAsked,
  markWarningSeen,
  prefersReducedMotion,
  saveSettings,
  weakPreset,
} from '../settings'
import { button, header, openScreen, statRow } from './LoadoutSheet'

export type TitleAction = 'new' | 'continue' | 'settings' | 'seed'

export interface TitleResult {
  action: TitleAction
  /** action === 'seed' 일 때만 채워진다 */
  seed?: number
}

const WARN_LINES = [
  '이 게임은 사격할 때마다 화면 전체가 강하게 번쩍이고 흔들린다.',
  '광과민성 발작 병력이 있다면 설정에서 번쩍임과 흔들림을 "약" 또는 "끔"으로 두고 시작하라.',
  '연출 속도 ×3 을 고르면 번쩍임이 자동으로 "약"으로 내려간다.',
]

/** 첫 실행 안내 2종. 반드시 경고 → 모션 제안 순서로 한 번씩만 뜬다. */
async function firstLaunchDialogs(): Promise<void> {
  if (!hasSeenWarning()) {
    const r = await popover({
      title: '광과민성 발작 경고',
      lines: WARN_LINES,
      dismissible: false,
      actions: [
        { id: 'weak', label: '약하게 시작', kind: 'ghost', sub: '번쩍임·흔들림 약' },
        { id: 'ok', label: '확인', kind: 'primary' },
      ],
    })
    markWarningSeen()
    if (r === 'weak') saveSettings(weakPreset(loadSettings()))
  }

  if (prefersReducedMotion() && !hasAskedReducedMotion()) {
    markReducedMotionAsked()
    const yes = await confirmPop({
      title: '모션 감소가 켜져 있다',
      body: '기기 설정이 "동작 줄이기"다. 번쩍임·흔들림을 약으로, 색수차·왜곡을 끔으로 맞출까?',
      ok: '약 프리셋 적용',
      cancel: '그대로 둔다',
    })
    if (yes) saveSettings(weakPreset(loadSettings()))
  }
}

/** 시드 입력 다이얼로그. 숫자면 그대로, 문자열이면 해시해서 시드로 쓴다. */
async function askSeed(): Promise<number | null> {
  const wrap = el('div')
  const input = add(wrap, 'input')
  input.type = 'text'
  input.placeholder = '숫자 또는 아무 문구'
  input.setAttribute('inputmode', 'text')
  input.setAttribute('autocapitalize', 'off')
  input.setAttribute('autocomplete', 'off')
  input.style.width = '100%'
  input.style.minHeight = '44px'
  input.style.fontSize = '16px' // iOS 자동 확대 방지
  input.style.background = '#0b0d10'
  input.style.color = 'var(--text)'
  input.style.border = '1px solid var(--line)'
  input.style.borderRadius = '6px'
  input.style.padding = '0 10px'
  input.style.fontFamily = 'var(--font-num)'

  window.setTimeout(() => {
    try {
      input.focus()
    } catch {
      // 무시
    }
  }, 60)

  const r = await popover({
    title: '시드 입력',
    lines: ['같은 시드는 같은 판이다. 친구와 같은 복도를 걸을 수 있다.', wrap],
    actions: [
      { id: 'no', label: '취소', kind: 'ghost' },
      { id: 'yes', label: '시작', kind: 'primary' },
    ],
  })
  if (r !== 'yes') return null

  const raw = input.value.trim()
  if (raw === '') return Date.now() | 0
  if (/^-?\d+$/.test(raw)) return Number(raw) | 0
  return hashSeed(raw)
}

export function showTitle(host: HTMLElement, opts: { hasSave: boolean }): Promise<TitleResult> {
  initSettings() // 글자 크기·색맹 패턴 등을 body 에 반영
  const sc = openScreen(host, '타이틀')
  const { root, bin } = sc

  header(root, 'GUNBALATRO', '탄을 어떤 순서로 넣느냐가 전부다')

  const meta = loadMeta()
  const stats = add(root, 'div')
  stats.style.maxWidth = '360px'
  statRow(stats, '최고 도달 섹터', meta.bestSector > 0 ? '섹터 ' + meta.bestSector : '—')
  statRow(stats, '완주', fmtInt(meta.wins) + '회')
  statRow(stats, '시도', fmtInt(meta.runs) + '회')
  statRow(stats, '해금된 성전 등급', String(meta.unlockedStake))

  add(root, 'div', 'spacer')

  const menu = add(root, 'div', 'pick-grid')
  menu.style.maxWidth = '420px'
  menu.style.width = '100%'
  menu.style.alignSelf = 'center'

  const newBtn = button(menu, '새 게임', { kind: 'primary', sub: '섹터 1부터' })
  const contBtn = opts.hasSave
    ? button(menu, '이어하기', { kind: 'brass', sub: '마지막 노드에서' })
    : null
  const seedBtn = button(menu, '시드 입력', { sub: '같은 판을 다시' })
  const setBtn = button(menu, '설정', { kind: 'ghost', sub: '번쩍임 · 흔들림 · 속도' })

  const note = add(root, 'p', undefined, '⚠ 강한 섬광 연출이 있다. 설정에서 언제든 줄일 수 있다.')
  note.style.fontSize = '11px'
  note.style.color = 'var(--text-faint)'
  // 하단 12pt 는 홈 인디케이터 몫 — .screen 의 safe-area 패딩이 이미 비워 둔다.

  let settled = false
  return new Promise<TitleResult>((resolve) => {
    const finish = (r: TitleResult): void => {
      if (settled) return
      settled = true
      sc.close()
      resolve(r)
    }

    bin.add(on(newBtn, 'click', () => finish({ action: 'new' })))
    if (contBtn !== null) bin.add(on(contBtn, 'click', () => finish({ action: 'continue' })))
    bin.add(on(setBtn, 'click', () => finish({ action: 'settings' })))
    bin.add(
      on(seedBtn, 'click', () => {
        void (async (): Promise<void> => {
          const seed = await askSeed()
          if (seed === null || settled) return
          finish({ action: 'seed', seed })
        })()
      }),
    )

    // 첫 실행 안내는 화면이 떠 있는 상태에서 위에 얹힌다.
    void firstLaunchDialogs()
  })
}

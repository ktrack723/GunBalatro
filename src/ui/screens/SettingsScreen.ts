// 설정 — PRESENTATION.md §6 표의 7항목 전부. 고르는 즉시 저장·즉시 반영된다.
// 안전 옵션은 타협 대상이 아니므로 되돌리기/확인 절차 없이 바로 먹힌다.

import { add, on } from '../dom'
import { infoPop, isPopoverOpen } from '../popover'
import { toast } from '../toast'
import {
  type FlashLevel,
  type Settings,
  type ShakeLevel,
  type SpeedLevel,
  initSettings,
  loadSettings,
  patchSettings,
  prefersReducedMotion,
} from '../settings'
import { button, buttonRow, header, openScreen, section } from './LoadoutSheet'

interface Choice<T> {
  label: string
  value: T
}

export function showSettings(host: HTMLElement): Promise<void> {
  initSettings() // 저장된 설정을 DOM 에 한 번 더 반영 (부팅 경로가 빠져도 안전하게)
  const sc = openScreen(host, '설정')
  const { root, bin } = sc

  header(root, '설정', '접근성과 연출 강도. 언제든 바꿀 수 있다.')

  const refreshers: Array<() => void> = []

  /** 옵션 한 덩어리: 제목 + 설명 + 세그먼트 버튼 */
  function block<T>(
    title: string,
    desc: string,
    choices: Choice<T>[],
    read: (s: Settings) => T,
    write: (v: T) => void,
  ): void {
    const box = add(root, 'div', 'pick')
    box.style.flexDirection = 'column'
    box.style.alignItems = 'stretch'
    box.style.gap = '8px'

    const body = add(box, 'div', 'pick-body')
    add(body, 'div', 'pick-name', title)
    add(body, 'div', 'pick-text', desc)

    const seg = add(box, 'div')
    seg.style.display = 'flex'
    seg.style.gap = '6px'
    seg.setAttribute('role', 'group')
    seg.setAttribute('aria-label', title)

    const btns: HTMLButtonElement[] = []
    for (const c of choices) {
      const b = add(seg, 'button', 'btn')
      b.type = 'button'
      b.style.flex = '1'
      b.style.minWidth = '56px'
      b.style.minHeight = '44px'
      add(b, 'span', undefined, c.label)
      btns.push(b)
      bin.add(
        on(b, 'click', () => {
          write(c.value)
          for (const fn of refreshers) fn()
        }),
      )
    }

    const refresh = (): void => {
      const cur = read(loadSettings())
      choices.forEach((c, i) => {
        const on2 = c.value === cur
        btns[i].className = on2 ? 'btn brass' : 'btn ghost'
        btns[i].setAttribute('aria-pressed', on2 ? 'true' : 'false')
      })
    }
    refreshers.push(refresh)
    refresh()
  }

  section(root, '광과민성 · 모션')

  const FLASH: Choice<FlashLevel>[] = [
    { label: '강', value: 'strong' },
    { label: '약', value: 'weak' },
    { label: '끔', value: 'off' },
  ]
  block<FlashLevel>(
    '화면 번쩍임',
    '사격 순간의 풀스크린 백색 플래시. 약 = α 0.25 · 지속 2배, 끔 = 총구 발광만.',
    FLASH,
    (s) => s.flash,
    (v) => {
      patchSettings({ flash: v })
    },
  )

  const SHAKE: Choice<ShakeLevel>[] = [
    { label: '강', value: 'strong' },
    { label: '약', value: 'weak' },
    { label: '끔', value: 'off' },
  ]
  block<ShakeLevel>(
    '화면 흔들림',
    '반동·셰이크 진폭. 약 = 30%, 끔 = 카메라가 전혀 흔들리지 않는다.',
    SHAKE,
    (s) => s.shake,
    (v) => {
      patchSettings({ shake: v })
    },
  )

  block<boolean>(
    '색수차 · 왜곡',
    '색수차와 총열 열왜곡. 끔을 고르면 화면 후처리가 전부 꺼진다.',
    [
      { label: '켬', value: true },
      { label: '끔', value: false },
    ],
    (s) => s.distort,
    (v) => {
      patchSettings({ distort: v })
    },
  )

  section(root, '연출')

  const SPEED: Choice<SpeedLevel>[] = [
    { label: '×1', value: 1 },
    { label: '×2', value: 2 },
    { label: '×3', value: 3 },
    { label: '즉시', value: 999 },
  ]
  block<SpeedLevel>(
    '연출 속도',
    '사격 시퀀스 재생 속도. ×3 은 초당 7회 번쩍임이라 번쩍임이 자동으로 "약"으로 내려간다.',
    SPEED,
    (s) => s.speed,
    (v) => {
      const before = loadSettings().flash
      const after = patchSettings({ speed: v })
      if (before === 'strong' && after.flash === 'weak') {
        toast('안전을 위해 번쩍임을 "약"으로 내렸다 (WCAG 2.3.1)', 2400)
      }
    },
  )

  block<boolean>(
    '햅틱',
    '발사 순간 진동. iOS 사파리는 진동 API 가 없어 조용히 무시된다.',
    [
      { label: '켬', value: true },
      { label: '끔', value: false },
    ],
    (s) => s.haptic,
    (v) => {
      patchSettings({ haptic: v })
    },
  )

  section(root, '표시')

  block<boolean>(
    '색맹 패턴',
    '탄종에 사선 / 점 / 격자 / 무지 패턴을 덧씌워 색 없이도 구분되게 한다.',
    [
      { label: '끔', value: false },
      { label: '켬', value: true },
    ],
    (s) => s.colorblind,
    (v) => {
      patchSettings({ colorblind: v })
    },
  )

  block<boolean>(
    '글자 크기',
    '표준 / 크게(+15%). 작은 화면에서 트레이 카드 글자까지 함께 커진다.',
    [
      { label: '표준', value: false },
      { label: '크게', value: true },
    ],
    (s) => s.bigText,
    (v) => {
      patchSettings({ bigText: v })
    },
  )

  const notes = add(root, 'div')
  const n1 = add(
    notes,
    'p',
    undefined,
    prefersReducedMotion()
      ? '기기의 "동작 줄이기"가 켜져 있다. 약 프리셋을 권한다.'
      : '모든 소리 정보에는 시각 대응물이 있다. 무음으로도 완주할 수 있다.',
  )
  n1.style.fontSize = '11px'
  const n2 = add(
    notes,
    'p',
    undefined,
    'iOS 는 무음 스위치가 켜져 있으면 소리가 나지 않는다. 스위치를 확인하라.',
  )
  n2.style.fontSize = '11px'
  n2.style.color = 'var(--text-faint)'

  add(root, 'div', 'spacer')
  const row = buttonRow(root)
  const warnBtn = button(row, '광과민성 경고 다시 보기', { kind: 'ghost', grow: 1 })
  const closeBtn = button(row, '닫기', { kind: 'primary', grow: 1 })

  let settled = false
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      if (settled) return
      settled = true
      sc.close()
      resolve()
    }
    bin.add(
      on(warnBtn, 'click', () => {
        void infoPop({
          title: '광과민성 발작 경고',
          lines: [
            '이 게임은 사격할 때마다 화면 전체가 강하게 번쩍인다.',
            '광과민성 발작 병력이 있다면 번쩍임과 흔들림을 "약" 또는 "끔"으로 두고 플레이하라.',
            'WCAG 2.3.1 기준(초당 3회 초과 섬광 회피)을 위해 ×3 속도에서는 번쩍임이 자동으로 약해진다.',
          ],
        })
      }),
    )
    bin.add(on(closeBtn, 'click', finish))
    bin.add(
      on(window, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !isPopoverOpen()) finish()
      }),
    )
  })
}

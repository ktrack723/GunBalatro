// 팝오버 (탄 상세 / 확인 다이얼로그). style.css 의 .pop-back / .pop 을 쓴다.
// 동시에 하나만 열린다 — 새로 열면 이전 것은 dismiss 로 닫힌다.

import { add, el, on, type Off } from './dom'

export interface PopAction {
  id: string
  label: string
  /** .btn 의 변형 클래스 */
  kind?: 'primary' | 'ghost' | 'brass'
  /** 버튼 아래 작은 보조 문구 */
  sub?: string
}

export interface PopOptions {
  title: string
  /** 본문 문단들 */
  lines?: (string | HTMLElement)[]
  /** 라벨/값 표 (.stat-row) */
  rows?: Array<[string, string]>
  actions?: PopAction[]
  /** 붙일 부모. 기본은 #ui */
  host?: HTMLElement
  /** 배경 탭/ESC 로 닫을 수 있는가 (기본 true) */
  dismissible?: boolean
  /** 제목 색 (탄종 색 등) */
  accent?: string
}

interface OpenPop {
  back: HTMLElement
  offs: Off[]
  close: (id: string | null) => void
}

let current: OpenPop | null = null

export function isPopoverOpen(): boolean {
  return current !== null
}

/** 열려 있으면 dismiss(null) 로 닫는다. */
export function closePopover(): void {
  if (current !== null) current.close(null)
}

/**
 * 팝오버를 띄우고 눌린 액션 id 를 돌려준다.
 * 배경 탭/ESC/외부 close 는 null.
 */
export function popover(o: PopOptions): Promise<string | null> {
  closePopover()

  const parent =
    o.host ?? (document.getElementById('ui') as HTMLElement | null) ?? document.body

  const back = el('div', 'pop-back')
  back.setAttribute('role', 'dialog')
  back.setAttribute('aria-modal', 'true')

  const pop = add(back, 'div', 'pop')

  const title = add(pop, 'div', 'pick-name', o.title)
  title.style.fontSize = '15px'
  if (o.accent !== undefined) title.style.color = o.accent

  if (o.lines !== undefined) {
    for (const l of o.lines) {
      if (typeof l === 'string') {
        add(pop, 'div', 'pick-text', l).style.fontSize = '12px'
      } else {
        pop.appendChild(l)
      }
    }
  }

  if (o.rows !== undefined && o.rows.length > 0) {
    const box = add(pop, 'div')
    for (const [k, v] of o.rows) {
      const r = add(box, 'div', 'stat-row')
      add(r, 'span', undefined, k)
      add(r, 'span', undefined, v)
    }
  }

  const acts = o.actions ?? [{ id: 'ok', label: '닫기' }]
  const bar = add(pop, 'div')
  bar.style.display = 'flex'
  bar.style.gap = '8px'
  bar.style.marginTop = '4px'

  const offs: Off[] = []
  let settle: ((v: string | null) => void) | null = null

  const close = (id: string | null): void => {
    if (current === null || current.back !== back) return
    current = null
    for (const off of offs) off()
    offs.length = 0
    back.remove()
    const s = settle
    settle = null
    if (s !== null) s(id)
  }

  for (const a of acts) {
    const b = add(bar, 'button', 'btn' + (a.kind !== undefined ? ' ' + a.kind : ''))
    b.type = 'button'
    add(b, 'span', undefined, a.label)
    if (a.sub !== undefined) add(b, 'small', undefined, a.sub)
    offs.push(on(b, 'click', () => close(a.id)))
  }

  const dismissible = o.dismissible !== false
  offs.push(
    on(back, 'pointerdown', (e: PointerEvent) => {
      if (e.target === back && dismissible) close(null)
    }),
  )
  offs.push(
    on(window, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) close(null)
    }),
  )

  parent.appendChild(back)
  current = { back, offs, close }

  return new Promise<string | null>((resolve) => {
    settle = resolve
  })
}

/** 예/아니오. 기본 액션은 취소(=false) 쪽이 왼쪽. */
export async function confirmPop(o: {
  title: string
  body?: string
  ok?: string
  cancel?: string
  host?: HTMLElement
  rows?: Array<[string, string]>
}): Promise<boolean> {
  const r = await popover({
    title: o.title,
    lines: o.body !== undefined ? [o.body] : undefined,
    rows: o.rows,
    host: o.host,
    actions: [
      { id: 'no', label: o.cancel ?? '취소', kind: 'ghost' },
      { id: 'yes', label: o.ok ?? '확인', kind: 'primary' },
    ],
  })
  return r === 'yes'
}

/** 정보만 보여주고 닫는다. */
export async function infoPop(o: {
  title: string
  lines?: (string | HTMLElement)[]
  rows?: Array<[string, string]>
  host?: HTMLElement
  accent?: string
}): Promise<void> {
  await popover({
    title: o.title,
    lines: o.lines,
    rows: o.rows,
    host: o.host,
    accent: o.accent,
    actions: [{ id: 'ok', label: '닫기', kind: 'ghost' }],
  })
}

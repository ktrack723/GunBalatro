// 작은 DOM 헬퍼. 프레임워크 없이 순수 DOM 을 다루기 위한 최소 도구만 둔다.
// 여기 있는 것은 전부 부작용이 없거나(el/fmt) 해제 함수를 돌려준다(on).

export type Off = () => void

/** 요소 생성. class 와 textContent 만 받는다 (그 이상은 호출부에서). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls !== undefined && cls !== '') n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** 생성 + 부모에 붙이기. 중첩 구조를 한 줄로 쓰기 위한 설탕. */
export function add<K extends keyof HTMLElementTagNameMap>(
  parent: Node,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = el(tag, cls, text)
  parent.appendChild(n)
  return n
}

/** 자식 전부 제거. innerHTML='' 보다 빠르고 안전하다. */
export function clear(node: Node): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild)
}

/**
 * 리스너 등록 후 "해제 함수"를 돌려준다.
 * destroy() 에서 이 함수들만 전부 호출하면 누수가 없다.
 */
export function on<T extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (ev: T) => void,
  opts?: AddEventListenerOptions | boolean,
): Off {
  const h = handler as unknown as EventListener
  target.addEventListener(type, h, opts)
  return () => target.removeEventListener(type, h, opts)
}

/** 해제 함수 보관함. 뷰 하나가 만든 리스너/타이머를 한 번에 정리한다. */
export class Bin {
  private offs: Off[] = []

  add(off: Off): void {
    this.offs.push(off)
  }

  /** window.setTimeout 을 보관함에 등록한다 (destroy 시 자동 취소) */
  timer(fn: () => void, ms: number): number {
    const id = window.setTimeout(fn, ms)
    this.offs.push(() => window.clearTimeout(id))
    return id
  }

  clear(): void {
    for (let i = this.offs.length - 1; i >= 0; i -= 1) {
      try {
        this.offs[i]()
      } catch {
        // 해제 중 예외는 무시한다 — 나머지 해제를 막으면 안 된다
      }
    }
    this.offs.length = 0
  }
}

// ---------------------------------------------------------------------------
// 길게 누르기 (꾹 눌러 설명 보기)
// ---------------------------------------------------------------------------

/**
 * 길게 눌렀다가 뗀 직후의 click 을 삼키는 전역 캡처 리스너.
 *
 * 요소에 직접 붙이면 순서 문제가 생긴다 — 타깃 단계에서는 캡처든 버블이든
 * **등록 순서**로 실행되므로, 이미 걸려 있는 click 핸들러보다 늦게 등록되면
 * 못 막는다. window 캡처는 언제나 가장 먼저 돌기 때문에 확실하다.
 */
let swallowNode: HTMLElement | null = null
let swallowUntil = 0
let swallowInstalled = false

function installSwallow(): void {
  if (swallowInstalled || typeof window === 'undefined') return
  swallowInstalled = true
  window.addEventListener(
    'click',
    (e) => {
      const node = swallowNode
      if (node === null) return
      swallowNode = null
      if (performance.now() >= swallowUntil) return
      // **누른 그 요소를 향한 클릭 하나만** 삼킨다.
      // 시간 창만 두면 설명이 뜬 직후 '닫기' 를 빨리 누른 것까지 먹힌다.
      const t = e.target
      if (t instanceof Node && node.contains(t)) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    true,
  )
}

/**
 * 꾹 누르면 handler 를 부른다. 마우스 우클릭(contextmenu)도 같은 길로 보낸다.
 *
 * iOS 사파리는 평범한 div 에서 contextmenu 를 잘 쏘지 않고 대신 네이티브
 * 확대/복사 콜아웃을 띄운다 — 그래서 contextmenu 하나만 걸어 두면 폰에서
 * 설명이 아예 안 뜬다. pointer 이벤트로 직접 재는 이유다.
 * (콜아웃 자체는 CSS 의 -webkit-touch-callout:none 으로 막는다)
 */
export function longPress(node: HTMLElement, handler: () => void, ms = 360): Off {
  installSwallow()
  let timer = 0
  let sx = 0
  let sy = 0

  const cancel = (): void => {
    if (timer !== 0) {
      window.clearTimeout(timer)
      timer = 0
    }
  }
  const fire = (): void => {
    timer = 0
    // 손을 떼면서 나오는 click 이 '장전' 으로도 먹히면 안 된다
    swallowNode = node
    swallowUntil = performance.now() + 900
    handler()
  }

  const offs: Off[] = [
    on<PointerEvent>(node, 'pointerdown', (e) => {
      if (e.button > 0) return
      sx = e.clientX
      sy = e.clientY
      cancel()
      timer = window.setTimeout(fire, ms)
    }),
    on<PointerEvent>(node, 'pointermove', (e) => {
      if (timer === 0) return
      if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) cancel()
    }),
    on(node, 'pointerup', cancel),
    on(node, 'pointercancel', cancel),
    on(node, 'pointerleave', cancel),
    on(node, 'contextmenu', (e) => {
      e.preventDefault()
      cancel()
      fire()
    }),
  ]
  return () => {
    cancel()
    for (const off of offs) off()
  }
}

/** 클래스 토글 (조건부) */
export function setClass(node: Element, cls: string, onOff: boolean): void {
  node.classList.toggle(cls, onOff)
}

/** 1234567 → "1,234,567". toLocaleString 은 로케일에 따라 흔들려서 직접 만든다. */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const v = Math.round(n)
  const neg = v < 0
  const s = String(Math.abs(v))
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s[i]
  }
  return neg ? '-' + out : out
}

/** 1 → "①". 21 이상은 그냥 숫자. */
export function orderMark(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1)
  return String(n)
}

/** 이벤트 대상에서 가장 가까운 선택자 요소를 찾는다 (없으면 null) */
export function closestFrom(ev: Event, sel: string): HTMLElement | null {
  const t = ev.target
  if (t === null || !(t instanceof Element)) return null
  return t.closest(sel) as HTMLElement | null
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function pct(v: number): string {
  return (clamp(v, 0, 1) * 100).toFixed(2) + '%'
}

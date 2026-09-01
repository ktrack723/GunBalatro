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

// 짧은 안내 메시지. style.css 의 .toast-host / .toast 를 그대로 쓴다.
// 하단 홈 인디케이터를 피하려고 호스트는 bottom: sab+76px 에 떠 있다 (style.css).

import { add, clear, el } from './dom'

const MAX_TOASTS = 3

let host: HTMLElement | null = null
const timers = new Set<number>()

/** 토스트 호스트를 이 요소 안에 만든다. 보통 #ui. */
export function mountToasts(parent: HTMLElement): void {
  if (host !== null && host.parentElement === parent) return
  if (host !== null) host.remove()
  host = el('div', 'toast-host')
  host.setAttribute('aria-live', 'polite')
  parent.appendChild(host)
}

function ensureHost(): HTMLElement {
  if (host !== null && host.isConnected) return host
  const ui = document.getElementById('ui')
  mountToasts(ui instanceof HTMLElement ? ui : document.body)
  // mountToasts 가 반드시 host 를 만든다
  return host as HTMLElement
}

/** 토스트 1개. ms 뒤 자동 소멸. */
export function toast(text: string, ms = 1700): void {
  const h = ensureHost()
  while (h.childElementCount >= MAX_TOASTS && h.firstElementChild !== null) {
    h.firstElementChild.remove()
  }
  const t = add(h, 'div', 'toast', text)
  const id = window.setTimeout(() => {
    timers.delete(id)
    t.style.transition = 'opacity .18s linear, transform .18s ease-in'
    t.style.opacity = '0'
    t.style.transform = 'translateY(6px)'
    const id2 = window.setTimeout(() => {
      timers.delete(id2)
      t.remove()
    }, 200)
    timers.add(id2)
  }, Math.max(200, ms))
  timers.add(id)
}

export function clearToasts(): void {
  for (const id of timers) window.clearTimeout(id)
  timers.clear()
  if (host !== null) clear(host)
}

/** 화면 전환 시 호스트까지 걷어낸다. */
export function unmountToasts(): void {
  clearToasts()
  if (host !== null) host.remove()
  host = null
}

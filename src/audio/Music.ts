// ============================================================================
// Music.ts — 루프 BGM
//   효과음(ZzFX)은 코드로 합성하지만 음악은 파일이다. 6.3MB 라 **지연 로딩**한다:
//   HTMLAudioElement 는 스트리밍이라 다 받기 전에 재생이 시작된다.
//
//   iOS/Safari 는 사용자 제스처 밖에서 재생을 거부한다. 그래서 최초 터치에서
//   호출되는 unlock 경로(main.ts Audio.resume)에 물려 두고, 실패하면 조용히
//   다음 제스처를 기다린다 — 예외를 던져 게임을 멈추게 두지 않는다.
// ============================================================================

const SRC = 'music/crypt-neon.mp3'
/** 효과음이 위에 실려야 하므로 음악은 낮게 깐다 */
const TARGET_VOLUME = 0.34
const FADE_MS = 1400

let el: HTMLAudioElement | null = null
let enabled = true
/** 사용자가 이미 재생을 시작시켰나 (탭 복귀 시 다시 틀지 판단) */
let wanted = false
let fadeTimer = 0

function baseUrl(): string {
  // Vite 의 BASE_URL 은 항상 '/' 로 끝난다. GitHub Pages 에서는 '/GunBalatro/'.
  const b = import.meta.env.BASE_URL
  return typeof b === 'string' && b.length > 0 ? b : '/'
}

function ensure(): HTMLAudioElement | null {
  if (el !== null) return el
  if (typeof Audio === 'undefined') return null
  try {
    const a = new Audio()
    a.src = baseUrl() + SRC
    a.loop = true
    a.preload = 'none'
    a.volume = 0
    // 자동 크로스오리진 요청을 만들지 않는다 (같은 오리진 자산이다)
    a.crossOrigin = null
    el = a
    return a
  } catch {
    return null
  }
}

function stopFade(): void {
  if (fadeTimer !== 0) {
    window.clearInterval(fadeTimer)
    fadeTimer = 0
  }
}

/** 볼륨을 to 까지 서서히 옮긴다. 갑자기 켜지면 놀란다 */
function fadeTo(to: number, ms = FADE_MS): void {
  const a = el
  if (a === null) return
  stopFade()
  const from = a.volume
  const start = performance.now()
  fadeTimer = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / Math.max(1, ms))
    a.volume = from + (to - from) * t
    if (t >= 1) {
      stopFade()
      if (to <= 0) a.pause()
    }
  }, 40)
}

/**
 * 최초 사용자 제스처 안에서 부른다.
 * 이미 재생 중이면 아무 일도 하지 않는다.
 */
export function startMusic(): void {
  wanted = true
  if (!enabled) return
  const a = ensure()
  if (a === null) return
  if (!a.paused) return
  const p = a.play()
  if (p !== undefined && typeof p.then === 'function') {
    // 제스처 밖이면 거부된다 — 조용히 넘기고 다음 터치를 기다린다
    p.then(() => fadeTo(TARGET_VOLUME)).catch(() => undefined)
  } else {
    fadeTo(TARGET_VOLUME)
  }
}

export function setMusicEnabled(v: boolean): void {
  enabled = v
  if (!v) {
    stopFade()
    if (el !== null) {
      el.pause()
      el.volume = 0
    }
    return
  }
  if (wanted) startMusic()
}

/** 탭이 숨겨질 때 멈추고 돌아오면 다시 튼다 (배터리·백그라운드 재생 방지) */
export function pauseMusic(): void {
  stopFade()
  el?.pause()
}

export function resumeMusic(): void {
  if (!enabled || !wanted) return
  const a = el
  if (a === null || !a.paused) return
  const p = a.play()
  if (p !== undefined && typeof p.then === 'function') p.catch(() => undefined)
}

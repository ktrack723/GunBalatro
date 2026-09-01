// ============================================================================
// main.ts — 부팅 · rAF 루프 · iOS Safari 대응 (TECH.md §4)
//   앱 상태기계는 app/App.ts 가 갖는다. 여기서는 "돌아가게 만드는 배선"만 한다.
// ============================================================================
import { GameRenderer } from './view3d/Renderer'
import { App, type AudioHook } from './app/App'
import { initSettings } from './ui/settings'
import { mountToasts, toast } from './ui/toast'

// ---------------------------------------------------------------------------
// DOM 확보
// ---------------------------------------------------------------------------

function need<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const n = document.getElementById(id)
  if (!(n instanceof ctor)) throw new Error('#' + id + ' 가 없다')
  return n as T
}

const app = need('app', HTMLDivElement)
const canvas = need('scene', HTMLCanvasElement)
const ui = need('ui', HTMLDivElement)

/**
 * 연출 폴백 오버레이 (#flash / #heat-vignette).
 * style.css 가 pointer-events:none 을 걸어 두었지만 #ui 안에 넣으면
 * '#ui > * { pointer-events:auto }' 가 이겨서 화면 전체 입력이 막힌다 → #app 직계에 둔다.
 */
function mountFxLayers(): void {
  for (const id of ['flash', 'heat-vignette']) {
    if (document.getElementById(id) !== null) continue
    const n = document.createElement('div')
    n.id = id
    n.style.pointerEvents = 'none'
    app.appendChild(n)
  }
}

// ---------------------------------------------------------------------------
// 오디오 훅 — 소리는 아직 없다. iOS 자동재생 정책만 미리 뚫어 둔다.
//   첫 터치 핸들러 안에서 resume() 해야 이후 재생이 허용된다 (TECH §4).
// ---------------------------------------------------------------------------

class Audio implements AudioHook {
  private ctx: AudioContext | null = null
  private tried = false

  resume(): void {
    type Ctor = new () => AudioContext
    const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
    const Ctx = w.AudioContext ?? w.webkitAudioContext
    if (Ctx === undefined) return
    if (this.ctx === null) {
      if (this.tried) return
      this.tried = true
      try {
        this.ctx = new Ctx()
      } catch {
        return // 사용자 제스처 밖이면 실패한다. 다음 터치에서 다시 시도하지 않는다.
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined)
  }

  /** 발행 id: heat.stage.* / bolt.back / bolt.forward / reload.start */
  play(_id: string): void {
    // 사운드 미구현 (PRESENTATION §7). 모든 정보에 시각 대응물이 있으므로 무음으로 완주 가능하다.
  }
}

// ---------------------------------------------------------------------------
// 부팅
// ---------------------------------------------------------------------------

initSettings()
mountFxLayers()
mountToasts(ui)
// .toast-host 는 CSS 상 pointer-events:none 이지만 '#ui > *' 규칙이 auto 로 덮어쓴다.
// 그대로 두면 토스트가 떠 있는 1.7초 동안 트레이 상단 탭이 먹히지 않는다.
const toastHost = ui.querySelector<HTMLElement>('.toast-host')
if (toastHost !== null) toastHost.style.pointerEvents = 'none'

let renderer: GameRenderer | null = null
try {
  renderer = new GameRenderer(canvas)
} catch (e) {
  console.error('[webgl]', e)
  canvas.style.display = 'none'
  toast('WebGL 을 쓸 수 없다. 3D 없이 진행한다.', 4000)
}

const audio = new Audio()
const game = new App({ ui, canvas, renderer, audio })

// --- 첫 터치에서 AudioContext resume (iOS) ---------------------------------
const firstTouch = (): void => {
  audio.resume()
  window.removeEventListener('pointerdown', firstTouch)
  window.removeEventListener('touchstart', firstTouch)
}
window.addEventListener('pointerdown', firstTouch, { passive: true })
window.addEventListener('touchstart', firstTouch, { passive: true })

// --- 리사이즈: 100dvh + visualViewport (주소창 개폐) ------------------------
// iOS 는 주소창이 접히는 동안 dvh / visualViewport 가 몇 번에 걸쳐 바뀐다.
// resize 이벤트 1회에 한 번만 반응하면 최종 크기를 놓치므로 잠시 뒤 두 번 더 확정한다.
let resizeRaf = 0
const resizeTimers: number[] = []
const applyLayout = (): void => {
  renderer?.resize()
  game.onResize()
}
const relayout = (): void => {
  if (resizeRaf === 0) {
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      applyLayout()
    })
  }
  for (const t of resizeTimers) window.clearTimeout(t)
  resizeTimers.length = 0
  resizeTimers.push(window.setTimeout(applyLayout, 140), window.setTimeout(applyLayout, 420))
}
window.addEventListener('resize', relayout)
window.addEventListener('orientationchange', relayout)
window.visualViewport?.addEventListener('resize', relayout)
window.visualViewport?.addEventListener('scroll', relayout)

// --- 더블탭 확대 방지 (user-scalable=no 를 무시하는 iOS 대비) ---------------
let lastTouchEnd = 0
document.addEventListener(
  'touchend',
  (e) => {
    const now = Date.now()
    if (now - lastTouchEnd < 300) e.preventDefault()
    lastTouchEnd = now
  },
  { passive: false },
)
// 핀치 확대도 막는다 (iOS 전용 이벤트)
for (const t of ['gesturestart', 'gesturechange']) {
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false })
}
// 바운스/당겨서 새로고침 방지는 CSS(overscroll-behavior/touch-action)가 이미 한다.
// 캔버스에서 시작한 스크롤만 추가로 막는다 (.screen 내부 스크롤은 살려야 한다).
canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false })

// --- WebGL 컨텍스트 손실 안내 (복구 자체는 Renderer 가 한다) ----------------
canvas.addEventListener('webglcontextlost', () => toast('그래픽 컨텍스트를 잃었다. 복구 중…'))
canvas.addEventListener('webglcontextrestored', () => toast('그래픽이 복구됐다'))

// --- rAF 루프 --------------------------------------------------------------
let raf = 0
let last = performance.now()

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
  last = now
  game.frame(dt)
  if (renderer !== null) {
    renderer.autoQualityTick(dt)
    renderer.render(dt)
  }
}

function start(): void {
  if (raf !== 0) return
  last = performance.now()
  raf = requestAnimationFrame(frame)
}

function stop(): void {
  if (raf === 0) return
  cancelAnimationFrame(raf)
  raf = 0
}

// --- 백그라운드 진입: rAF 정지 + 저장 (TECH §4) ----------------------------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stop()
    game.onHidden()
  } else {
    start()
  }
})
window.addEventListener('pagehide', () => {
  stop()
  game.onHidden()
})

// --- 개발용 핸들 (#dev 일 때만) ---------------------------------------------
if (location.hash.includes('dev')) {
  ;(window as unknown as Record<string, unknown>)['__gb'] = { renderer, game, audio }
}

// --- 시작 -------------------------------------------------------------------
// 최초 DOM 레이아웃이 끝난 뒤 한 번 리사이즈해야 캔버스 크기가 정확하다.
requestAnimationFrame(() => {
  renderer?.resize()
  game.onResize()
})
start()
void game.boot()

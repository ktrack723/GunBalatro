// 접근성·연출 설정 — PRESENTATION.md §6 표의 7항목이 전부 여기 있다.
// 저장 키는 'gb.settings' 하나. 설정값과 "첫 실행 안내를 봤는가" 플래그를 함께 담는다.
// 이 파일은 DOM/localStorage 에만 의존한다 (core 를 부르지 않는다).

const KEY = 'gb.settings'
const VERSION = 1

export type FlashLevel = 'strong' | 'weak' | 'off'
export type ShakeLevel = 'strong' | 'weak' | 'off'
/** 999 = 즉시 결과 */
export type SpeedLevel = 1 | 2 | 3 | 999

export interface Settings {
  flash: FlashLevel
  shake: ShakeLevel
  distort: boolean
  speed: SpeedLevel
  haptic: boolean
  colorblind: boolean
  bigText: boolean
  /** 효과음 (ZzFX 절차 생성) */
  sound: boolean
  /** 배경 음악 (루프) */
  music: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  flash: 'strong',
  shake: 'strong',
  distort: true,
  speed: 1,
  haptic: true,
  colorblind: false,
  bigText: false,
  sound: true,
  music: true,
}

/** 저장 레코드. 설정 외에 1회성 안내 플래그를 같이 들고 있다. */
interface Stored {
  v: number
  s: Settings
  /** 광과민성 경고를 봤는가 */
  warned: boolean
  /** prefers-reduced-motion 제안을 이미 물어봤는가 */
  rmAsked: boolean
}

// ---------------------------------------------------------------------------
// 파싱 (localStorage 는 언제든 오염될 수 있다고 가정한다)
// ---------------------------------------------------------------------------

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function pickStr<T extends string>(v: unknown, allowed: readonly T[], fb: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fb
}

function pickBool(v: unknown, fb: boolean): boolean {
  return typeof v === 'boolean' ? v : fb
}

const FLASHES: readonly FlashLevel[] = ['strong', 'weak', 'off']
const SHAKES: readonly ShakeLevel[] = ['strong', 'weak', 'off']
const SPEEDS: readonly SpeedLevel[] = [1, 2, 3, 999]

function pickSpeed(v: unknown): SpeedLevel {
  if (typeof v === 'number') {
    for (const s of SPEEDS) if (s === v) return s
  }
  return DEFAULT_SETTINGS.speed
}

function parseSettings(v: unknown): Settings {
  if (!isRec(v)) return { ...DEFAULT_SETTINGS }
  return {
    flash: pickStr(v['flash'], FLASHES, DEFAULT_SETTINGS.flash),
    shake: pickStr(v['shake'], SHAKES, DEFAULT_SETTINGS.shake),
    distort: pickBool(v['distort'], DEFAULT_SETTINGS.distort),
    speed: pickSpeed(v['speed']),
    haptic: pickBool(v['haptic'], DEFAULT_SETTINGS.haptic),
    colorblind: pickBool(v['colorblind'], DEFAULT_SETTINGS.colorblind),
    bigText: pickBool(v['bigText'], DEFAULT_SETTINGS.bigText),
    sound: pickBool(v['sound'], DEFAULT_SETTINGS.sound),
    music: pickBool(v['music'], DEFAULT_SETTINGS.music),
  }
}

/**
 * 안전 규칙 (PRESENTATION §6): ×3(발당 140ms ≈ 7Hz)은 WCAG 2.3.1 의 초당 3회를 넘는다.
 * 그래서 ×3 을 고르면 플래시를 자동으로 "약"으로 강등한다. 설정 화면에도 그대로 보인다.
 */
function normalize(s: Settings): Settings {
  const out: Settings = { ...s }
  if (out.speed === 3 && out.flash === 'strong') out.flash = 'weak'
  return out
}

// ---------------------------------------------------------------------------
// 저장/로드
// ---------------------------------------------------------------------------

let cache: Settings | null = null
let warned = false
let rmAsked = false

function readStore(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    raw = null // 사파리 프라이빗 모드 등 — 기본값으로 간다
  }
  let parsed: unknown = null
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  if (isRec(parsed)) {
    // 설정은 버전이 달라도 필드 단위로 살려낸다 (런과 달리 폐기하지 않는다)
    cache = normalize(parseSettings(parsed['s']))
    warned = pickBool(parsed['warned'], false)
    rmAsked = pickBool(parsed['rmAsked'], false)
  } else {
    cache = { ...DEFAULT_SETTINGS }
    warned = false
    rmAsked = false
  }
}

function writeStore(): void {
  const rec: Stored = {
    v: VERSION,
    s: cache ?? { ...DEFAULT_SETTINGS },
    warned,
    rmAsked,
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(rec))
  } catch {
    // 저장 실패는 조용히 무시한다 — 게임은 계속되어야 한다
  }
}

/** 현재 설정. 리턴된 객체를 직접 수정하지 말 것 (복사 후 saveSettings). */
export function loadSettings(): Settings {
  if (cache === null) readStore()
  return cache as Settings
}

export function saveSettings(s: Settings): void {
  cache = normalize(s)
  writeStore()
  applySettings(cache)
  for (const fn of subs) {
    try {
      fn(cache)
    } catch {
      // 구독자 예외가 저장을 막으면 안 된다
    }
  }
}

/** 설정 일부만 바꿔 저장한다. */
export function patchSettings(p: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...p }
  saveSettings(next)
  return loadSettings()
}

// --- 변경 구독 (HUD/시퀀서가 즉시 반영하도록) --------------------------------

type Sub = (s: Settings) => void
const subs = new Set<Sub>()

export function subscribeSettings(fn: Sub): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

// ---------------------------------------------------------------------------
// 파생 값 — 연출 레이어가 쓰는 유일한 창구
// ---------------------------------------------------------------------------

/** 풀스크린 플래시 배율. 강 1 / 약 0.3 / 끔 0 */
export function flashIntensity(s: Settings = loadSettings()): number {
  return s.flash === 'strong' ? 1 : s.flash === 'weak' ? 0.3 : 0
}

/** 카메라 셰이크 배율. 강 1 / 약 0.3 / 끔 0 */
export function shakeIntensity(s: Settings = loadSettings()): number {
  return s.shake === 'strong' ? 1 : s.shake === 'weak' ? 0.3 : 0
}

/** 색수차·열왜곡 배율 (켬 1 / 끔 0) */
export function distortIntensity(s: Settings = loadSettings()): number {
  return s.distort ? 1 : 0
}

/** tween.dur(ms, speedFactor()) 에 넣는 값. 즉시는 Infinity → 지속시간 0. */
export function speedFactor(s: Settings = loadSettings()): number {
  return s.speed >= 999 ? Number.POSITIVE_INFINITY : s.speed
}

/** 플래시 지속시간 배율. 약 프리셋은 "α 0.88→0.25, 지속 2배" (§6) */
export function flashHold(s: Settings = loadSettings()): number {
  return s.flash === 'weak' ? 2 : 1
}

/** 햅틱. iOS 는 vibrate 미지원 → 조용히 실패한다 (TECH §4). */
export function haptic(ms = 12, s: Settings = loadSettings()): void {
  if (!s.haptic) return
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }
  try {
    if (typeof nav.vibrate === 'function') nav.vibrate(ms)
  } catch {
    // 무시
  }
}

// ---------------------------------------------------------------------------
// 첫 실행 플래그
// ---------------------------------------------------------------------------

export function hasSeenWarning(): boolean {
  if (cache === null) readStore()
  return warned
}

export function markWarningSeen(): void {
  if (cache === null) readStore()
  warned = true
  writeStore()
}

export function hasAskedReducedMotion(): boolean {
  if (cache === null) readStore()
  return rmAsked
}

export function markReducedMotionAsked(): void {
  if (cache === null) readStore()
  rmAsked = true
  writeStore()
}

/** OS 의 모션 감소 설정 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** "약" 프리셋 (번쩍임/흔들림 약 + 왜곡 끔) */
export function weakPreset(base: Settings = loadSettings()): Settings {
  return { ...base, flash: 'weak', shake: 'weak', distort: false }
}

// ---------------------------------------------------------------------------
// DOM 반영 — body 클래스 + 주입 스타일시트
//   style.css 는 이미 확정된 디자인 시스템이라 손대지 않는다.
//   접근성 옵션이 필요로 하는 규칙만 여기서 <style> 로 주입한다.
// ---------------------------------------------------------------------------

const STYLE_ID = 'gb-a11y'

const A11Y_CSS = `
/* 글자 크게 (+15%) */
body.gb-big { font-size: 16px; }
body.gb-big .screen p,
body.gb-big .pick-text,
body.gb-big .door-sub,
body.gb-big .door-reward,
body.gb-big .stat-row,
body.gb-big .att-chip,
body.gb-big .rar,
body.gb-big .slotname,
body.gb-big .pick-meta { font-size: 12px; }
body.gb-big .pick-name,
body.gb-big .btn,
body.gb-big .door-enemy { font-size: 16px; }
body.gb-big .screen h2 { font-size: 17px; }
body.gb-big .screen h1 { font-size: 30px; }
body.gb-big .btn small { font-size: 11px; }
body.gb-big .card-type { font-size: 11px; }
body.gb-big .card-grade { font-size: 19px; }
body.gb-big .enemy-name { font-size: 14px; }
body.gb-big .dist-num, body.gb-big .heat-num { font-size: 18px; }
body.gb-big .toast { font-size: 14px; }

/* 색맹 패턴 오버레이 — 탄종을 색이 아니라 무늬로도 구분한다 */
body.gb-cb .card[data-type="AP"]:not(.hidden-card),
body.gb-cb .pick-icon[data-type="AP"] {
  background-image:
    repeating-linear-gradient(45deg, rgba(255,255,255,.16) 0 2px, transparent 2px 6px),
    linear-gradient(165deg,#1c2026,#101317);
}
body.gb-cb .card[data-type="INC"]:not(.hidden-card),
body.gb-cb .pick-icon[data-type="INC"] {
  background-image:
    radial-gradient(rgba(255,255,255,.22) 1px, transparent 1.4px),
    linear-gradient(165deg,#1c2026,#101317);
  background-size: 6px 6px, auto;
}
body.gb-cb .card[data-type="HE"]:not(.hidden-card),
body.gb-cb .pick-icon[data-type="HE"] {
  background-image:
    repeating-linear-gradient(0deg, rgba(255,255,255,.14) 0 1px, transparent 1px 6px),
    repeating-linear-gradient(90deg, rgba(255,255,255,.14) 0 1px, transparent 1px 6px),
    linear-gradient(165deg,#1c2026,#101317);
}
body.gb-cb .card[data-type="SANC"]:not(.hidden-card),
body.gb-cb .pick-icon[data-type="SANC"] {
  background-image:
    repeating-linear-gradient(-45deg, rgba(255,255,255,.05) 0 3px, transparent 3px 9px),
    linear-gradient(165deg,#22242a,#141821);
}
`

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const st = document.createElement('style')
  st.id = STYLE_ID
  st.textContent = A11Y_CSS
  document.head.appendChild(st)
}

/**
 * body 클래스로 설정을 반영한다. 앱 부팅 시 1회 + 설정 변경 때마다 호출된다.
 * .reduce-motion 은 style.css 가 이미 정의해 둔 클래스다 (모든 애니메이션 무력화).
 */
export function applySettings(s: Settings = loadSettings()): void {
  if (typeof document === 'undefined') return
  ensureStyle()
  const b = document.body
  b.classList.toggle('gb-big', s.bigText)
  b.classList.toggle('gb-cb', s.colorblind)
  const noMotion = s.speed >= 999 || (s.shake === 'off' && s.flash === 'off')
  b.classList.toggle('reduce-motion', noMotion)
}

/** 부팅 시 1회. 저장된 설정을 읽어 DOM 에 반영한다. */
export function initSettings(): Settings {
  const s = loadSettings()
  applySettings(s)
  return s
}

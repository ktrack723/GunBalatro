// rAF 기반 트윈/대기. 모든 연출 타이밍은 여기를 통과한다.
// - 모든 잡(job)은 단 하나의 rAF 루프에서 돌린다 (루프 N개 = 프레임 예산 낭비).
// - "스킵"은 진행 중인 잡을 즉시 끝값으로 확정시키는 것이지, 건너뛰는 게 아니다.
//   → 연출을 스킵해도 UI 최종 상태는 항상 정상 값으로 남는다.

// ---------------------------------------------------------------------------
// 이징
// ---------------------------------------------------------------------------

export const linear = (t: number): number => t
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)
export const easeIn = (t: number): number => t * t * t
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
/** 뒤로 당겼다 튀어나오는 느낌 (카드 흡입/삽입) */
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}
export const easeInBack = (t: number): number => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return c3 * t * t * t - c1 * t * t
}

// ---------------------------------------------------------------------------
// 연출 전용 시드 PRNG
//   게임 로직 rng(core) 와 절대 섞지 않는다. Math.random 도 쓰지 않는다.
//   연출용이라 결정론이 깨져도 규칙에는 영향이 없지만, 시드 고정이면 녹화 재현이 쉬워진다.
// ---------------------------------------------------------------------------

let fxSeed = 0x9e3779b9

export function setFxSeed(seed: number): void {
  fxSeed = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0
}

/** mulberry32 (core/rng 와 같은 계열이지만 완전히 독립된 스트림) */
export function fxRandom(): number {
  fxSeed = (fxSeed + 0x6d2b79f5) | 0
  let t = fxSeed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** [-1, 1) */
export function fxSigned(): number {
  return fxRandom() * 2 - 1
}

export function fxRange(lo: number, hi: number): number {
  return lo + fxRandom() * (hi - lo)
}

// ---------------------------------------------------------------------------
// 잡 스케줄러
// ---------------------------------------------------------------------------

interface Job {
  start: number
  dur: number
  fn: ((t01: number) => void) | null
  ease: (t: number) => number
  resolve: () => void
  done: boolean
}

const jobs = new Set<Job>()
let rafId = 0
/** 스킵 요청 플래그 (아래 "스킵" 절 참고) */
let skipping = false

function finish(j: Job): void {
  if (j.done) return
  j.done = true
  jobs.delete(j)
  if (j.fn !== null) {
    try {
      j.fn(1)
    } catch {
      // 연출 콜백이 죽어도 시퀀스는 계속 간다
    }
  }
  j.resolve()
}

function pump(now: number): void {
  rafId = 0
  for (const j of Array.from(jobs)) {
    const t = j.dur <= 0 ? 1 : (now - j.start) / j.dur
    if (t >= 1) {
      finish(j)
      continue
    }
    if (j.fn !== null) {
      try {
        j.fn(j.ease(t < 0 ? 0 : t))
      } catch {
        finish(j)
      }
    }
  }
  if (jobs.size > 0) rafId = requestAnimationFrame(pump)
}

function schedule(dur: number, fn: ((t01: number) => void) | null, ease: (t: number) => number): Promise<void> {
  if (skipping || !Number.isFinite(dur) || dur <= 0) {
    if (fn !== null) {
      try {
        fn(1)
      } catch {
        /* 무시 */
      }
    }
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const j: Job = {
      start: performance.now(),
      dur,
      fn,
      ease,
      resolve,
      done: false,
    }
    jobs.add(j)
    if (rafId === 0) rafId = requestAnimationFrame(pump)
  })
}

// ---------------------------------------------------------------------------
// 스킵
// ---------------------------------------------------------------------------

/**
 * 연출 스킵 요청. 진행 중인 대기/트윈을 전부 끝값으로 확정한다.
 * 다음 beginSkipScope() 까지 새로 시작하는 대기도 즉시 끝난다
 * → "그 발의 남은 연출만 스킵" 이 된다. 로직은 core 에서 이미 끝나 있으므로 영향 없음.
 */
export function requestSkip(): void {
  skipping = true
  for (const j of Array.from(jobs)) finish(j)
}

/** 새 연출 단위(1발/1구간)의 시작. 이전 스킵 요청을 해제한다. */
export function beginSkipScope(): void {
  skipping = false
}

export function skipRequested(): boolean {
  return skipping
}

/** 뷰 파괴 시. 진행 중인 잡을 전부 끝내고 루프를 멈춘다. */
export function killTweens(): void {
  for (const j of Array.from(jobs)) finish(j)
  jobs.clear()
  if (rafId !== 0) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  skipping = false
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

/** 연출 속도를 반영한 실제 지속시간. speed 가 Infinity 면 0 (즉시 결과). */
export function dur(ms: number, speed: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0
  if (!Number.isFinite(speed)) return 0
  const sp = speed > 0 ? speed : 1
  return ms / sp
}

/** ms 를 speed 로 나눈 만큼 기다린다. */
export function wait(ms: number, speed: number): Promise<void> {
  return schedule(dur(ms, speed), null, linear)
}

/**
 * 절대 시각(performance.now 기준)까지 기다린다.
 * 짧은 대기를 연달아 await 하면 매번 다음 프레임까지 올림되어 오차가 누적된다
 * (16ms 프레임 × 10단계 = 발당 +160ms). 타임라인 표를 지키려면 절대 시각을 써야 한다.
 */
export function waitUntil(deadline: number): Promise<void> {
  return schedule(deadline - performance.now(), null, linear)
}

/**
 * ms 동안 fn(t01) 을 매 프레임 호출한다. 끝나면 반드시 fn(1) 이 한 번 불린다.
 * ms 는 호출부에서 이미 speed 로 나눈 값이어야 한다 (dur() 사용).
 */
export function tween(
  ms: number,
  fn: (t01: number) => void,
  ease: (t: number) => number = easeOut,
): Promise<void> {
  return schedule(ms, fn, ease)
}

/** 값 보간 설탕. */
export function tweenValue(
  from: number,
  to: number,
  ms: number,
  fn: (v: number) => void,
  ease: (t: number) => number = easeOut,
): Promise<void> {
  return tween(ms, (t) => fn(from + (to - from) * t), ease)
}

/** 여러 연출을 병렬로 돌리고 전부 끝날 때까지 기다린다. */
export function all(ps: Promise<void>[]): Promise<void> {
  return Promise.all(ps).then(() => undefined)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

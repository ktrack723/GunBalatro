// ============================================================================
// 효과음 — ZzFX (절차 생성 신스)
//   오디오 파일이 없다. ZzFX 는 파라미터에서 파형을 만들어 내므로 에셋이 0이고
//   번들도 1KB 남짓이다. 어두운 복도 게임에 필요한 건 몇 가지 짧은 소리뿐이라
//   샘플 라이브러리보다 이쪽이 맞다.
//
//   iOS: AudioContext 는 사용자 제스처 안에서 resume() 해야 소리가 난다.
//   그래서 모듈을 **첫 터치 때 동적 import** 한다 (로드 시점에 컨텍스트를 만들지 않는다).
// ============================================================================

type Params = number[]

/** zzfx 파라미터: (volume, randomness, frequency, attack, sustain, release, shape,
 *  shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeat, noise,
 *  modulation, bitCrush, delay, sustainVolume, decay, tremolo) */
const BANK = {
  // --- 사격: 온도 단계별로 4종. 뜨거울수록 저음이 두껍고 잔향이 길다 ---
  shot0: [2.6, 0.05, 420, 0.0, 0.02, 0.16, 4, 1.9, -9, 0, 0, 0, 0, 1.1, 0, 0.1, 0.02, 0.7, 0.02],
  shot1: [2.8, 0.05, 340, 0.0, 0.03, 0.2, 4, 2.0, -11, 0, 0, 0, 0, 1.3, 0, 0.12, 0.03, 0.72, 0.03],
  shot2: [3.0, 0.06, 260, 0.0, 0.04, 0.26, 4, 2.1, -13, 0, 0, 0, 0, 1.5, 0, 0.14, 0.04, 0.75, 0.04],
  shot3: [3.3, 0.06, 190, 0.0, 0.05, 0.34, 4, 2.2, -15, 0, 0, 0, 0, 1.8, 0, 0.16, 0.06, 0.78, 0.06],

  // --- 장전 (동작마다 다른 소리, 전부 크게) --------------------------------
  //   재장전은 이 게임에서 제일 긴 연출이다. 동작이 하나씩 끊어지는 만큼
  //   **소리도 하나씩** 달라야 지금 무엇을 하는 중인지 눈을 안 보고도 안다.
  //   금속(shape 2 삼각파 + 노이즈)은 찰카닥, 저음(shape 1 톱니)은 탁·쿵으로 쓴다.

  /** 총을 카메라 앞으로 들어올린다 — 장비가 스치는 둔한 소리 */
  poseUp: [1.5, 0.05, 210, 0.01, 0.04, 0.11, 1, 1.7, 6, 2, 0, 0, 0, 1.1, 0, 0.08, 0.02, 0.5, 0.05],
  /** 총을 원래 자세로 내린다 — 위와 반대 방향으로 미끄러진다 */
  poseDown: [1.4, 0.05, 260, 0.01, 0.04, 0.12, 1, 1.7, -7, -2, 0, 0, 0, 1.1, 0, 0.08, 0.02, 0.5, 0.05],
  /** 노리쇠 후퇴 — 길게 긁히는 금속 */
  boltBack: [2.2, 0.04, 700, 0.0, 0.03, 0.13, 2, 1.6, -14, -4, 0, 0, 0, 1.5, 0, 0.1, 0.02, 0.55, 0.06],
  /** 탄창 멈치 해제 — 짧고 높은 딸깍 */
  magRelease: [2.0, 0.03, 1350, 0.0, 0.01, 0.05, 2, 1.1, 22, 0, 0, 0, 0, 0.5],
  /** 탄창이 빠져 나온다 — 딸깍 뒤의 둔탁한 이탈음 */
  magOut: [2.1, 0.05, 230, 0.0, 0.03, 0.12, 1, 1.5, 9, 3, 0, 0, 0, 1.2, 0, 0.09, 0.02, 0.5, 0.05],
  /** 한 발 삽탄 — 탁. 짧고 단단하게, 발마다 피치를 흔든다 */
  roundIn: [2.2, 0.04, 820, 0.0, 0.012, 0.055, 2, 1.7, -6, 0, 0, 0, 0, 1.0, 0, 0.06, 0.01, 0.4, 0.02],
  /** 탄창 장착 — 제일 무거운 쿵 */
  magIn: [2.6, 0.05, 150, 0.0, 0.04, 0.17, 1, 1.9, -5, -2, 0, 0, 0, 1.6, 0, 0.12, 0.03, 0.6, 0.07],
  /** 노리쇠 전진 — 약실 물리는 찰카닥 */
  boltFwd: [2.5, 0.04, 520, 0.0, 0.02, 0.11, 2, 1.8, 14, 5, 0, 0, 0, 1.4, 0, 0.1, 0.02, 0.5, 0.05],
  /** 조준 — 가늠자를 세우는 짧고 가벼운 금속음 */
  aimUp: [1.3, 0.03, 1050, 0.0, 0.015, 0.06, 2, 1.2, 10, 0, 0, 0, 0, 0.4],

  // --- 피격 / 처치 / 즉사 ---
  hit: [1.1, 0.05, 210, 0.0, 0.02, 0.12, 4, 1.4, -4, 0, 0, 0, 0, 1.6],
  kill: [1.6, 0.08, 120, 0.02, 0.12, 0.4, 4, 1.6, -6, 0, 0, 0, 0, 2.2, 0, 0.2, 0.1, 0.6, 0.1],
  death: [1.8, 0.1, 90, 0.05, 0.3, 0.8, 3, 1.2, -3, 0, 0, 0, 0, 1.2, 0, 0.3, 0.2, 0.5, 0.2],

  // --- 온도 단계 상승 / 부착물 발동 / 넉백 ---
  heatUp: [0.9, 0.04, 320, 0.02, 0.06, 0.16, 1, 1.8, 12, 4, 0, 0, 0, 0.3],
  proc: [0.7, 0.03, 1100, 0.0, 0.02, 0.05, 1, 1.2, 8, 0, 0, 0, 0, 0.2],
  knock: [1.0, 0.05, 150, 0.0, 0.05, 0.18, 4, 1.5, 9, 0, 0, 0, 0, 1.4],

  // --- 급브레이크 (전투 진입) ---
  //   달려오다 발을 끄는 소리. 노이즈를 크게 두고 주파수를 빠르게 떨어뜨린다.
  skid: [1.1, 0.06, 300, 0.01, 0.14, 0.26, 4, 1.8, -16, -3, 0, 0, 0, 2.6, 0, 0.12, 0.04, 0.55, 0.12],

  // --- UI ---
  tap: [0.55, 0.02, 760, 0.0, 0.01, 0.02, 1, 1.1],
  back: [0.5, 0.02, 420, 0.0, 0.01, 0.03, 1, 1.1, -4],
  confirm: [0.8, 0.03, 540, 0.0, 0.03, 0.08, 1, 1.4, 10, 0, 0, 0, 0, 0.2],
  reward: [0.9, 0.04, 620, 0.01, 0.08, 0.2, 1, 1.6, 14, 6, 0, 0, 0, 0.2],
} satisfies Record<string, Params>

export type SfxId = keyof typeof BANK

interface Zz {
  ZZFX: { volume: number; audioContext: AudioContext; play(...p: number[]): unknown }
}

let mod: Zz | null = null
let loading: Promise<void> | null = null
let enabled = true
let master = 0.34
/** 같은 소리가 한 프레임에 겹쳐 터지는 것을 막는다 */
const lastAt = new Map<string, number>()

async function ensure(): Promise<void> {
  if (mod !== null) return
  if (loading === null) {
    loading = import('zzfx')
      .then((m) => {
        mod = m as unknown as Zz
        mod.ZZFX.volume = master
      })
      .catch((e) => {
        console.warn('[sfx] 로드 실패 — 소리 없이 진행한다', e)
      })
  }
  await loading
}

/** 첫 사용자 제스처 안에서 호출해야 iOS 에서 소리가 난다 */
export function unlockSfx(): void {
  void ensure().then(() => {
    const ctx = mod?.ZZFX.audioContext
    if (ctx !== undefined && ctx.state === 'suspended') void ctx.resume()
    // 첫 발·첫 삽탄이 합성음으로 나가지 않게 여기서 미리 디코딩한다
    preloadSample('fire')
    preloadSample('roundIn')
  })
}

export function setSfxEnabled(on: boolean): void {
  enabled = on
}

export function setSfxVolume(v: number): void {
  master = Math.max(0, Math.min(1, v))
  if (mod !== null) mod.ZZFX.volume = master
}

/**
 * 소리 하나. `rate` 로 피치를 흔들 수 있다 (연속 발사가 단조롭지 않게).
 * 아직 로드/언락 전이면 조용히 무시한다 — 소리는 게임을 멈출 이유가 못 된다.
 */
export function sfx(id: SfxId, rate = 1, throttleMs = 25): void {
  if (!enabled) return
  const now = performance.now()
  const prev = lastAt.get(id) ?? -1e9
  if (now - prev < throttleMs) return
  lastAt.set(id, now)

  if (mod === null) {
    void ensure()
    return
  }
  const p = BANK[id].slice()
  if (rate !== 1 && typeof p[2] === 'number') p[2] = p[2] * rate
  try {
    mod.ZZFX.play(...p)
  } catch {
    /* 컨텍스트가 아직 잠겨 있으면 조용히 넘어간다 */
  }
}

// ---------------------------------------------------------------------------
// 녹음 샘플 (public/sfx/*.wav)
//   합성음(zzfx)은 폴백으로 남겨 둔다. 샘플이 아직 안 읽혔거나 디코딩에 실패하면
//   소리가 아예 없는 것보다 합성음이 낫다.
//   두 파일 모두 선행 무음을 에셋 단계에서 잘라 냈다 — 안 자르면 소리가 화면보다
//   늦는다 (fire 원본 0.173초, round-in 원본 0.020초). 전부 모노 48kHz.
// ---------------------------------------------------------------------------
const SAMPLE_SRC = {
  /** 발사음 (1.04초) */
  fire: 'sfx/fire.wav',
  /** 한 발 삽탄 — 탄창에 탄을 밀어 넣는 금속음 (0.108초) */
  roundIn: 'sfx/round-in.wav',
} as const

type SampleId = keyof typeof SAMPLE_SRC

const sampleBuf = new Map<SampleId, AudioBuffer>()
const sampleLoading = new Map<SampleId, Promise<void>>()

function audioCtx(): AudioContext | null {
  const ctx = mod?.ZZFX.audioContext
  return ctx ?? null
}

function baseUrl(): string {
  const b = import.meta.env.BASE_URL
  return typeof b === 'string' && b.length > 0 ? b : '/'
}

async function loadSample(id: SampleId): Promise<void> {
  const ctx = audioCtx()
  if (ctx === null || sampleBuf.has(id)) return
  try {
    const res = await fetch(baseUrl() + SAMPLE_SRC[id])
    const raw = await res.arrayBuffer()
    sampleBuf.set(id, await ctx.decodeAudioData(raw))
  } catch (e) {
    console.warn('[sfx] 샘플 로드 실패 — 합성음으로 대체한다', id, e)
  }
}

/** 아직 안 읽었으면 읽기 시작한다 (중복 요청은 막는다) */
function preloadSample(id: SampleId): void {
  if (sampleLoading.has(id) || mod === null) return
  sampleLoading.set(id, loadSample(id))
}

/** 샘플 한 방. 겹쳐 쏴도 서로 자르지 않게 매번 새 소스를 만든다. */
function playSample(id: SampleId, rate: number, gain: number): boolean {
  const ctx = audioCtx()
  const buf = sampleBuf.get(id)
  if (ctx === null || buf === undefined) return false
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    const g = ctx.createGain()
    g.gain.value = master * gain
    src.connect(g).connect(ctx.destination)
    src.start()
    return true
  } catch {
    return false
  }
}

/**
 * 온도 단계(0~3)에 맞는 발사음.
 * 뜨거울수록 재생 속도를 낮춰 총성이 굵고 늘어지게 한다 — 합성음 시절의 단계별
 * 주파수 하강(420→190Hz)을 샘플에서도 같은 방향으로 흉내 낸다.
 */
export function sfxShot(heat: number): void {
  if (!enabled) return
  const tier = heat >= 30 ? 3 : heat >= 16 ? 2 : heat >= 8 ? 1 : 0
  const rate = [1.06, 0.98, 0.91, 0.84][tier]! * (0.98 + Math.random() * 0.04)
  if (playSample('fire', rate, [0.85, 0.92, 1.0, 1.08][tier]!)) return
  // 폴백 — 샘플이 아직 없다
  preloadSample('fire')
  const ids: SfxId[] = ['shot0', 'shot1', 'shot2', 'shot3']
  sfx(ids[tier], 0.94 + Math.random() * 0.12, 0)
}

/**
 * 삽탄 한 발. 탄창에 탄을 밀어 넣을 때마다 **매번** 운다 — 다섯 발이면 다섯 번.
 * `rate` 로 발마다 피치를 흔들어, 같은 소리가 연달아 나도 기계 반복으로 안 들리게 한다.
 */
export function sfxRoundIn(rate = 1): void {
  if (!enabled) return
  if (playSample('roundIn', rate, 1.0)) return
  preloadSample('roundIn')
  sfx('roundIn', rate, 0)
}

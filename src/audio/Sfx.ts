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
  shot0: [1.6, 0.05, 420, 0.0, 0.02, 0.16, 4, 1.9, -9, 0, 0, 0, 0, 1.1, 0, 0.1, 0.02, 0.7, 0.02],
  shot1: [1.7, 0.05, 340, 0.0, 0.03, 0.2, 4, 2.0, -11, 0, 0, 0, 0, 1.3, 0, 0.12, 0.03, 0.72, 0.03],
  shot2: [1.8, 0.06, 260, 0.0, 0.04, 0.26, 4, 2.1, -13, 0, 0, 0, 0, 1.5, 0, 0.14, 0.04, 0.75, 0.04],
  shot3: [2.0, 0.06, 190, 0.0, 0.05, 0.34, 4, 2.2, -15, 0, 0, 0, 0, 1.8, 0, 0.16, 0.06, 0.78, 0.06],

  // --- 장전 (FILO) ---
  roundIn: [0.9, 0.03, 900, 0.0, 0.01, 0.04, 2, 1.4, 0, 0, 0, 0, 0, 0.4],
  magIn: [1.3, 0.04, 180, 0.0, 0.02, 0.09, 1, 1.6, -3, 0, 0, 0, 0, 0.8],
  magOut: [1.0, 0.04, 240, 0.0, 0.02, 0.07, 1, 1.4, 5, 0, 0, 0, 0, 0.7],
  boltBack: [1.0, 0.03, 620, 0.0, 0.01, 0.06, 2, 1.2, -8, 0, 0, 0, 0, 0.9],
  boltFwd: [1.1, 0.03, 480, 0.0, 0.01, 0.07, 2, 1.3, 6, 0, 0, 0, 0, 0.9],

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

/** 온도 단계(0~3)에 맞는 발사음 */
export function sfxShot(heat: number): void {
  const tier = heat >= 30 ? 3 : heat >= 16 ? 2 : heat >= 8 ? 1 : 0
  const ids: SfxId[] = ['shot0', 'shot1', 'shot2', 'shot3']
  sfx(ids[tier], 0.94 + Math.random() * 0.12, 0)
}

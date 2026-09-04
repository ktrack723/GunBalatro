// ============================================================================
// 밸런스 눈금 (Tuning) — 카탈로그의 **모든 수치**가 여기 한 곳에 모인다.
//
// 왜 따로 빼는가:
//   ① 수치가 훅 클로저 안에 박혀 있으면 자동 튜너가 건드릴 수 없다. 밸런싱이
//      사람이 한 줄씩 고치고 다시 재는 일이 되어, 반복 횟수가 곧 비용이 된다.
//      여기 모아 두면 sim/tune.ts 가 값을 흔들어 보고 수렴시킨다.
//   ② **툴팁이 거짓말을 하지 않는다.** 예전에는 text 가 손으로 쓰인 문자열이라
//      코드와 어긋났다 — 실측으로 잡은 것만 다섯 건이었다:
//        영혼 표식 text +2.6 / 코드 1.5 · 불침번 +14 / 6 · 서리 성궤 9.0 / 6.0
//        도박꾼 +14·−4 / +75·−12 · 특이점탄 ×10 / ×6
//      이제 text 는 이 표의 값으로 **생성**되므로 어긋날 방법이 없다.
//
// 규칙: 여기 있는 수는 전부 '밸런스 눈금' 이다. 규칙 자체(조건의 모양, 훅이
//   무엇을 하는가)는 여기 오지 않는다 — 그건 카탈로그가 정한다.
// ============================================================================

/**
 * 특수탄 눈금.
 *   dmg/heat 은 STEP1·STEP2 의 기본값, 나머지는 훅이 얹는 몫이다.
 *   price 는 정비소 1발 값 — 가치 분석기가 밴드와 함께 맞춘다.
 */
export const TR = {
  sp_incendiary: { dmg: 1, heat: 0.811, price: 18 },
  sp_ap: { dmg: 43, heat: 0.05, price: 16 },
  sp_shock: { dmg: 14, heat: 0.4, price: 19, knock: 0.969, cap: 1.93 },
  sp_adhesive: { dmg: 14, heat: 0.4, price: 28, bonus: 64 },
  sp_thermite: { dmg: 2, heat: 1.72, price: 25 },
  sp_marker: { dmg: 16, heat: 0.4, price: 29, vuln: 0.651 },
  sp_chill: { dmg: 129, heat: 0.3, price: 26, slow: 2, cap: 2 },
  sp_cryo: { dmg: 18, heat: 0.15, price: 26, thr: 18, mul: 8.24 },
  sp_purge: { dmg: 256, heat: 0, price: 27, mul: 40 },
  sp_sanctified: { dmg: 26, mult: 11, heat: 0.6, price: 46 },
  sp_cascade: { dmg: 4, mult: 1.2, heat: 2.58, price: 49 },
  sp_breach: { dmg: 341, heat: 0.05, price: 50 },
  sp_solitary: { dmg: 30, heat: 0.3, price: 50, bonus: 285 },
  sp_firststrike: { dmg: 40, heat: 0.1, price: 47, thr: 6, bonus: 269 },
  sp_singularity: { dmg: 20, heat: 0, price: 96, mul: 1.75 },
  sp_judgment: { dmg: 30, heat: 0.5, price: 93, mul: 9.81 },
}

/**
 * 부착물 눈금.
 *   키 이름은 그 부착물이 무엇을 얹는지로 짓는다 (dmg/heat/m/thr/cap/mul/max).
 *   조건의 임계는 thr, 상한은 max, 성장분은 step 이다.
 */
export const TA = {
  // --- 총열 ---------------------------------------------------------------
  br_long: { dmg: 71 },
  br_heavy: { dmg: 159 },
  br_compensator: { dmg: 967, upto: 1 },
  br_bayonet: { dmg: 314, thr: 28 },
  br_catalyst: { dmg: 240 },
  br_gambler: { up: 330, down: 53 },
  br_judgment: { pct: 1.47, max: 6378 },
  br_volatile: { dmg: 227, step: 38, max: 340 },
  br_frostbite: { thr: 6, mul: 118 },
  br_archetype: { pct: 1 },

  // --- 총열덮개 -----------------------------------------------------------
  hg_fin: { heat: 0.325 },
  hg_catalyst: { heat: 0.684 },
  hg_gas: { heat: 0.455, from: 2 },
  hg_relay: { heat: 1.28 },
  hg_chain: { step: 0.258, maxIndex: 4 },
  hg_pyre: { heat: 4.74, burn: 3 },
  hg_cryo: { dmg: 340, thr: 3.5, carry: -0.4 },
  hg_furnace: { heat: 22, thr: 3.5 },
  hg_martyr: { heat: 0.834, step: 0.103, max: 1.04 },
  hg_twoshot: { heat: 20, load: 2 },
  hg_inquisition: { heat: 1.06, mult: 1.71 },

  // --- 광학 ---------------------------------------------------------------
  op_laser: { dmg: 97, thr: 20 },
  op_holywater: { heat: 3.05 },
  op_thermal: { dmg: 228, need: 2 },
  op_deferral: { dmg: 461 },
  op_inquest: { dmg: 419 },
  op_lastrites: { heat: 2.51, thr: 28 },
  op_poverty: { heat: 15 },
  op_trinity: { heat: 0.997, need: 3 },
  op_pact: { dmg: 538, thr: 4.12 },
  op_quartermaster: { mags: 6 },
  op_soulmark: { heat: 12, step: 1.25 },
  op_vigil: { step: 7858, max: 5 },
  op_frostvault: { step: 1.99, thr: 6 },
  op_deathrite: { heat: 9.44 },
  op_emperor: { dmg: 116, heat: 3.36 },

  // --- 개머리판 -----------------------------------------------------------
  st_rangefinder: { fireCost: -3 },
  st_fixed: { startDist: 8 },
  st_charm: { brass: 13 },
  st_buffer: { startDist: 10, fireCost: -1 },
  st_penance: { dmg: 72, startDist: -4 },
  st_reliquary: { railSlots: 1, startDist: 16 },
  st_stride: { enemySpeed: -3, startDist: -2 },
  st_bandolier: { start: 1, perMag: 8, max: 8 },
  st_glacier: { dmg: 169, thr: 6, carry: -0.5 },

  // --- 탄창 ---------------------------------------------------------------
  mg_standard: { cap: 5 },
  mg_drum: { cap: 8, heatMul: 0.674 },
  mg_precision: { cap: 3, heat: 1.6, fireCost: -0.25 },
  mg_penitent: { cap: 5, heat: 0.334 },
  mg_greed: { cap: 4, keep: 0.553 },
  mg_coolant: { cap: 6, carry: 0.5 },
  mg_executioner: { cap: 2, startHeat: 31, fireCost: -3 },
  mg_annex: { cap: 6, step: 1, max: 6 },
  mg_unstable: { cap: 4, heat: 1.3, carry: -0.25, fuse: 30 },
  mg_belt: { cap: 10, heatMul: 1 },
}

// ---------------------------------------------------------------------------
// 표기 도우미 — text 를 눈금에서 생성할 때 쓴다
// ---------------------------------------------------------------------------
/** 소수점이 필요할 때만 붙인다 (4.0 → '4', 4.25 → '4.25') */
export function n(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)))
}
/** 부호를 붙인다 (+5 / −4). 음수는 유니코드 빼기표를 쓴다 — 하이픈은 화면에서 안 읽힌다 */
export function sg(v: number): string {
  return v >= 0 ? '+' + n(v) : '−' + n(-v)
}
/** 비율을 % 로 (0.42 → '42') */
export function pc(v: number): string {
  return n(Math.round(v * 1000) / 10)
}

/**
 * 튜너용 — 눈금 전체를 [경로, 읽기, 쓰기] 로 펼친다.
 * 경로는 'br_long.dmg' 꼴이다.
 */
export interface KnobRef {
  path: string
  get(): number
  set(v: number): void
}

function walk(root: Record<string, Record<string, number>>, out: KnobRef[]): void {
  for (const id of Object.keys(root)) {
    const group = root[id]
    if (group === undefined) continue
    for (const key of Object.keys(group)) {
      out.push({
        path: id + '.' + key,
        get: () => group[key] as number,
        set: (v: number) => {
          group[key] = v
        },
      })
    }
  }
}

export function allKnobs(): KnobRef[] {
  const out: KnobRef[] = []
  walk(TR as unknown as Record<string, Record<string, number>>, out)
  walk(TA as unknown as Record<string, Record<string, number>>, out)
  return out
}

/** 현재 눈금 전체의 사본 (튜너가 되돌리기용으로 쓴다) */
export function snapshotKnobs(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of allKnobs()) out[k.path] = k.get()
  return out
}

export function restoreKnobs(snap: Record<string, number>): void {
  for (const k of allKnobs()) {
    const v = snap[k.path]
    if (typeof v === 'number') k.set(v)
  }
}

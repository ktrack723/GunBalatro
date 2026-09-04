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
  sp_incendiary: { dmg: 1, heat: 2.13, price: 17 },
  sp_ap: { dmg: 79.4, heat: 0.05, price: 19 },
  sp_shock: { dmg: 14, heat: 0.4, price: 17, knock: 1.15, cap: 2.29 },
  sp_adhesive: { dmg: 14, heat: 0.4, price: 24, bonus: 34.8 },
  sp_thermite: { dmg: 2, heat: 4.6, price: 26 },
  sp_marker: { dmg: 16, heat: 0.4, price: 26, vuln: 0.651 },
  sp_chill: { dmg: 129, heat: 0.3, price: 28, slow: 2, cap: 2 },
  sp_cryo: { dmg: 18, heat: 0.15, price: 27, thr: 18, mul: 8.16 },
  sp_purge: { dmg: 10, heat: 0, price: 28, mul: 136 },
  sp_sanctified: { dmg: 26, mult: 6, heat: 0.6, price: 31 },
  sp_cascade: { dmg: 4, mult: 1.2, heat: 4.5, price: 65 },
  sp_breach: { dmg: 231, heat: 0.05, price: 45 },
  sp_solitary: { dmg: 30, heat: 0.3, price: 45, bonus: 188 },
  sp_firststrike: { dmg: 40, heat: 0.1, price: 48, thr: 6, bonus: 220 },
  sp_singularity: { dmg: 20, heat: 0, price: 65, mul: 1.1 },
  sp_judgment: { dmg: 30, heat: 0.5, price: 107, mul: 9.81 },
}

/**
 * 부착물 눈금.
 *   키 이름은 그 부착물이 무엇을 얹는지로 짓는다 (dmg/heat/m/thr/cap/mul/max).
 *   조건의 임계는 thr, 상한은 max, 성장분은 step 이다.
 */
export const TA = {
  // --- 총열 ---------------------------------------------------------------
  br_long: { dmg: 40 },
  br_heavy: { dmg: 83 },
  br_compensator: { dmg: 263, upto: 1 },
  br_bayonet: { dmg: 1136, thr: 10 },
  br_catalyst: { dmg: 133 },
  br_gambler: { up: 192, down: 31 },
  br_judgment: { pct: 0.64, max: 2805 },
  br_volatile: { dmg: 95, step: 16, max: 143 },
  br_frostbite: { thr: 6, mul: 105 },
  br_archetype: { pct: 1 },

  // --- 총열덮개 -----------------------------------------------------------
  hg_fin: { heat: 0.598 },
  hg_catalyst: { heat: 1.23 },
  hg_gas: { heat: 0.854, from: 2 },
  hg_relay: { heat: 1.97 },
  hg_chain: { step: 0.292, maxIndex: 4 },
  hg_pyre: { heat: 0.999, burn: 3 },
  hg_cryo: { dmg: 329, thr: 3.5, carry: -0.4 },
  hg_furnace: { heat: 116, thr: 10 },
  hg_martyr: { heat: 0.695, step: 0.086, max: 0.869 },
  hg_twoshot: { heat: 5.75, load: 2 },
  hg_inquisition: { heat: 1.26, mult: 1.49 },

  // --- 광학 ---------------------------------------------------------------
  op_laser: { dmg: 72, thr: 20 },
  op_holywater: { heat: 3.55 },
  op_thermal: { dmg: 153, need: 2 },
  op_deferral: { dmg: 279 },
  op_inquest: { dmg: 320 },
  op_lastrites: { heat: 190, thr: 10 },
  op_poverty: { heat: 17 },
  op_trinity: { heat: 1.27, need: 3 },
  op_pact: { dmg: 27176, thr: 12 },
  op_quartermaster: { mags: 6 },
  op_soulmark: { heat: 12, step: 1.2 },
  op_vigil: { step: 110, max: 5 },
  op_frostvault: { step: 2.54, thr: 6 },
  op_deathrite: { heat: 11 },
  op_emperor: { dmg: 116, heat: 3.38 },

  // --- 개머리판 -----------------------------------------------------------
  st_rangefinder: { fireCost: -3 },
  st_fixed: { startDist: 14 },
  st_charm: { brass: 8 },
  st_buffer: { startDist: 8, fireCost: -1 },
  st_penance: { dmg: 147, startDist: -4 },
  st_reliquary: { railSlots: 1, startDist: 16 },
  st_stride: { enemySpeed: -3, startDist: -2 },
  st_bandolier: { start: 1, perMag: 1, max: 6 },
  st_glacier: { dmg: 380, thr: 6, carry: -0.5 },

  // --- 탄창 ---------------------------------------------------------------
  mg_standard: { cap: 5 },
  mg_drum: { cap: 8, heatMul: 0.78 },
  mg_precision: { cap: 3, heat: 0, fireCost: -2 },
  mg_penitent: { cap: 5, heat: 0.281 },
  mg_greed: { cap: 4, keep: 0.159 },
  mg_coolant: { cap: 6, carry: 0.051 },
  mg_executioner: { cap: 2, startHeat: 5.7, fireCost: -3 },
  mg_annex: { cap: 6, step: 1, max: 1 },
  mg_unstable: { cap: 4, heat: 1.14, carry: -0.25, fuse: 30 },
  mg_belt: { cap: 10, heatMul: 0.717 },
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

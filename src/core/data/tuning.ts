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
  sp_incendiary: { dmg: 1, heat: 4.2, price: 18 },
  sp_ap: { dmg: 34, heat: 0.05, price: 16 },
  sp_shock: { dmg: 14, heat: 0.4, price: 18, knock: 3, cap: 6 },
  sp_adhesive: { dmg: 14, heat: 0.4, price: 30, bonus: 10 },
  sp_thermite: { dmg: 2, heat: 6.5, price: 48 },
  sp_marker: { dmg: 16, heat: 0.4, price: 36, vuln: 0.42 },
  sp_chill: { dmg: 42, heat: 0.3, price: 32, slow: 2, cap: 2 },
  sp_cryo: { dmg: 18, heat: 0.15, price: 34, thr: 18, mul: 5 },
  sp_purge: { dmg: 10, heat: 0, price: 30, mul: 10 },
  sp_sanctified: { dmg: 26, heat: 0.6, price: 55 },
  sp_cascade: { dmg: 4, heat: 8, price: 60 },
  sp_breach: { dmg: 72, heat: 0.05, price: 52 },
  sp_solitary: { dmg: 30, heat: 0.3, price: 58, bonus: 85 },
  sp_firststrike: { dmg: 40, heat: 0.1, price: 44, thr: 6.0, bonus: 220 },
  sp_singularity: { dmg: 20, heat: 0, price: 110, mul: 6 },
  sp_judgment: { dmg: 30, heat: 0.5, price: 120, mul: 1.8 },
}

/**
 * 부착물 눈금.
 *   키 이름은 그 부착물이 무엇을 얹는지로 짓는다 (dmg/heat/m/thr/cap/mul/max).
 *   조건의 임계는 thr, 상한은 max, 성장분은 step 이다.
 */
export const TA = {
  // --- 총열 ---------------------------------------------------------------
  br_long: { dmg: 5 },
  br_heavy: { dmg: 8 },
  br_compensator: { dmg: 28, upto: 1 },
  br_bayonet: { dmg: 110, thr: 10 },
  br_catalyst: { dmg: 26 },
  br_gambler: { up: 75, down: 12 },
  br_judgment: { pct: 0.05, max: 220 },
  br_volatile: { dmg: 12, step: 2, max: 18 },
  br_frostbite: { thr: 6, mul: 70 },
  br_archetype: { pct: 0.5 },

  // --- 총열덮개 -----------------------------------------------------------
  hg_fin: { heat: 0.45 },
  hg_catalyst: { heat: 1.6 },
  hg_gas: { heat: 1.2, from: 2 },
  hg_relay: { heat: 4.0 },
  hg_chain: { step: 0.55, maxIndex: 4 },
  hg_pyre: { heat: 2.5, burn: 3 },
  hg_cryo: { dmg: 65, thr: 3.5, carry: -0.4 },
  hg_furnace: { heat: 3.2, thr: 10 },
  hg_martyr: { heat: 1.6, step: 0.2, max: 2.0 },
  hg_twoshot: { heat: 26, load: 2 },
  hg_inquisition: { heat: 3.2 },

  // --- 광학 ---------------------------------------------------------------
  op_laser: { dmg: 15, thr: 20 },
  op_holywater: { heat: 4.0 },
  op_thermal: { dmg: 16, need: 2 },
  op_deferral: { dmg: 16 },
  op_inquest: { dmg: 25 },
  op_lastrites: { heat: 2.5, thr: 10 },
  op_poverty: { heat: 1.0 },
  op_trinity: { heat: 1.7, need: 3 },
  op_pact: { dmg: 18, thr: 12 },
  op_quartermaster: { mags: 2 },
  op_soulmark: { heat: 1.5, step: 0.15 },
  op_vigil: { step: 6, max: 5 },
  op_frostvault: { step: 6.0, thr: 6 },
  op_deathrite: { heat: 18 },
  op_emperor: { dmg: 55, heat: 1.6 },

  // --- 개머리판 -----------------------------------------------------------
  st_rangefinder: { fireCost: -1 },
  st_fixed: { startDist: 5 },
  st_charm: { brass: 3 },
  st_buffer: { startDist: 1, fireCost: -1 },
  st_penance: { dmg: 35, startDist: -4 },
  st_reliquary: { railSlots: 1, startDist: 6 },
  st_stride: { enemySpeed: -2, startDist: -2 },
  st_bandolier: { start: 1, perMag: 1, max: 2 },
  st_glacier: { dmg: 120, thr: 6, carry: -0.5 },

  // --- 탄창 ---------------------------------------------------------------
  mg_standard: { cap: 5 },
  mg_drum: { cap: 8, heatMul: 0.7 },
  mg_precision: { cap: 3, heat: 1.6, fireCost: -2 },
  mg_penitent: { cap: 5, heat: 1.8 },
  mg_greed: { cap: 4, keep: 0.5 },
  mg_coolant: { cap: 6, carry: 0.2 },
  mg_executioner: { cap: 2, startHeat: 38, fireCost: -3 },
  mg_annex: { cap: 6, step: 1, max: 3 },
  mg_unstable: { cap: 4, heat: 6.5, carry: -0.25, fuse: 30 },
  mg_belt: { cap: 10, heatMul: 0.8 },
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

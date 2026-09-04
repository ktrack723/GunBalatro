// ============================================================================
// 재밸런싱 — 측정 · 판정 · 수렴
//
//   1) sim/bands.ts 가 규칙과 드롭 확률에서 등급 밴드를 **유도**한다.
//   2) sim/value.ts 가 조합을 열거해 아이템마다 값을 잰다.
//   3) 여기서 밴드 밖의 아이템을 찾아, 그 아이템의 **페이로드 눈금**을 이분법으로
//      움직여 밴드 중앙에 맞춘다. 아이템끼리 서로의 측정 맥락이 되므로
//      한 번으로는 안 끝난다 — 패스를 반복해 고정점으로 몬다.
//
//   실행:  npx tsx src/sim/rebalance.ts            (측정만)
//          npx tsx src/sim/rebalance.ts --tune=6   (6패스 수렴 후 눈금 출력)
// ============================================================================
import type { Rarity } from '../core/types'
import { ATTACHMENTS } from '../core/data/attachments'
import { SPECIALS } from '../core/data/specials'
import { syncAttachments } from '../core/data/attachments'
import { syncSpecials } from '../core/data/specials'
import { TA, TR, allKnobs } from '../core/data/tuning'
import { ROUND_BANDS, RARITIES, type Band } from './bands'
import * as bands from './bands'
import {
  type Ctx,
  clearBaseCache,
  measureActionAnchor,
  measureAttachAnchor,
  type ItemValue,
  coverage,
  enumerateLoadouts,
  orderSensitivity,
  steadyHeat,
  valueOfAttachment,
  valueOfRound,
} from './value'

const PROBE_STOCK: Record<string, number> = {
  sp_incendiary: 3,
  sp_ap: 3,
  sp_breach: 2,
  sp_solitary: 2,
  sp_marker: 2,
}

// ---------------------------------------------------------------------------
// 페이로드 눈금 — "이 아이템의 세기를 정하는 수는 무엇인가"
//   임계(thr)·조건(need/from/load)·용량(cap)·구조(railSlots)는 **성격**이므로
//   튜너가 건드리지 않는다. 건드리면 카드가 다른 카드가 되어 버린다.
// ---------------------------------------------------------------------------
interface Payload {
  keys: string[]
  /** 정수로 반올림해야 하는 눈금 (거리·비용·용량 등) */
  int?: boolean
  /** 눈금의 하한/상한 — 넘으면 그 카드가 규칙을 깨뜨린다 */
  min?: number
  max?: number
  /**
   * 눈금별 상·하한. 여러 눈금을 같이 밀 때 **하나만** 묶어 둬야 하는 경우가 있다.
   *   심판탄이 그렇다: 배수를 9.8 까지 올리면 두 번째 심판탄이 첫 번째가 만든
   *   피해까지 먹어 겹칠수록 발당 가치가 **올라간다** — 반복 감쇠로도 못 막는
   *   자기 증식이고, 테스트가 잡아낸 실제 설계 위반이다. 배수는 묶고 기본 DMG 가
   *   나머지를 지게 한다.
   */
  bounds?: Record<string, [number, number]>
}

/**
 * 정체성 하한 — 이 수 아래로는 카드가 자기 이름을 잃는다.
 *
 *   특수탄은 **그 자체로 '특수탄 조건' 부착물의 방아쇠**다 (촉매 총열·소이 촉매·
 *   황제의 눈·열화상…). 그래서 자기 수치를 0 으로 만들어도 앙상블에서는 값이
 *   나오고, 튜너는 밴드를 맞추려 그 방향으로 간다. 실측 결과가 이랬다:
 *     철갑탄 DMG 7.5  (기본탄 12 보다 약하다 — '데미지 탄' 이 아니다)
 *     소이탄 온도 0.23 (기본탄 0.55 보다 낮다 — '예열탄' 이 아니다)
 *     충격탄 넉백 0.12m (밀어내지 않는다)
 *   밴드는 값을 맞추지 카드가 무엇인지는 모른다. 그건 설계가 정한다.
 *
 *   하한은 **기본탄의 2배** 선으로 잡는다 (기본탄 DMG 12 · 온도 0.55). 더 높이 잡으면
 *   (온도 2.5 를 시도했다) 커먼 예열탄이 값 10.0 으로 커먼 밴드 3.3~4.9 의 두 배가
 *   된다 — 온도는 뒤따르는 모든 탄을 곱하므로 지렛대가 그만큼 크다. 2배 선은
 *   '기본탄보다 확실히 낫다' 는 최소 조건이면서 밴드와 싸우지 않는 지점이다.
 */
const PAYLOAD: Record<string, Payload> = {
  // --- 탄: 기본 dmg/heat 가 곧 세기다. 훅이 있는 탄은 훅 쪽이 페이로드다 ---
  //   하한은 전부 기본탄(DMG 12 · 온도 0.55) 대비로 읽는다.
  sp_incendiary: { keys: ['heat'], min: 1.1 },
  sp_ap: { keys: ['dmg'], min: 24 },
  sp_shock: { keys: ['knock', 'cap'], bounds: { knock: [1.5, 8], cap: [3, 16] } },
  sp_adhesive: { keys: ['bonus'] },
  sp_thermite: { keys: ['heat'], min: 2.2 },
  sp_marker: { keys: ['vuln'] },
  sp_chill: { keys: ['dmg'], min: 24 },
  sp_cryo: { keys: ['mul'], min: 3 },
  sp_purge: { keys: ['dmg', 'mul'], bounds: { mul: [4, 40] } },
  // 힘이 '다음 탄 배수' 라는 규칙에 있다. dmg 로 밴드를 맞추면 26 → 203 이 되어
  // 다른 카드가 된다 — 배수 자체를 민다.
  sp_sanctified: { keys: ['mult'], min: 1.2, max: 12 },
  sp_cascade: { keys: ['mult', 'heat'], bounds: { mult: [1.2, 6], heat: [1.5, 12] } },
  sp_breach: { keys: ['dmg'], min: 36 },
  sp_solitary: { keys: ['bonus'] },
  sp_firststrike: { keys: ['bonus'] },
  sp_singularity: { keys: ['mul'], min: 1.5 },
  sp_judgment: { keys: ['dmg', 'mul'], bounds: { mul: [1.2, 3] } },

  // --- 총열 ---
  br_long: { keys: ['dmg'] },
  br_heavy: { keys: ['dmg'] },
  br_compensator: { keys: ['dmg'] },
  br_bayonet: { keys: ['dmg'] },
  br_catalyst: { keys: ['dmg'] },
  br_gambler: { keys: ['up', 'down'] },
  br_judgment: { keys: ['pct', 'max'] },
  br_volatile: { keys: ['dmg', 'step', 'max'] },
  br_frostbite: { keys: ['mul'] },
  br_archetype: { keys: ['pct'], max: 1 },

  // --- 총열덮개 ---
  hg_fin: { keys: ['heat'] },
  hg_catalyst: { keys: ['heat'] },
  hg_gas: { keys: ['heat'] },
  hg_relay: { keys: ['heat'] },
  hg_chain: { keys: ['step'] },
  hg_pyre: { keys: ['heat'] },
  hg_cryo: { keys: ['dmg'] },
  hg_furnace: { keys: ['heat'] },
  hg_martyr: { keys: ['heat', 'step', 'max'] },
  hg_twoshot: { keys: ['heat'] },
  hg_inquisition: { keys: ['heat', 'mult'], bounds: { mult: [1.1, 3] } },

  // --- 광학 ---
  op_laser: { keys: ['dmg'] },
  op_holywater: { keys: ['heat'] },
  op_thermal: { keys: ['dmg'] },
  op_deferral: { keys: ['dmg'] },
  op_inquest: { keys: ['dmg'] },
  op_lastrites: { keys: ['heat'] },
  op_poverty: { keys: ['heat'] },
  op_trinity: { keys: ['heat'] },
  op_pact: { keys: ['dmg'] },
  op_quartermaster: { keys: ['mags'], int: true, min: 1, max: 6 },
  op_soulmark: { keys: ['heat', 'step'] },
  op_vigil: { keys: ['step'] },
  op_frostvault: { keys: ['step'] },
  op_deathrite: { keys: ['heat'] },
  op_emperor: { keys: ['dmg', 'heat'] },

  // --- 개머리판 ---
  st_rangefinder: { keys: ['fireCost'], int: true, min: -3, max: -1 },
  st_fixed: { keys: ['startDist'], int: true, min: 1, max: 14 },
  st_charm: { keys: ['brass'], int: true, min: 1, max: 40 },
  st_buffer: { keys: ['startDist'], int: true, min: 1, max: 12 },
  st_penance: { keys: ['dmg'] },
  st_reliquary: { keys: ['startDist'], int: true, min: 1, max: 16 },
  st_stride: { keys: ['enemySpeed'], int: true, min: -3, max: -1 },
  st_bandolier: { keys: ['max', 'perMag'], int: true, min: 1, max: 8 },
  st_glacier: { keys: ['dmg'] },

  // --- 탄창: 용량은 성격이므로 고정하고, 얹는 값만 움직인다 ---
  mg_drum: { keys: ['heatMul'], min: 0.4, max: 1.0 },
  mg_precision: { keys: ['fireCost'], int: true, min: -2, max: 0 },
  mg_penitent: { keys: ['heat'] },
  mg_greed: { keys: ['keep'], min: 0.1, max: 0.85 },
  mg_coolant: { keys: ['carry'], min: 0.05, max: 0.5 },
  mg_executioner: { keys: ['startHeat'], min: 2, max: 90 },
  mg_annex: { keys: ['max'], int: true, min: 1, max: 6 },
  mg_unstable: { keys: ['heat'] },
  mg_belt: { keys: ['heatMul'], min: 0.4, max: 1.0 },
}

/** 눈금이 아예 없는 카드 — 규칙 자체가 값이라 수치로 못 민다 */
const STRUCTURAL = new Set(['mg_standard'])

/**
 * 눈금이 원래 값에서 벗어날 수 있는 최대 배수.
 *
 *   이게 없으면 튜너가 무한정 키운다. 조건이 드물게 켜지는 카드(두 발의 계율은
 *   발동률 16%)는 평균값이 목표에 잘 안 닿는데, 이분법은 닿을 때까지 배수를
 *   1.7^9 = 118배까지 벌린다. 그걸 7패스 반복하면 10^14 배가 되고, 실측에서
 *   여섯 장이 10^10 % 로 폭주했다 (증축 탄창 847억%).
 *
 *   ±8배 안에서 밴드에 못 닿는다면 그건 **눈금이 모자란 게 아니라 카드의 형태가
 *   틀린 것**이다 — 조건이 너무 까다롭거나 효과의 축이 잘못됐다. 숫자를 더 키우는
 *   대신 그 사실을 리포트로 알린다.
 */
const CLAMP = 8

// ---------------------------------------------------------------------------
function knob(id: string, key: string): { get(): number; set(v: number): void } | null {
  const ta = TA as unknown as Record<string, Record<string, number> | undefined>
  const tr = TR as unknown as Record<string, Record<string, number> | undefined>
  const g = ta[id] ?? tr[id]
  if (g === undefined || typeof g[key] !== 'number') return null
  return { get: () => g[key] as number, set: (v) => { g[key] = v } }
}

/** 세션 시작 시점의 눈금 — 절대 상한의 기준 */
const ORIGIN: Record<string, number> = (() => {
  const o: Record<string, number> = {}
  for (const k of allKnobs()) o[k.path] = k.get()
  return o
})()

function sync(): void {
  syncSpecials()
  syncAttachments()
  // 눈금이 바뀌면 '그 칸만 비운' 기준선도 바뀐다 — 캐시를 안 비우면 튜너가
  // 옛 기준선으로 새 값을 재게 되어 수렴이 엉뚱한 곳으로 간다.
  clearBaseCache()
}

/**
 * 탄창 칸은 **비울 수 없다** — 표준 5연발이 늘 깔려 있다. 그래서 탄창의 값은
 * '빈칸 대비' 가 아니라 '표준 대비' 로 잡히고, 밴드도 그만큼 내려야 한다.
 * (안 내리면 표준이 영원히 0.0 이고 나머지 탄창은 전부 미달로 찍힌다.)
 */
function bandFor(slot: string, rarity: Rarity): Band {
  // 개머리판은 축이 다르다 — 화력이 아니라 사격 횟수를 바꾼다
  if (slot === 'stock') return bands.STOCK_BANDS[rarity]
  if (slot !== 'magazine') return bands.ATTACH_BANDS[rarity]
  const base = bands.ATTACH_BANDS.common.mid
  const b = bands.ATTACH_BANDS[rarity]
  return { lo: Math.max(0, b.lo - base), mid: Math.max(0, b.mid - base), hi: Math.max(0, b.hi - base) }
}

// ---------------------------------------------------------------------------
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const padS = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
const f1 = (v: number): string => v.toFixed(1)

let CTX: Record<string, Ctx[]> = {}
function ctxFor(slot: string): Ctx[] {
  const k = slot === 'rail' ? 'optic' : slot
  return (CTX[k] ??= enumerateLoadouts(k as never, PROBE_STOCK))
}
function roundCtx(): Ctx[] {
  return (CTX['__round'] ??= enumerateLoadouts(null, PROBE_STOCK))
}

export function measureAll(): ItemValue[] {
  const out: ItemValue[] = []
  for (const a of ATTACHMENTS) out.push(valueOfAttachment(a, ctxFor(a.slot)))
  for (const s of SPECIALS) out.push(valueOfRound(s.id, roundCtx()))
  return out
}

function measureOne(id: string): number {
  const a = ATTACHMENTS.find((x) => x.id === id)
  if (a !== undefined) return valueOfAttachment(a, ctxFor(a.slot)).value
  const s = SPECIALS.find((x) => x.id === id)
  if (s !== undefined) return valueOfRound(s.id, roundCtx()).value
  return 0
}

function targetOf(v: ItemValue): Band {
  return v.slot === 'round' ? ROUND_BANDS[v.rarity] : bandFor(v.slot, v.rarity)
}

/**
 * 조건의 **임계**를 발동률로 맞춘다.
 *
 *   임계(thr)는 '성격' 이라 값 튜너가 건드리지 않는다. 그런데 조건이 아예 안 켜지면
 *   그건 성격이 아니라 죽은 카드다 — 실측에서 피의 계약 2% · 임종의 조준경 5% ·
 *   용광로 심장 6% · 총검 거치대 7% 가 그랬다. 페이로드를 아무리 키워도(피의 계약은
 *   DMG 27,176 까지 갔다) 평균값은 안 오르고 켜지는 2%만 터무니없어진다.
 *
 *   목표는 발동률 50% 다 — '절반쯤 켜져야 조건이다'. 방향(≥ 인가 ≤ 인가)은 카드마다
 *   다르므로 가정하지 않고, 배수 격자를 훑어 발동률이 0.5 에 가장 가까운 값을 고른다.
 */
const LIVE_TARGET = 0.5
const THR_GRID = [0.2, 0.35, 0.5, 0.7, 1, 1.45, 2, 2.8, 4]

function tuneThreshold(v: ItemValue): { from: number; to: number; live0: number; live1: number } | null {
  const k = knob(v.id, 'thr')
  if (k === null) return null
  const orig = k.get()
  if (orig === 0) return null
  let bestV = orig
  let bestLive = v.live
  let bestErr = Math.abs(v.live - LIVE_TARGET)
  for (const m of THR_GRID) {
    const cand = round3(orig * m)
    if (cand === orig) continue
    k.set(cand)
    sync()
    const live = liveOf(v.id)
    const err = Math.abs(live - LIVE_TARGET)
    if (err < bestErr) {
      bestErr = err
      bestV = cand
      bestLive = live
    }
  }
  k.set(bestV)
  sync()
  return bestV === orig ? null : { from: orig, to: bestV, live0: v.live, live1: bestLive }
}

function liveOf(id: string): number {
  const a = ATTACHMENTS.find((x) => x.id === id)
  if (a !== undefined) return valueOfAttachment(a, ctxFor(a.slot)).live
  const sp = SPECIALS.find((x) => x.id === id)
  if (sp !== undefined) return valueOfRound(sp.id, roundCtx()).live
  return 1
}

/**
 * 한 아이템을 밴드 중앙으로 민다 — 페이로드 눈금에 배수 m 을 걸고 이분법으로 찾는다.
 * 값이 m 에 대해 단조 증가라는 가정을 쓰는데, 조건부 카드도 페이로드는 단조다
 * (조건이 켜지는 빈도는 임계가 정하고 임계는 안 건드린다).
 */
function tuneItem(v: ItemValue): { from: string; to: string; before: number; after: number; pinned: boolean } | null {
  const p = PAYLOAD[v.id]
  if (p === undefined || STRUCTURAL.has(v.id)) return null
  const refs = p.keys.map((k) => knob(v.id, k)).filter((x): x is NonNullable<typeof x> => x !== null)
  if (refs.length === 0) return null
  const base = refs.map((r) => r.get())
  const from = base.map((b) => String(round3(b))).join('/')
  // 설계 원본(= 이 세션이 시작할 때의 값)에서 ±CLAMP 배를 넘지 않는다
  const origin = refs.map((r, i) => ORIGIN[v.id + '.' + p.keys[i]!] ?? base[i]!)
  let pinned = false

  const apply = (m: number): void => {
    pinned = false
    refs.forEach((r, i) => {
      let nv = base[i]! * m
      if (p.int === true) nv = Math.round(nv)
      if (p.min !== undefined) nv = Math.max(p.min, nv)
      if (p.max !== undefined) nv = Math.min(p.max, nv)
      const b = p.bounds?.[p.keys[i]!]
      if (b !== undefined) nv = Math.min(b[1], Math.max(b[0], nv))
      // 절대 상한 — 원본의 ±CLAMP 배
      const o = origin[i]!
      if (o !== 0) {
        const lo2 = Math.min(o / CLAMP, o * CLAMP)
        const hi2 = Math.max(o / CLAMP, o * CLAMP)
        const cl = Math.min(hi2, Math.max(lo2, nv))
        if (cl !== nv) pinned = true
        nv = cl
      }
      r.set(round3(nv))
    })
    sync()
  }

  const target = targetOf(v).mid
  const evalAt = (m: number): number => {
    apply(m)
    return measureOne(v.id)
  }

  // 브래킷 — 값이 목표를 사이에 두도록 배수를 벌린다
  let lo = 1
  let hi = 1
  let vLo = v.value
  let vHi = v.value
  if (v.value < target) {
    hi = 1
    for (let i = 0; i < 9 && vHi < target; i += 1) {
      lo = hi
      vLo = vHi
      hi *= 1.7
      vHi = evalAt(hi)
    }
  } else {
    lo = 1
    for (let i = 0; i < 9 && vLo > target; i += 1) {
      hi = lo
      vHi = vLo
      lo /= 1.7
      vLo = evalAt(lo)
    }
  }
  if (!(vLo <= target && target <= vHi)) {
    // 목표에 닿지 못하는 카드 (구조적 상한). 가장 가까운 쪽에 둔다.
    const mBest = Math.abs(vLo - target) < Math.abs(vHi - target) ? lo : hi
    apply(mBest)
    const after = measureOne(v.id)
    return { from, to: refs.map((r) => String(round3(r.get()))).join('/'), before: v.value, after, pinned }
  }
  for (let i = 0; i < 11; i += 1) {
    const mid = Math.sqrt(lo * hi)
    const vm = evalAt(mid)
    if (vm < target) {
      lo = mid
      vLo = vm
    } else {
      hi = mid
      vHi = vm
    }
  }
  const mFinal = Math.sqrt(lo * hi)
  apply(mFinal)
  const after = measureOne(v.id)
  return { from, to: refs.map((r) => String(round3(r.get()))).join('/'), before: v.value, after, pinned }
}

/**
 * 카드에 찍히는 수는 읽히는 자리까지만 남긴다 — '+34.8' 보다 '+35' 가 카드다.
 * 밴드 폭이 ±22% 라 이 정도 반올림은 판정을 바꾸지 않는다.
 */
function round3(v: number): number {
  const a = Math.abs(v)
  if (a >= 10) return Math.round(v)
  if (a >= 1) return Math.round(v * 100) / 100
  return Math.round(v * 1000) / 1000
}

// ---------------------------------------------------------------------------
export function report(vals: ItemValue[]): string {
  const L: string[] = []
  const line = (): void => { L.push('─'.repeat(84)) }

  L.push('① 부착물 — 처리량 증가율(%)')
  line()
  const atts = vals.filter((v) => v.slot !== 'round').sort((a, b) => b.value - a.value)
  let ok = 0
  for (const v of atts) {
    const b = targetOf(v)
    const m = STRUCTURAL.has(v.id) ? '⊙' : v.value < b.lo ? '⬇' : v.value > b.hi ? '⬆' : '✅'
    if (m === '✅' || m === '⊙') ok += 1
    L.push(
      '   ' + pad(v.name, 16) + pad(v.slot, 11) + pad(v.rarity, 10) + padS(f1(v.value), 8) +
        '  목표 ' + padS(f1(b.lo), 6) + '~' + padS(f1(b.hi), 6) + '  ' + m +
        '  발동 ' + padS((v.live * 100).toFixed(0) + '%', 5),
    )
  }
  L.push('   밴드 안 ' + ok + ' / ' + atts.length + '종')
  L.push('')

  L.push('② 탄 — 기본탄 배수')
  line()
  const rs = vals.filter((v) => v.slot === 'round').sort((a, b) => b.value - a.value)
  let rok = 0
  for (const v of rs) {
    const b = ROUND_BANDS[v.rarity]
    const m = v.value < b.lo ? '⬇' : v.value > b.hi ? '⬆' : '✅'
    if (m === '✅') rok += 1
    L.push(
      '   ' + pad(v.name, 14) + pad(v.rarity, 10) + padS(f1(v.value), 8) +
        '  목표 ' + padS(f1(b.lo), 6) + '~' + padS(f1(b.hi), 6) + '  ' + m +
        '  발동 ' + padS((v.live * 100).toFixed(0) + '%', 5),
    )
  }
  L.push('   밴드 안 ' + rok + ' / ' + rs.length + '종')
  L.push('')

  L.push('③ 등급별 — 평균이 단조 증가하고 퍼짐이 밴드 폭 안이어야 한다')
  line()
  for (const kind of ['부착물', '탄'] as const) {
    const pool = kind === '탄' ? rs : atts.filter((v) => !STRUCTURAL.has(v.id))
    L.push('   [' + kind + ']')
    for (const r of RARITIES) {
      const v = pool.filter((x) => x.rarity === r).map((x) => x.value)
      if (v.length === 0) continue
      const avg = v.reduce((a, b) => a + b, 0) / v.length
      const lo = Math.min(...v)
      const hi = Math.max(...v)
      L.push(
        '     ' + pad(r, 10) + 'n=' + pad(String(v.length), 4) +
          '최저 ' + padS(f1(lo), 7) + '  평균 ' + padS(f1(avg), 7) + '  최고 ' + padS(f1(hi), 7) +
          '  폭 ×' + (hi / Math.max(0.01, lo)).toFixed(1),
      )
    }
  }
  L.push('')
  L.push('④ 죽은 선택지 — 어떤 조합에서도 값이 안 나오는 것')
  line()
  const dead = vals.filter((v) => v.live < 0.02 && !STRUCTURAL.has(v.id))
  if (dead.length === 0) L.push('   없음')
  for (const v of dead) L.push('   ' + pad(v.name, 16) + pad(v.rarity, 10) + padS(f1(v.value), 8))

  // ⑤ 상태 커버리지 — 정답이 하나인가
  L.push('')
  L.push('⑤ 상태 커버리지 — 조합마다 최선의 한 발. 승자가 1종이면 결정이 없다')
  line()
  const cov = coverage(SPECIALS.map((x) => x.id), roundCtx())
  const byW = Object.entries(cov.winner).sort((a, b) => b[1] - a[1])
  for (const [id, w] of byW) {
    const nm = SPECIALS.find((x) => x.id === id)?.name ?? id
    L.push('   ' + pad(nm, 14) + padS((w * 100).toFixed(1) + '%', 8) + '  의 조합에서 최선')
  }
  L.push('   서로 다른 승자 ' + cov.distinct + '종 / 탄 ' + SPECIALS.length + '종' +
    (cov.distinct <= 2 ? '  ← 사실상 정답이 하나다' : ''))

  // ⑥ 순서 민감도
  L.push('')
  L.push('⑥ 순서 민감도 — 같은 묶음의 최선/최악 배열 비. 1.0 이면 배열이 무의미하다')
  line()
  const refL = roundCtx()[0]!.loadout
  let sumFirst = 0
  let sumCarry = 0
  for (const b of BUNDLES) {
    const h = steadyHeat(b.ids, refL)
    const a1 = orderSensitivity(b.ids, refL, 1.0)
    const a2 = orderSensitivity(b.ids, refL, h)
    sumFirst += a1
    sumCarry += a2
    L.push('   ' + pad(b.name, 24) + '첫 탄창 ' + padS(f1(a1) + 'x', 7) + '   이월(H*=' + f1(h) + ') ' + padS(f1(a2) + 'x', 7))
  }
  L.push('   평균  첫 탄창 ' + f1(sumFirst / BUNDLES.length) + 'x   이월 ' + f1(sumCarry / BUNDLES.length) + 'x')
  return L.join('\n')
}

/** 대표 묶음 — 한 묶음만 보면 그 묶음을 평평하게 만든 것이 지표 하락으로 잘못 읽힌다 */
const BUNDLES: Array<{ name: string; ids: string[] }> = [
  { name: '구 지배조합(소이·철갑·점착)', ids: ['sp_incendiary', 'sp_ap', 'sp_adhesive'] },
  { name: '예열·관통·표식', ids: ['sp_thermite', 'sp_breach', 'sp_marker'] },
  { name: '냉동·유일·충격', ids: ['sp_cryo', 'sp_solitary', 'sp_shock'] },
  { name: '성탄·철갑·소이', ids: ['sp_sanctified', 'sp_ap', 'sp_incendiary'] },
]

function dumpKnobs(): string {
  const L: string[] = ['════ 수렴된 눈금 ════']
  for (const k of allKnobs()) L.push('  ' + pad(k.path, 28) + padS(String(k.get()), 10))
  return L.join('\n')
}

// ---------------------------------------------------------------------------
function main(): void {
  const argv = process.argv.slice(2)
  const passes = (() => {
    for (const a of argv) {
      const m = /^--tune=(\d+)$/.exec(a)
      if (m !== null) return parseInt(m[1]!, 10)
    }
    return 0
  })()

  // eslint-disable-next-line no-console
  const out = (s: string): void => console.log(s)

  // 밴드의 바닥 못을 **잰다** — '탄창에 기본탄 한 발' 이 이 지표에서 몇 %인가.
  // 못은 아이템과 **같은 앙상블**에서, 그러나 **세션당 한 번만** 잰다.
  //   맨총에서 재면 단위가 어긋나고(33.9%), 패스마다 재면 발산한다.
  // 못은 **못 박힌 보정 상수**다 (bands.ANCHOR.attach). 자동으로 다시 재지 않는다 —
  //   목표가 튜닝 대상의 함수가 되면 발산한다 (패스마다 재면 5억%, 세션마다 재도 2.3배).
  //   지금 카탈로그에서의 값은 **진단용으로만** 찍는다: 못에서 크게 벌어졌다면
  //   카탈로그 전체의 화력이 움직였다는 신호이지, 밴드를 따라 옮기라는 뜻이 아니다.
  const anchor = bands.ANCHOR.attach
  const live = measureAttachAnchor(ctxFor('barrel'))
  const liveAct = measureActionAnchor(ctxFor('stock'))
  out('바닥 못(고정)  화력축 +' + anchor.toFixed(1) + '%  ·  경제축 +' + bands.ANCHOR.stock.toFixed(1) + '%')
  out('  지금 카탈로그 실측  화력축 +' + live.toFixed(1) + '%  ·  경제축 +' + liveAct.toFixed(1) + '%  (진단용)')
  out('')
  out(bands.report())
  out('')

  if (passes === 0) {
    out('════ 현재 카탈로그 측정 ════')
    out(report(measureAll()))
    return
  }

  for (let pass = 1; pass <= passes; pass += 1) {
    const vals = measureAll()
    const off = vals.filter((v) => {
      if (STRUCTURAL.has(v.id)) return false
      const b = targetOf(v)
      return v.value < b.lo || v.value > b.hi
    })
    out('════ 패스 ' + pass + ' — 밴드 밖 ' + off.length + ' / ' + vals.length + '종 (못 ' + anchor.toFixed(0) + '%) ════')

    // ① 먼저 **조건이 켜지게** 만든다. 안 켜지는 조건 위에서는 값을 아무리 밀어도
    //    평균이 안 움직이고 켜지는 소수 상황만 터무니없어진다.
    //    단 **첫 패스에서만** 한다. 매 패스 돌리면 임계도 되먹임이 된다 — 값을 밀면
    //    발동률이 바뀌고, 임계를 옮기면 값이 다시 바뀐다. 실측에서 밴드 밖이
    //    23 → 41 → 37 → … → 23 으로 진동만 하고 개선되지 않았다.
    //    임계는 '어느 범위에서 켜지는가' 라는 **성격**이므로 한 번 정하면 고정이다.
    for (const v of pass === 1 ? vals : []) {
      // **부착물만**, 그리고 **너무 안 켜질 때만** 손댄다.
      //   탄의 발동률은 조건이 아니라 기본 피해까지 세므로 늘 100% 로 찍힌다 —
      //   그 신호로 임계를 쫓으면 튜너가 '덜 켜지게' 하려고 임계를 0 까지 끌고 간다
      //   (실측: 초탄 6 → 0.01, 냉동탄 18 → 0.72 로 카드가 죽었다).
      //   그리고 '너무 자주 켜진다' 는 고칠 문제가 아니다 — 조건이 헐거우면 값이
      //   높게 잡히고, 그건 페이로드를 낮춰서 답할 일이다.
      if (v.slot === 'round') continue
      if (v.live >= 0.25) continue
      const t = tuneThreshold(v)
      if (t === null) continue
      out(
        '   [임계] ' + pad(v.name, 14) + padS(String(t.from), 8) + ' → ' + padS(String(t.to), 8) +
          '   발동 ' + (t.live0 * 100).toFixed(0) + '% → ' + (t.live1 * 100).toFixed(0) + '%',
      )
    }
    // 가장 크게 벗어난 것부터 — 그것이 다른 아이템의 측정 맥락도 가장 크게 흔든다
    off.sort((a, b) => devi(b) - devi(a))
    for (const v of off) {
      const r = tuneItem(v)
      if (r === null) continue
      out(
        '   ' + pad(v.name, 16) + padS(f1(r.before), 10) + ' → ' + padS(f1(r.after), 10) +
          '   눈금 ' + pad(r.from, 16) + ' → ' + pad(r.to, 16) + (r.pinned ? '  ⚠ 한계' : ''),
      )
    }
    out('')
  }
  // 가격은 밴드가 아니라 **측정값**에 맞춘다 — 같은 등급이어도 실제로 센 것이 비싸야
  // 정비소가 저울이 된다. 눈금은 sim/bands.ts 의 사다리(희소 프리미엄 α=0.15)다.
  const finalVals = measureAll()
  const ladder = bands.priceLadder(16)
  for (const v of finalVals) {
    if (v.slot !== 'round') continue
    const k = knob(v.id, 'price')
    if (k === null) continue
    const ratio = v.value / Math.max(0.1, ROUND_BANDS[v.rarity].mid)
    k.set(Math.max(6, Math.round(ladder[v.rarity] * ratio)))
  }
  sync()

  out('════ 수렴 후 측정 ════')
  out(report(finalVals))
  out('')
  out(dumpKnobs())
}

function devi(v: ItemValue): number {
  const b = targetOf(v)
  if (v.value < b.lo) return (b.lo - v.value) / Math.max(0.01, b.mid)
  if (v.value > b.hi) return (v.value - b.hi) / Math.max(0.01, b.mid)
  return 0
}

main()

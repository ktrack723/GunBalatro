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
import { ATTACH_BANDS, ROUND_BANDS, RARITIES, type Band } from './bands'
import * as bands from './bands'
import {
  type Ctx,
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
}

const PAYLOAD: Record<string, Payload> = {
  // --- 탄: 기본 dmg/heat 가 곧 세기다. 훅이 있는 탄은 훅 쪽이 페이로드다 ---
  sp_incendiary: { keys: ['heat'] },
  sp_ap: { keys: ['dmg'] },
  sp_shock: { keys: ['knock', 'cap'] },
  sp_adhesive: { keys: ['bonus'] },
  sp_thermite: { keys: ['heat'] },
  sp_marker: { keys: ['vuln'] },
  sp_chill: { keys: ['dmg'] },
  sp_cryo: { keys: ['mul'] },
  sp_purge: { keys: ['mul'] },
  sp_sanctified: { keys: ['dmg'] },
  sp_cascade: { keys: ['heat'] },
  sp_breach: { keys: ['dmg'] },
  sp_solitary: { keys: ['bonus'] },
  sp_firststrike: { keys: ['bonus'] },
  sp_singularity: { keys: ['mul'] },
  sp_judgment: { keys: ['mul'] },

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
  hg_inquisition: { keys: ['heat'] },

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
  st_bandolier: { keys: ['max'], int: true, min: 1, max: 6 },
  st_glacier: { keys: ['dmg'] },

  // --- 탄창: 용량은 성격이므로 고정하고, 얹는 값만 움직인다 ---
  mg_drum: { keys: ['heatMul'], min: 0.4, max: 1.0 },
  mg_precision: { keys: ['heat'] },
  mg_penitent: { keys: ['heat'] },
  mg_greed: { keys: ['keep'], min: 0.1, max: 0.85 },
  mg_coolant: { keys: ['carry'], min: 0.05, max: 0.5 },
  mg_executioner: { keys: ['startHeat'], min: 2, max: 60 },
  mg_annex: { keys: ['max'], int: true, min: 1, max: 6 },
  mg_unstable: { keys: ['heat'] },
  mg_belt: { keys: ['heatMul'], min: 0.4, max: 1.0 },
}

/** 눈금이 아예 없는 카드 — 규칙 자체가 값이라 수치로 못 민다 */
const STRUCTURAL = new Set(['mg_standard'])

// ---------------------------------------------------------------------------
function knob(id: string, key: string): { get(): number; set(v: number): void } | null {
  const ta = TA as unknown as Record<string, Record<string, number> | undefined>
  const tr = TR as unknown as Record<string, Record<string, number> | undefined>
  const g = ta[id] ?? tr[id]
  if (g === undefined || typeof g[key] !== 'number') return null
  return { get: () => g[key] as number, set: (v) => { g[key] = v } }
}

function sync(): void {
  syncSpecials()
  syncAttachments()
}

/**
 * 탄창 칸은 **비울 수 없다** — 표준 5연발이 늘 깔려 있다. 그래서 탄창의 값은
 * '빈칸 대비' 가 아니라 '표준 대비' 로 잡히고, 밴드도 그만큼 내려야 한다.
 * (안 내리면 표준이 영원히 0.0 이고 나머지 탄창은 전부 미달로 찍힌다.)
 */
function bandFor(slot: string, rarity: Rarity): Band {
  if (slot !== 'magazine') return ATTACH_BANDS[rarity]
  const base = ATTACH_BANDS.common.mid
  const b = ATTACH_BANDS[rarity]
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
 * 한 아이템을 밴드 중앙으로 민다 — 페이로드 눈금에 배수 m 을 걸고 이분법으로 찾는다.
 * 값이 m 에 대해 단조 증가라는 가정을 쓰는데, 조건부 카드도 페이로드는 단조다
 * (조건이 켜지는 빈도는 임계가 정하고 임계는 안 건드린다).
 */
function tuneItem(v: ItemValue): { from: string; to: string; before: number; after: number } | null {
  const p = PAYLOAD[v.id]
  if (p === undefined || STRUCTURAL.has(v.id)) return null
  const refs = p.keys.map((k) => knob(v.id, k)).filter((x): x is NonNullable<typeof x> => x !== null)
  if (refs.length === 0) return null
  const base = refs.map((r) => r.get())
  const from = base.map((b) => String(round3(b))).join('/')

  const apply = (m: number): void => {
    refs.forEach((r, i) => {
      let nv = base[i]! * m
      if (p.int === true) nv = Math.round(nv)
      if (p.min !== undefined) nv = Math.max(p.min, nv)
      if (p.max !== undefined) nv = Math.min(p.max, nv)
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
    return { from, to: refs.map((r) => String(round3(r.get()))).join('/'), before: v.value, after }
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
  return { from, to: refs.map((r) => String(round3(r.get()))).join('/'), before: v.value, after }
}

function round3(v: number): number {
  const a = Math.abs(v)
  if (a >= 100) return Math.round(v)
  if (a >= 10) return Math.round(v * 10) / 10
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
    out('════ 패스 ' + pass + ' — 밴드 밖 ' + off.length + ' / ' + vals.length + '종 ════')
    // 가장 크게 벗어난 것부터 — 그것이 다른 아이템의 측정 맥락도 가장 크게 흔든다
    off.sort((a, b) => devi(b) - devi(a))
    for (const v of off) {
      const r = tuneItem(v)
      if (r === null) continue
      out(
        '   ' + pad(v.name, 16) + padS(f1(r.before), 8) + ' → ' + padS(f1(r.after), 8) +
          '   눈금 ' + pad(r.from, 16) + ' → ' + r.to,
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

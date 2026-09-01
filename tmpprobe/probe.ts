// 스크래치 계측기 — 부착물/탄창의 "장착 시 화력 증가분"을 직접 잰다. (게임 코드는 안 건드린다)
import type { Ammo, Attachment, Grade, Loadout, Magazine, AmmoType, EnemyInstance } from '../src/core/types'
import { NODE_MUL } from '../src/core/types'
import { makeAmmo, nextUid, resetUidCounter } from '../src/core/ammoStats'
import { ATTACHMENTS, ATT_BY_ID } from '../src/core/data/attachments'
import { MAGAZINES, MAG_BY_ID } from '../src/core/data/magazines'
import { makeEnemy } from '../src/core/data/enemies'
import { startCombat } from '../src/core/combat'
import { estimateMagDamage } from '../src/sim/bot'
import { makeRng } from '../src/core/rng'
import { computeFireCost, computeStartDistance, computeEnemySpeed } from '../src/core/pipeline'

/** 섹터에 어울리는 20발 가방 (등급 분포를 섹터에 맞춰 올린다) */
function bagFor(sector: number): Ammo[] {
  const g = (base: number): Grade => Math.max(1, Math.min(5, Math.round(base))) as Grade
  const lo = g(1 + (sector - 1) * 0.42)
  const hi = g(2 + (sector - 1) * 0.45)
  const bag: Ammo[] = []
  const comp: [AmmoType, Grade, number][] = [
    ['AP', lo, 3], ['AP', hi, 2],
    ['INC', lo, 4], ['INC', hi, 3],
    ['HE', lo, 3], ['HE', hi, 1],
    ['SANC', lo, 2], ['SANC', hi, 2],
  ]
  for (const [t, gg, n] of comp) for (let i = 0; i < n; i++) bag.push(makeAmmo(t, gg, nextUid()))
  return bag
}

function mkLoadout(sector: number, mag: Magazine, atts: (Attachment | null)[], railSlots = 2): Loadout {
  const l: Loadout = {
    barrel: null, handguard: null, optic: null, stock: null,
    rails: new Array<Attachment | null>(railSlots).fill(null),
    railSlots, magazine: mag, bag: bagFor(sector), brass: 0,
  }
  let ri = 0
  for (const a of atts) {
    if (a === null) continue
    if (a.slot === 'rail') { if (ri < railSlots) l.rails[ri++] = a }
    else (l as unknown as Record<string, Attachment>)[a.slot] = a
  }
  return l
}

interface Measure { perMag: number; through: number }

function measure(sector: number, l: Loadout, taken = 6, runVars: Record<string, number> = {}): Measure {
  const probe: EnemyInstance = makeEnemy({ archetypeId: 'shambler', passiveId: null, sector, nodeMul: NODE_MUL.big, threat: 1 })
  const s = startCombat(l, probe, makeRng(0x5eed + sector), {
    startDistDelta: 0, heatStartDelta: 0, runVars: { ...runVars }, attachmentsTaken: taken,
  })
  const perMag = estimateMagDamage(s, 'greedy')
  const actions = Math.max(1, Math.floor(s.distance / Math.max(1, s.fireCost)))
  const need = Math.ceil(probe.maxHp / Math.max(1, perMag))
  const usable = Math.min(actions, need + 1)
  return { perMag, through: perMag * usable }
}

/** 여러 시드/섹터로 평균 — 단일 표본 노이즈를 줄인다 */
function avgMeasure(sectors: number[], mag: Magazine, atts: (Attachment | null)[], taken = 6, runVars: Record<string, number> = {}): Measure {
  let p = 0, t = 0
  for (const sec of sectors) {
    resetUidCounter()
    const m = measure(sec, mkLoadout(sec, mag, atts), taken, runVars)
    p += m.perMag; t += m.through
  }
  return { perMag: p / sectors.length, through: t / sectors.length }
}

const MODE = process.argv[2] ?? 'att'
const SECTORS = [3, 5, 7]

// 대표 "중간 빌드" — 각 부위에 평범한 것 하나씩
const BASE_IDS = ['br_long_barrel', 'hg_heat_fin', 'op_iron_sight', 'st_fixed_stock', 'rl_holy_water']
const BASE = BASE_IDS.map((id) => ATT_BY_ID[id])

function fmt(n: number): string { return n.toFixed(0).padStart(9) }
function pctS(n: number): string { return (n * 100).toFixed(1).padStart(7) + '%' }

if (MODE === 'att') {
  const magIds = (process.argv[3] ?? 'm1').split(',')
  for (const mid of magIds) {
    const mag = MAG_BY_ID[mid]
    const base = avgMeasure(SECTORS, mag, BASE)
    console.log(`\n== 탄창 ${mag.name} (cap ${mag.cap}) · 기준 perMag ${base.perMag.toFixed(0)} / through ${base.through.toFixed(0)}`)
    const rows: { name: string; slot: string; rar: string; dp: number; dt: number }[] = []
    for (const a of ATTACHMENTS) {
      const atts = BASE.filter((b) => b.slot !== a.slot || a.slot === 'rail').concat([a])
      const m = avgMeasure(SECTORS, mag, atts)
      rows.push({ name: a.name, slot: a.slot, rar: a.rarity, dp: m.perMag / base.perMag - 1, dt: m.through / base.through - 1 })
    }
    rows.sort((x, y) => y.dt - x.dt)
    for (const r of rows) {
      console.log(`${r.name.padEnd(20)}${r.slot.padEnd(11)}${r.rar.padEnd(10)}  ΔperMag ${pctS(r.dp)}   Δthrough ${pctS(r.dt)}`)
    }
  }
} else if (MODE === 'mag') {
  const attIds = (process.argv[3] ?? BASE_IDS.join(',')).split(',')
  const atts = attIds.map((id) => ATT_BY_ID[id]).filter(Boolean)
  console.log('빌드: ' + atts.map((a) => a.name).join(' / '))
  const ref = avgMeasure(SECTORS, MAG_BY_ID['m1'], atts)
  const rows: { name: string; cap: number; p: number; t: number }[] = []
  for (const mag of MAGAZINES) {
    const m = avgMeasure(SECTORS, mag, atts)
    rows.push({ name: mag.name, cap: mag.cap, p: m.perMag / ref.perMag, t: m.through / ref.through })
  }
  rows.sort((x, y) => y.t - x.t)
  for (const r of rows) console.log(`${r.name.padEnd(16)}cap${String(r.cap).padStart(2)}   perMag ${r.p.toFixed(2)}x   through ${r.t.toFixed(2)}x`)
}

// ============================================================================
// 저장 / 복원 (localStorage)
//   함수를 가진 객체(부착물·특수탄·패시브)는 전부 id(string)로 눕히고,
//   복원할 때 카탈로그에서 되찾는다. 이게 이 파일의 가장 중요한 요구사항이다.
//   저장은 노드 경계에서만 한다 — 전투 중 저장을 허용하면 "죽기 직전 앱 종료"가 가능해진다.
// ============================================================================
import type { Loadout, RunState, RunStats } from '../core/types'
import { MAX_RAIL_SLOTS } from '../core/types'
import { ATT_BY_ID, STARTER_MAGAZINE } from '../core/data/attachments'
import { SPECIAL_BY_ID, startingSpecials } from '../core/data/specials'
import { newRun } from '../core/run'

const K_RUN = 'gb.run'
const K_META = 'gb.meta'
const SCHEMA = 3

function ls(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read(key: string): unknown {
  const st = ls()
  if (st === null) return null
  try {
    const raw = st.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  const st = ls()
  if (st === null) return
  try {
    st.setItem(key, JSON.stringify(value))
  } catch {
    /* 용량 초과 등 — 저장 실패는 게임을 멈추지 않는다 */
  }
}

// ---------------------------------------------------------------------------
export interface MetaState {
  bestSector: number
  wins: number
  unlockedStake: number
  runs: number
}

export const DEFAULT_META: MetaState = {
  bestSector: 0,
  wins: 0,
  unlockedStake: 1,
  runs: 0,
}

// ---------------------------------------------------------------------------
// 직렬화 형태
// ---------------------------------------------------------------------------
interface SavedLoadout {
  barrel: string | null
  handguard: string | null
  optic: string | null
  stock: string | null
  magazine: string | null
  rails: (string | null)[]
  railSlots: number
  stash: string[]
  specials: Record<string, number>
  brass: number
}

interface SavedRun {
  v: number
  seed: number
  sector: number
  nodeIndex: number
  stake: number
  status: RunState['status']
  bossPassiveId: string | null
  relicsSeen: number
  rngState: number
  attachmentsTaken: number
  attVars: Record<string, number>
  pending: RunState['pending']
  sectorMods: RunState['sectorMods']
  stats: RunStats
  loadout: SavedLoadout
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function rec(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null) return {}
  const out: Record<string, number> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'number' && Number.isFinite(val)) out[k] = val
  }
  return out
}

function encodeLoadout(l: Loadout): SavedLoadout {
  return {
    barrel: l.barrel?.id ?? null,
    handguard: l.handguard?.id ?? null,
    optic: l.optic?.id ?? null,
    stock: l.stock?.id ?? null,
    magazine: l.magazine?.id ?? null,
    rails: l.rails.map((r) => r?.id ?? null),
    railSlots: l.railSlots,
    stash: l.stash.map((a) => a.id),
    specials: { ...l.specials },
    brass: l.brass,
  }
}

function decodeLoadout(raw: unknown): Loadout {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SavedLoadout>
  const att = (id: unknown): Loadout['barrel'] =>
    typeof id === 'string' ? (ATT_BY_ID[id] ?? null) : null

  const railSlots = Math.max(0, Math.min(MAX_RAIL_SLOTS, num(o.railSlots, 0)))
  const rails: Loadout['rails'] = []
  const rawRails = Array.isArray(o.rails) ? o.rails : []
  for (let i = 0; i < railSlots; i += 1) rails.push(att(rawRails[i]))

  const specials: Record<string, number> = {}
  for (const [k, v] of Object.entries(rec(o.specials))) {
    if (SPECIAL_BY_ID[k] !== undefined && v > 0) specials[k] = Math.floor(v)
  }

  const stash: Loadout['stash'] = []
  if (Array.isArray(o.stash)) {
    for (const id of o.stash) {
      const a = att(id)
      if (a !== null) stash.push(a)
    }
  }

  return {
    barrel: att(o.barrel),
    handguard: att(o.handguard),
    optic: att(o.optic),
    stock: att(o.stock),
    magazine: att(o.magazine) ?? STARTER_MAGAZINE,
    rails,
    railSlots,
    stash,
    specials: Object.keys(specials).length > 0 ? specials : startingSpecials(),
    brass: Math.max(0, num(o.brass, 0)),
  }
}

// ---------------------------------------------------------------------------
export function saveRun(run: RunState): void {
  const payload: SavedRun = {
    v: SCHEMA,
    seed: run.seed,
    sector: run.sector,
    nodeIndex: run.nodeIndex,
    stake: run.stake,
    status: run.status,
    bossPassiveId: run.bossPassiveId,
    relicsSeen: run.relicsSeen,
    rngState: run.rngState,
    attachmentsTaken: run.attachmentsTaken,
    attVars: { ...run.attVars },
    pending: { ...run.pending },
    sectorMods: { ...run.sectorMods },
    stats: { ...run.stats },
    loadout: encodeLoadout(run.loadout),
  }
  write(K_RUN, payload)
}

export function clearRun(): void {
  const st = ls()
  if (st === null) return
  try {
    st.removeItem(K_RUN)
  } catch {
    /* noop */
  }
}

export function loadRun(): RunState | null {
  const raw = read(K_RUN)
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Partial<SavedRun>
  // 스키마가 다르면 진행 중인 런만 폐기한다 (메타는 그대로 둔다)
  if (num(o.v, 0) !== SCHEMA) {
    clearRun()
    return null
  }

  const run = newRun(num(o.seed, 1), num(o.stake, 1))
  run.sector = Math.max(1, num(o.sector, 1))
  run.nodeIndex = Math.max(0, num(o.nodeIndex, 0))
  run.status = o.status === 'dead' || o.status === 'won' ? o.status : 'alive'
  run.bossPassiveId = typeof o.bossPassiveId === 'string' ? o.bossPassiveId : run.bossPassiveId
  run.relicsSeen = Math.max(0, num(o.relicsSeen, 0))
  run.rngState = num(o.rngState, run.rngState)
  run.attachmentsTaken = Math.max(0, num(o.attachmentsTaken, 0))
  run.attVars = rec(o.attVars)
  run.pending = {
    startDistDelta: num(o.pending?.startDistDelta, 0),
    heatStartDelta: num(o.pending?.heatStartDelta, 0),
  }
  run.sectorMods = {
    startDistDelta: num(o.sectorMods?.startDistDelta, 0),
    heatStartDelta: num(o.sectorMods?.heatStartDelta, 0),
  }
  const st = o.stats
  run.stats = {
    combatsWon: num(st?.combatsWon, 0),
    shotsFired: num(st?.shotsFired, 0),
    peakHeat: num(st?.peakHeat, 0),
    totalDamage: num(st?.totalDamage, 0),
    brassEarned: num(st?.brassEarned, 0),
    specialsUsed: num(st?.specialsUsed, 0),
  }
  run.loadout = decodeLoadout(o.loadout)
  run.doors = null
  return run
}

export function hasSave(): boolean {
  const raw = read(K_RUN)
  if (typeof raw !== 'object' || raw === null) return false
  const o = raw as Partial<SavedRun>
  return num(o.v, 0) === SCHEMA && o.status === 'alive'
}

// ---------------------------------------------------------------------------
export function saveMeta(m: MetaState): void {
  write(K_META, m)
}

export function loadMeta(): MetaState {
  const raw = read(K_META)
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_META }
  const o = raw as Partial<MetaState>
  return {
    bestSector: Math.max(0, num(o.bestSector, 0)),
    wins: Math.max(0, num(o.wins, 0)),
    unlockedStake: Math.max(1, Math.min(8, num(o.unlockedStake, 1))),
    runs: Math.max(0, num(o.runs, 0)),
  }
}

export function recordResult(run: RunState, won: boolean): MetaState {
  const m = loadMeta()
  m.runs += 1
  if (run.sector > m.bestSector) m.bestSector = run.sector
  if (won) {
    m.wins += 1
    m.unlockedStake = Math.max(m.unlockedStake, Math.min(8, run.stake + 1))
  }
  saveMeta(m)
  clearRun()
  return m
}

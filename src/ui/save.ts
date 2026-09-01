// 저장/복원 — localStorage 'gb.run' (진행 중 런) / 'gb.meta' (해금·통계).
//
// ★ 이 파일의 가장 중요한 규칙:
//   부착물·탄창·패시브는 **함수(훅)를 들고 있는 객체**다. JSON 으로 굽는 순간 훅이 사라진다.
//   그래서 저장할 때는 id 만 남기고, 복원할 때 카탈로그(ATT_BY_ID / MAG_BY_ID)에서 되찾는다.
//   탄(Ammo)·통계·좌표처럼 순수 데이터만 그대로 직렬화한다.
//
// 스키마 버전이 다르면 **런만 폐기**한다. 메타는 필드 단위로 살려서 마이그레이션한다
// (해금과 최고 기록을 버전 올릴 때마다 날리면 플레이어가 돌아오지 않는다).

import type {
  Ammo,
  AmmoType,
  Attachment,
  DoorOption,
  EnemyArchetypeId,
  Grade,
  Loadout,
  Magazine,
  NodeKind,
  Rarity,
  RunState,
  RunStats,
  Threat,
} from '../core/types'
import { ATT_BY_ID } from '../core/data/attachments'
import { MAG_BY_ID, STARTER_MAGAZINE } from '../core/data/magazines'
import { PASSIVE_BY_ID, ARCH_BY_ID } from '../core/data/enemies'
import { nextUid, resetUidCounter } from '../core/ammoStats'

export const RUN_KEY = 'gb.run'
export const META_KEY = 'gb.meta'

/** 런 스냅샷 스키마 버전. 세이브 구조가 바뀌면 올린다 → 옛 런은 폐기된다. */
export const RUN_VERSION = 1
/** 메타 스키마 버전. 올려도 메타는 마이그레이션된다. */
export const META_VERSION = 1

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
// 직렬화 형태 — 함수를 가진 객체는 전부 id(string) 로 눕는다
// ---------------------------------------------------------------------------

interface SavedAmmo {
  u: string
  t: AmmoType
  g: Grade
}

interface SavedLoadout {
  barrel: string | null
  handguard: string | null
  optic: string | null
  stock: string | null
  /** 길이 == railSlots. 빈 칸은 null */
  rails: (string | null)[]
  railSlots: number
  /** 탄창 id */
  magazine: string
  bag: SavedAmmo[]
  brass: number
}

interface SavedRun {
  v: number
  seed: number
  sector: number
  nodeIndex: number
  loadout: SavedLoadout
  doors: DoorOption[] | null
  current: NodeKind | null
  stake: number
  stats: RunStats
  bossPassiveId: string | null
  status: 'alive' | 'dead' | 'won'
  relicsSeen: number
  removals: number
  rngState: number
  pending: { startDistDelta: number; heatStartDelta: number }
  sectorMods: { heatStartDelta: number; startDistDelta: number }
  attVars: Record<string, number>
  attachmentsTaken: number
}

// ---------------------------------------------------------------------------
// 파싱 도우미 (저장소는 언제든 오염될 수 있다고 가정한다)
// ---------------------------------------------------------------------------

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function num(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fb
}

function int(v: unknown, fb: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fb
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

const TYPES: readonly AmmoType[] = ['AP', 'INC', 'HE', 'SANC']
const NODES: readonly NodeKind[] = ['combat', 'armory', 'reliquary', 'derelict', 'boss']
const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'relic']

function asType(v: unknown): AmmoType | null {
  return typeof v === 'string' && (TYPES as readonly string[]).includes(v) ? (v as AmmoType) : null
}

function asGrade(v: unknown): Grade | null {
  if (typeof v !== 'number') return null
  const g = Math.floor(v)
  return g >= 1 && g <= 5 ? (g as Grade) : null
}

function asNode(v: unknown): NodeKind | null {
  return typeof v === 'string' && (NODES as readonly string[]).includes(v) ? (v as NodeKind) : null
}

function asThreat(v: unknown): Threat {
  const n = int(v, 1)
  return n <= 1 ? 1 : n >= 3 ? 3 : 2
}

function asRarity(v: unknown): Rarity {
  return typeof v === 'string' && (RARITIES as readonly string[]).includes(v)
    ? (v as Rarity)
    : 'common'
}

function asArchetype(v: unknown): EnemyArchetypeId | null {
  const s = str(v)
  if (s === null) return null
  return s in ARCH_BY_ID ? (s as EnemyArchetypeId) : null
}

function asNumberMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRec(v)) return out
  for (const k of Object.keys(v)) {
    const n = v[k]
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n
  }
  return out
}

// ---------------------------------------------------------------------------
// 저장
// ---------------------------------------------------------------------------

function attId(a: Attachment | null): string | null {
  return a === null ? null : a.id
}

function dumpLoadout(l: Loadout): SavedLoadout {
  return {
    barrel: attId(l.barrel),
    handguard: attId(l.handguard),
    optic: attId(l.optic),
    stock: attId(l.stock),
    rails: l.rails.map(attId),
    railSlots: l.railSlots,
    magazine: l.magazine.id,
    bag: l.bag.map((a) => ({ u: a.uid, t: a.type, g: a.grade })),
    brass: Math.round(l.brass),
  }
}

function writeKey(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 용량 초과/프라이빗 모드 — 저장 실패로 게임을 멈추지 않는다
  }
}

function readKey(key: string): unknown {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 노드 단위 저장 (TECH §5). 전투 도중에는 부르지 않는다. */
export function saveRun(run: RunState): void {
  const snap: SavedRun = {
    v: RUN_VERSION,
    seed: run.seed,
    sector: run.sector,
    nodeIndex: run.nodeIndex,
    loadout: dumpLoadout(run.loadout),
    doors: run.doors,
    current: run.current,
    stake: run.stake,
    stats: { ...run.stats },
    bossPassiveId: run.bossPassiveId,
    status: run.status,
    relicsSeen: run.relicsSeen,
    removals: run.removals,
    rngState: run.rngState,
    pending: { ...run.pending },
    sectorMods: { ...run.sectorMods },
    attVars: { ...run.attVars },
    attachmentsTaken: run.attachmentsTaken,
  }
  writeKey(RUN_KEY, snap)
}

export function clearRun(): void {
  try {
    localStorage.removeItem(RUN_KEY)
  } catch {
    // 무시
  }
}

// ---------------------------------------------------------------------------
// 복원
// ---------------------------------------------------------------------------

/** id → 카탈로그의 진짜 부착물(훅 포함). 모르는 id 는 조용히 버린다. */
function loadAtt(id: unknown): Attachment | null {
  const s = str(id)
  if (s === null) return null
  return ATT_BY_ID[s] ?? null
}

function loadMag(id: unknown): Magazine {
  const s = str(id)
  if (s === null) return STARTER_MAGAZINE
  return MAG_BY_ID[s] ?? STARTER_MAGAZINE
}

function loadBag(v: unknown): Ammo[] {
  const out: Ammo[] = []
  if (!Array.isArray(v)) return out
  for (const raw of v) {
    if (!isRec(raw)) continue
    const t = asType(raw['t'])
    const g = asGrade(raw['g'])
    const u = str(raw['u'])
    if (t === null || g === null || u === null) continue
    out.push({ uid: u, type: t, grade: g })
  }
  return out
}

function loadLoadout(v: unknown): Loadout {
  const r = isRec(v) ? v : {}
  const railsRaw = Array.isArray(r['rails']) ? (r['rails'] as unknown[]) : []
  const rails = railsRaw.map(loadAtt)
  let railSlots = int(r['railSlots'], rails.length)
  if (railSlots < 0) railSlots = 0
  if (railSlots > 2) railSlots = 2
  // types.ts 계약: rails.length === railSlots
  while (rails.length < railSlots) rails.push(null)
  while (rails.length > railSlots) rails.pop()

  return {
    barrel: loadAtt(r['barrel']),
    handguard: loadAtt(r['handguard']),
    optic: loadAtt(r['optic']),
    stock: loadAtt(r['stock']),
    rails,
    railSlots,
    magazine: loadMag(r['magazine']),
    bag: loadBag(r['bag']),
    brass: Math.max(0, int(r['brass'], 0)),
  }
}

function loadDoors(v: unknown): DoorOption[] | null {
  if (!Array.isArray(v)) return null
  const out: DoorOption[] = []
  for (const raw of v) {
    if (!isRec(raw)) continue
    const kind = asNode(raw['kind'])
    if (kind === null) continue
    const pid = str(raw['passiveId'])
    out.push({
      threat: asThreat(raw['threat']),
      kind,
      archetype: asArchetype(raw['archetype']),
      passiveId: pid !== null && pid in PASSIVE_BY_ID ? pid : null,
      rewardHint: asRarity(raw['rewardHint']),
      label: str(raw['label']) ?? '',
    })
  }
  return out.length > 0 ? out : null
}

function loadStats(v: unknown): RunStats {
  const r = isRec(v) ? v : {}
  return {
    combatsWon: int(r['combatsWon'], 0),
    shotsFired: int(r['shotsFired'], 0),
    peakHeat: num(r['peakHeat'], 0),
    totalDamage: num(r['totalDamage'], 0),
    brassEarned: int(r['brassEarned'], 0),
    deaths: int(r['deaths'], 0),
  }
}

/**
 * uid 카운터 되돌리기.
 *   core 의 uid 는 'u0','u1'... 카운터다. 페이지를 새로 열면 0 으로 시작하므로
 *   복원한 가방과 새로 산 탄의 uid 가 충돌한다 (트레이/탄창이 uid 로 탄을 찾는다).
 *   core 에 setUidCounter 가 없어서 nextUid() 를 max+1 번 돌려 카운터를 밀어 둔다.
 */
function restoreUidCounter(bag: readonly Ammo[]): void {
  let max = -1
  for (const a of bag) {
    const m = /^u(\d+)$/.exec(a.uid)
    if (m === null) continue
    const n = Number(m[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  resetUidCounter()
  for (let i = 0; i <= max; i += 1) nextUid()
}

/**
 * 진행 중 런을 복원한다. 없거나 스키마 버전이 다르면 null (그리고 저장을 지운다).
 * 부착물/탄창/패시브는 여기서 카탈로그 객체로 되살아난다 — 훅이 다시 붙는다.
 */
export function loadRun(): RunState | null {
  const raw = readKey(RUN_KEY)
  if (!isRec(raw)) return null
  if (int(raw['v'], -1) !== RUN_VERSION) {
    clearRun() // 버전 불일치 → 런만 폐기 (메타는 그대로)
    return null
  }

  const seed = int(raw['seed'], 0)
  const loadout = loadLoadout(raw['loadout'])
  const statusRaw = str(raw['status'])
  const status: 'alive' | 'dead' | 'won' =
    statusRaw === 'dead' || statusRaw === 'won' ? statusRaw : 'alive'
  const bossRaw = str(raw['bossPassiveId'])
  const pending = isRec(raw['pending']) ? (raw['pending'] as Record<string, unknown>) : {}
  const sectorMods = isRec(raw['sectorMods']) ? (raw['sectorMods'] as Record<string, unknown>) : {}

  const run: RunState = {
    seed,
    sector: Math.max(1, int(raw['sector'], 1)),
    nodeIndex: Math.max(0, int(raw['nodeIndex'], 0)),
    loadout,
    doors: loadDoors(raw['doors']),
    current: asNode(raw['current']),
    stake: Math.min(8, Math.max(1, int(raw['stake'], 1))),
    stats: loadStats(raw['stats']),
    bossPassiveId: bossRaw !== null && bossRaw in PASSIVE_BY_ID ? bossRaw : null,
    status,
    relicsSeen: Math.max(0, int(raw['relicsSeen'], 0)),
    removals: Math.max(0, int(raw['removals'], 0)),
    rngState: int(raw['rngState'], seed),
    pending: {
      startDistDelta: num(pending['startDistDelta'], 0),
      heatStartDelta: num(pending['heatStartDelta'], 0),
    },
    sectorMods: {
      heatStartDelta: num(sectorMods['heatStartDelta'], 0),
      startDistDelta: num(sectorMods['startDistDelta'], 0),
    },
    attVars: asNumberMap(raw['attVars']),
    attachmentsTaken: Math.max(0, int(raw['attachmentsTaken'], 0)),
  }

  // 가방이 비어 있으면 정상 런이 아니다 (사격할 탄이 없다)
  if (run.loadout.bag.length === 0) {
    clearRun()
    return null
  }
  if (run.status === 'dead') {
    clearRun()
    return null
  }

  restoreUidCounter(run.loadout.bag)
  return run
}

/** 이어할 런이 있는가 (타이틀 화면용) */
export function hasSave(): boolean {
  const raw = readKey(RUN_KEY)
  if (!isRec(raw)) return false
  if (int(raw['v'], -1) !== RUN_VERSION) return false
  return str(raw['status']) !== 'dead'
}

// ---------------------------------------------------------------------------
// 메타 (해금/통계)
// ---------------------------------------------------------------------------

export function saveMeta(m: MetaState): void {
  const rec = {
    v: META_VERSION,
    bestSector: Math.max(0, Math.floor(m.bestSector)),
    wins: Math.max(0, Math.floor(m.wins)),
    unlockedStake: Math.min(8, Math.max(1, Math.floor(m.unlockedStake))),
    runs: Math.max(0, Math.floor(m.runs)),
  }
  writeKey(META_KEY, rec)
}

/** 메타는 버전이 달라도 필드 단위로 살려낸다 (마이그레이션). */
export function loadMeta(): MetaState {
  const raw = readKey(META_KEY)
  if (!isRec(raw)) return { ...DEFAULT_META }
  return {
    bestSector: Math.max(0, int(raw['bestSector'], 0)),
    wins: Math.max(0, int(raw['wins'], 0)),
    unlockedStake: Math.min(8, Math.max(1, int(raw['unlockedStake'], 1))),
    runs: Math.max(0, int(raw['runs'], 0)),
  }
}

/**
 * 런 종료를 메타에 기록한다 (결과 화면이 딱 한 번 부른다).
 * 승리하면 성전 등급이 한 칸 열린다.
 */
export function recordResult(run: RunState, won: boolean): MetaState {
  const m = loadMeta()
  m.runs += 1
  if (run.sector > m.bestSector) m.bestSector = run.sector
  if (won) {
    m.wins += 1
    const next = Math.min(8, run.stake + 1)
    if (next > m.unlockedStake) m.unlockedStake = next
  }
  saveMeta(m)
  return m
}

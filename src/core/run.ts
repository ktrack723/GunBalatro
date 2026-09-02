// ============================================================================
// 런 구조 — 섹터 / 갈림길 / 보상 / 상점
//   v2: 덱 관리가 사라졌으므로 상점은 "부착물 · 특수탄 · 레일 · 응급 보급" 넷뿐이다.
//   같은 seed 는 언제나 같은 런을 만든다 (Math.random 금지).
// ============================================================================
import type {
  Attachment,
  CombatMods,
  DoorOption,
  EnemyArchetypeId,
  EnemyInstance,
  NodeKind,
  Rarity,
  RewardItem,
  Rng,
  RunState,
  RunStats,
  SlotKind,
  SpecialDef,
  Threat,
} from './types'
import {
  BASE_CAP,
  HARDPOINTS,
  MAX_RAIL_SLOTS,
  NODE_MUL,
  THREAT_RARITY_W,
  THREAT_REWARD_COUNT,
} from './types'
import { makeRng } from './rng'
import { ATTACHMENTS, ATT_BY_ID, STARTER_MAGAZINE, pickAttachment } from './data/attachments'
import { SPECIALS, SPECIAL_BY_ID, startingSpecials } from './data/specials'
import { ARCH_BY_ID, PASSIVES, makeEnemy } from './data/enemies'
import { PRICES, shopPrice } from './economy'
import { equip, growRails } from './data/events'

export const FINAL_SECTOR = 8
/** layout = [combat, combat, <special>, boss, armory] */
export const LAST_NODE = 4

const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'relic']

// ---------------------------------------------------------------------------
// RNG 헬퍼 — 상태 저장까지 한 번에 처리한다
// ---------------------------------------------------------------------------
export function runRng(run: RunState): Rng {
  return makeRng(run.rngState)
}

export function withRng<T>(run: RunState, fn: (r: Rng) => T): T {
  const r = makeRng(run.rngState)
  const out = fn(r)
  run.rngState = r.state()
  return out
}

// ---------------------------------------------------------------------------
// 새 런
// ---------------------------------------------------------------------------
function emptyStats(): RunStats {
  return {
    combatsWon: 0,
    shotsFired: 0,
    peakHeat: 0,
    totalDamage: 0,
    brassEarned: 0,
    specialsUsed: 0,
  }
}

export function newRun(seed: number, stake = 1): RunState {
  const s = seed | 0
  const run: RunState = {
    seed: s,
    sector: 1,
    nodeIndex: 0,
    loadout: {
      barrel: null,
      handguard: null,
      optic: null,
      stock: null,
      magazine: STARTER_MAGAZINE,
      rails: [],
      railSlots: 0,
      stash: [],
      specials: startingSpecials(),
      brass: 0,
    },
    doors: null,
    current: null,
    stake: Math.max(1, Math.min(8, Math.floor(stake))),
    stats: emptyStats(),
    bossPassiveId: null,
    status: 'alive',
    relicsSeen: 0,
    rngState: s,
    pending: { startDistDelta: 0, heatStartDelta: 0 },
    sectorMods: { heatStartDelta: 0, startDistDelta: 0 },
    attVars: {},
    attachmentsTaken: 0,
  }
  run.bossPassiveId = rollBossPassive(run)
  run.current = currentNode(run)
  return run
}

function rollBossPassive(run: RunState): string {
  return withRng(run, (r) => r.pick(PASSIVES).id)
}

// ---------------------------------------------------------------------------
// 노드
// ---------------------------------------------------------------------------
export function sectorLayout(sector: number): NodeKind[] {
  const special: NodeKind =
    sector === 3 || sector === 5 || sector === 7
      ? 'reliquary'
      : sector % 2 === 0
        ? 'derelict'
        : 'armory'
  return ['combat', 'combat', special, 'boss', 'armory']
}

export function currentNode(run: RunState): NodeKind {
  const layout = sectorLayout(run.sector)
  return layout[Math.max(0, Math.min(LAST_NODE, run.nodeIndex))]
}

export function advanceNode(run: RunState): void {
  run.doors = null
  run.nodeIndex += 1
  if (run.nodeIndex > LAST_NODE) {
    run.nodeIndex = 0
    run.sector += 1
    run.sectorMods = { heatStartDelta: 0, startDistDelta: 0 }
    if (run.sector > FINAL_SECTOR) run.status = 'won'
    run.bossPassiveId = rollBossPassive(run)
  }
  run.current = currentNode(run)
}

// ---------------------------------------------------------------------------
// 한시 효과
// ---------------------------------------------------------------------------
export function addDistanceBonus(run: RunState, meters: number): void {
  if (!Number.isFinite(meters)) return
  run.pending.startDistDelta += meters
}

export function consumeCombatMods(run: RunState): CombatMods {
  const mods: CombatMods = {
    startDistDelta: run.pending.startDistDelta + run.sectorMods.startDistDelta,
    heatStartDelta: run.pending.heatStartDelta + run.sectorMods.heatStartDelta,
    runVars: run.attVars,
    attachmentsTaken: run.attachmentsTaken,
  }
  run.pending = { startDistDelta: 0, heatStartDelta: 0 }
  return mods
}

// ---------------------------------------------------------------------------
// 갈림길 — 두 문의 위험도는 항상 다르다
// ---------------------------------------------------------------------------
const THREAT_PAIRS: ReadonlyArray<readonly [Threat, Threat]> = [
  [1, 2],
  [2, 3],
]
const ARCHES: EnemyArchetypeId[] = ['shambler', 'runner', 'bloat', 'horde', 'crawler']

function rollRarity(r: Rng, threat: Threat): Rarity {
  return r.weighted(RARITIES, THREAT_RARITY_W[threat])
}

export function rollDoors(run: RunState): DoorOption[] {
  if (run.doors !== null) return run.doors
  const isBoss = currentNode(run) === 'boss'
  const doors = withRng(run, (r) => {
    const pair = r.pick(THREAT_PAIRS)
    return pair.map((threat): DoorOption => {
      const arch = r.pick(ARCHES)
      const wantPassive = threat === 3 || (threat === 2 && r.next() < 0.3)
      const passive = isBoss
        ? run.bossPassiveId
        : wantPassive
          ? r.pick(PASSIVES).id
          : null
      return {
        threat,
        kind: isBoss ? 'boss' : 'combat',
        archetype: arch,
        passiveId: passive,
        rewardHint: rollRarity(r, threat),
        label: ARCH_BY_ID[arch].name,
      }
    })
  })
  run.doors = doors
  return doors
}

export function enterDoor(
  run: RunState,
  doorIndex: number,
): { node: NodeKind; enemy: EnemyInstance | null; threat: Threat } {
  const doors = rollDoors(run)
  const i = doorIndex >= 0 && doorIndex < doors.length ? doorIndex : 0
  const d = doors[i]
  const node = currentNode(run)
  const nodeMul = node === 'boss' ? NODE_MUL.boss : run.nodeIndex === 1 ? NODE_MUL.big : NODE_MUL.small
  const stakeHpMul = run.stake >= 3 ? 1.1 : 1
  const enemy =
    d.archetype === null
      ? null
      : makeEnemy({
          archetypeId: d.archetype,
          passiveId: d.passiveId,
          sector: run.sector,
          nodeMul,
          threat: d.threat,
          stakeHpMul,
        })
  return { node, enemy, threat: d.threat }
}

// ---------------------------------------------------------------------------
// 보상
// ---------------------------------------------------------------------------
function equippedIds(run: RunState): Set<string> {
  const l = run.loadout
  const out = new Set<string>()
  for (const a of [l.barrel, l.handguard, l.optic, l.stock, l.magazine]) {
    if (a !== null) out.add(a.id)
  }
  for (const r of l.rails) if (r !== null) out.add(r.id)
  for (const a of l.stash) out.add(a.id)
  return out
}

function specialCountFor(rarity: Rarity): number {
  if (rarity === 'common') return 3
  if (rarity === 'uncommon') return 2
  return 1
}

export function rollRewards(run: RunState, threat: Threat): RewardItem[] {
  return withRng(run, (r) => {
    const n = THREAT_REWARD_COUNT[threat]
    const out: RewardItem[] = []
    const taken = equippedIds(run)
    // 부착물 : 특수탄 = (n-1) : 1
    for (let i = 0; i < n; i += 1) {
      const wantSpecial = i === n - 1
      let rarity = rollRarity(r, threat)
      if (rarity === 'relic' && run.relicsSeen >= 2) rarity = 'rare'

      if (wantSpecial) {
        const pool = SPECIALS.filter((s) => s.rarity === rarity)
        const def = pool.length > 0 ? r.pick(pool) : r.pick(SPECIALS)
        out.push({ t: 'special', special: def, count: specialCountFor(def.rarity) })
        continue
      }
      const a = pickAttachment(r, { rarity, exclude: taken })
      if (a === null) {
        const def = r.pick(SPECIALS)
        out.push({ t: 'special', special: def, count: specialCountFor(def.rarity) })
        continue
      }
      taken.add(a.id)
      if (a.rarity === 'relic') run.relicsSeen += 1
      out.push({ t: 'attachment', attachment: a })
    }
    return out
  })
}

export function applyReward(run: RunState, item: RewardItem): string {
  if (item.t === 'attachment') {
    const a = item.attachment
    if (a.mods?.railSlots !== undefined && a.mods.railSlots > 0) {
      const msg = equip(run, a)
      growRails(run, a.mods.railSlots)
      return msg
    }
    return equip(run, a)
  }
  run.loadout.specials[item.special.id] =
    (run.loadout.specials[item.special.id] ?? 0) + item.count
  return item.special.name + ' ' + item.count + '발을 얻었다.'
}

// ---------------------------------------------------------------------------
// 상점
// ---------------------------------------------------------------------------
export interface ArmoryEntry {
  kind: 'special' | 'attachment' | 'rail' | 'heal'
  price: number
  label: string
  sub?: string
  rarity?: Rarity
  payload?: unknown
}

interface SpecialPayload {
  id: string
  count: number
}
interface AttachmentPayload {
  attachment: Attachment
}

function specialEntry(run: RunState, def: SpecialDef, count: number): ArmoryEntry {
  const base = count > 1 ? def.price * PRICES.specialBundleMul : def.price
  return {
    kind: 'special',
    price: shopPrice(Math.round(base), run.stake),
    label: def.name + ' ×' + count,
    sub: def.text,
    rarity: def.rarity,
    payload: { id: def.id, count } as SpecialPayload,
  }
}

function attachmentEntry(run: RunState, a: Attachment): ArmoryEntry {
  return {
    kind: 'attachment',
    price: shopPrice(PRICES.attachment[a.rarity], run.stake),
    label: a.name,
    sub: a.text,
    rarity: a.rarity,
    payload: { attachment: a } as AttachmentPayload,
  }
}

export function armoryStock(run: RunState): ArmoryEntry[] {
  const r = makeRng(run.rngState ^ (run.sector * 7919 + run.nodeIndex * 131))
  const out: ArmoryEntry[] = []
  const taken = equippedIds(run)

  const commons = SPECIALS.filter((s) => s.rarity === 'common' || s.rarity === 'uncommon')
  for (let i = 0; i < 2; i += 1) {
    const def = r.pick(commons)
    out.push(specialEntry(run, def, PRICES.specialBundle))
  }
  const rare = SPECIALS.filter((s) => s.rarity === 'rare')
  if (rare.length > 0) out.push(specialEntry(run, r.pick(rare), 1))

  for (let i = 0; i < 2; i += 1) {
    const rarity: Rarity = r.next() < 0.35 ? 'rare' : 'uncommon'
    const a = pickAttachment(r, { rarity, exclude: taken })
    if (a === null) continue
    taken.add(a.id)
    out.push(attachmentEntry(run, a))
  }

  if (run.loadout.railSlots < MAX_RAIL_SLOTS) {
    out.push({
      kind: 'rail',
      price: shopPrice(PRICES.rail[run.loadout.railSlots] ?? 220, run.stake),
      label: '보조 레일 확장',
      sub: '광학을 하나 더 달 수 있다 (레일 자체엔 효과 없음)',
    })
  }
  out.push({
    kind: 'heal',
    price: shopPrice(PRICES.heal, run.stake),
    label: '응급 보급',
    sub: '다음 전투 시작 거리 +10m',
  })
  return out
}

export function reliquaryStock(run: RunState): ArmoryEntry[] {
  const r = makeRng((run.rngState ^ 0x5bf03635) + run.sector * 977)
  const out: ArmoryEntry[] = []
  const taken = equippedIds(run)
  for (let i = 0; i < 3; i += 1) {
    const rarity: Rarity = r.next() < 0.25 ? 'relic' : 'rare'
    const a = pickAttachment(r, { rarity, exclude: taken })
    if (a === null) continue
    taken.add(a.id)
    out.push(attachmentEntry(run, a))
  }
  const relicSp = SPECIALS.filter((s) => s.rarity === 'relic')
  if (relicSp.length > 0) out.push(specialEntry(run, r.pick(relicSp), 1))
  if (run.loadout.railSlots < MAX_RAIL_SLOTS) {
    out.push({
      kind: 'rail',
      price: shopPrice(PRICES.rail[run.loadout.railSlots] ?? 220, run.stake),
      label: '보조 레일 확장',
      sub: '광학을 하나 더 달 수 있다 (레일 자체엔 효과 없음)',
    })
  }
  return out
}

function isSpecialPayload(p: unknown): p is SpecialPayload {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  return typeof o['id'] === 'string' && typeof o['count'] === 'number'
}

function isAttachmentPayload(p: unknown): p is AttachmentPayload {
  if (typeof p !== 'object' || p === null) return false
  const a = (p as Record<string, unknown>)['attachment']
  return typeof a === 'object' && a !== null && typeof (a as Attachment).id === 'string'
}

export function buy(run: RunState, entry: ArmoryEntry): string {
  const l = run.loadout
  if (l.brass < entry.price) return '탄피가 부족하다.'

  switch (entry.kind) {
    case 'special': {
      if (!isSpecialPayload(entry.payload)) return '살 수 없는 물건이다.'
      l.brass -= entry.price
      const def = SPECIAL_BY_ID[entry.payload.id]
      l.specials[def.id] = (l.specials[def.id] ?? 0) + entry.payload.count
      return def.name + ' ' + entry.payload.count + '발을 샀다.'
    }
    case 'attachment': {
      if (!isAttachmentPayload(entry.payload)) return '살 수 없는 물건이다.'
      l.brass -= entry.price
      return equip(run, entry.payload.attachment)
    }
    case 'rail': {
      if (l.railSlots >= MAX_RAIL_SLOTS) return '보조 레일은 두 칸이 끝이다.'
      l.brass -= entry.price
      growRails(run, 1)
      return '보조 레일 ' + l.railSlots + '번째 칸이 열렸다.'
    }
    case 'heal': {
      l.brass -= entry.price
      addDistanceBonus(run, 10)
      return '다음 전투를 10m 더 멀리서 시작한다.'
    }
  }
}

// ---------------------------------------------------------------------------
// 표시용
// ---------------------------------------------------------------------------
export function capOf(run: RunState): number {
  return run.loadout.magazine?.mag?.cap ?? BASE_CAP
}

export function allAttachments(): Attachment[] {
  return ATTACHMENTS
}

export function attachmentById(id: string): Attachment | undefined {
  return ATT_BY_ID[id]
}

export function slotsOf(): readonly SlotKind[] {
  return HARDPOINTS
}

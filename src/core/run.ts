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
  RewardRoom,
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
} from './types'
import { makeRng } from './rng'
import { ATTACHMENTS, ATT_BY_ID, STARTER_MAGAZINE, pickAttachment } from './data/attachments'
import { SPECIALS, SPECIAL_BY_ID, startingSpecials } from './data/specials'
import { ARCH_BY_ID, PASSIVES, makeEnemy } from './data/enemies'
import { FINAL_SECTOR as REGION_FINAL_SECTOR, regionBossOf, sectorInRegion } from './data/regions'
import { computeStartDistance } from './pipeline'
import { PRICES, shopPrice } from './economy'
import { equip, growRails } from './data/events'

/** 마지막 섹터 — 지역 구조(3지역 × 3섹터)가 정한다 */
export const FINAL_SECTOR = REGION_FINAL_SECTOR
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
/**
 * 섹터 배치. 가운데 한 칸이 섹터마다 다르고, 그 리듬을 **지역이** 정한다.
 *   지역의 1섹터 정비소 → 2섹터 폐허 → 3섹터 성소 → 지역 보스.
 * 예전에는 3·5·7 처럼 홀짝으로 갈랐는데, 지역이 생긴 뒤로는 그 규칙이
 * 지역 경계와 어긋나 "왜 여기서 성소가 나오지" 가 됐다.
 */
export function sectorLayout(sector: number): NodeKind[] {
  const k = sectorInRegion(sector)
  const special: NodeKind = k === 3 ? 'reliquary' : k === 2 ? 'derelict' : 'armory'
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
/** 섹터 3부터 추적자·거상이 섞인다 — 초반 두 섹터는 기준선 다섯 종으로 배운다 */
const ARCHES_LATE: EnemyArchetypeId[] = [...ARCHES, 'stalker', 'colossus']
function archPool(run: RunState): EnemyArchetypeId[] {
  return run.sector >= 3 ? ARCHES_LATE : ARCHES
}

/** 광학을 하나라도 달고 있는가 (교란 패시브 게이팅) */
function hasOptic(run: RunState): boolean {
  const l = run.loadout
  if (l.optic !== null) return true
  return l.rails.some((x) => x !== null)
}

function rollRarity(r: Rng, threat: Threat): Rarity {
  return r.weighted(RARITIES, THREAT_RARITY_W[threat])
}

export function rollDoors(run: RunState): DoorOption[] {
  if (run.doors !== null) return run.doors
  const isBoss = currentNode(run) === 'boss'

  // 지역 보스 — 갈림길이 아니다. 양쪽 문 뒤에 같은 것이 서 있다.
  //   호출부(봇 포함)가 두 칸을 기대하므로 개수는 지키고 내용만 하나로 만든다.
  const regionBoss = isBoss ? regionBossOf(run.sector) : null
  if (regionBoss !== null) {
    const door: DoorOption = {
      threat: 3,
      kind: 'boss',
      archetype: regionBoss.archetype.id as EnemyArchetypeId,
      passiveId: run.bossPassiveId,
      rewardHint: 'rare',
      label: regionBoss.name,
    }
    run.doors = [door, { ...door }]
    return run.doors
  }

  const doors = withRng(run, (r) => {
    const pair = r.pick(THREAT_PAIRS)
    const pool = archPool(run)
    return pair.map((threat): DoorOption => {
      const arch = r.pick(pool)
      const wantPassive = threat === 3 || (threat === 2 && r.next() < 0.3)
      // 교란은 광학이 하나도 없으면 아무 일도 일어나지 않는다 — 전투 시점 광학 0개
      // 비율이 S1 87% / S2 56% 라, 초반 위험도3 문이 공짜가 되어 버린다.
      const ppool = hasOptic(run) ? PASSIVES : PASSIVES.filter((p) => p.id !== 'jamming')
      const passive = isBoss
        ? run.bossPassiveId
        : wantPassive
          ? r.pick(ppool).id
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
  const boss = node === 'boss' ? regionBossOf(run.sector) : null
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
          bossId: boss?.id ?? null,
        })
  return { node, enemy, threat: d.threat }
}

/**
 * 전투 시작 거리 **미리보기**. 상태를 소비하지 않는다.
 *   적을 이동 구간 저편에 미리 세워 두려면(안개 속에서 서서히 드러나게 하려면)
 *   startCombat 이 돌기 전에 최종 거리를 알아야 한다. 계산은 startCombat 과 같다:
 *   computeStartDistance(장비, 적) + 보류 중인 시작거리 보정.
 *   consumeCombatMods 는 run.pending 을 비우므로 여기서는 절대 부르지 않는다.
 */
export function previewStartDistance(run: RunState, enemy: EnemyInstance): number {
  return (
    computeStartDistance(run.loadout, enemy) +
    run.pending.startDistDelta +
    run.sectorMods.startDistDelta
  )
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

/**
 * 보상방 하나의 특수탄 발수.
 * 예전(3/2/1)은 '고르면' 받는 값이었다. 이제는 **매 전투 무조건** 받으므로 그대로 두면
 * 공급이 두 배가 된다. 2/1/1 로 내린다 — 총량은 비슷하되 받는 리듬이 규칙적이다.
 */
/**
 * 보상방이 주는 특수탄 묶음 크기 — **언제나 한 발**.
 *
 * 예전에는 일반이 2발이었다. 전투마다 1.4발이 들어오는데 실제 소비는 전투당
 * 2.4발이라 얼추 맞아 보였지만, 정비소가 3발 묶음을 얹으면서 런 끝에 **52발**이
 * 남았다(실측). 소모품이 남아돌면 그건 소모품이 아니다 — "지금 이걸 쓸까 아낄까"
 * 가 사라지고 매 탄창을 특수탄으로 채우게 된다.
 *
 * 한 발씩이면 런 전체 공급이 소비를 밑돌아, 모자란 만큼을 정비소에서 살지
 * 기본탄으로 버틸지가 실제 선택이 된다.
 */
function specialCountFor(_rarity: Rarity): number {
  return 1
}

/**
 * 보상방을 굴린다 — 탄피(호출부가 채운다) · 특수탄 1묶음 · 부착물 3택.
 * 부착물은 각 칸을 따로 굴리므로 세 장의 등급이 서로 다를 수 있다(위험도가 높을수록 위로).
 */
export function rollRewardRoom(run: RunState, threat: Threat, brass: number): RewardRoom {
  return withRng(run, (r) => {
    const taken = equippedIds(run)

    const spRarity = rollRarity(r, threat)
    const spPool = SPECIALS.filter((s) => s.rarity === spRarity)
    const def = spPool.length > 0 ? r.pick(spPool) : r.pick(SPECIALS)

    const attachments: Attachment[] = []
    for (let i = 0; i < 3; i += 1) {
      let rarity = rollRarity(r, threat)
      // 유물은 런당 2장까지만 굴러 나온다 (relicsSeen 은 실제로 집었을 때만 오른다)
      if (rarity === 'relic' && run.relicsSeen >= 2) rarity = 'rare'
      const a = pickAttachment(r, { rarity, exclude: taken })
      if (a === null) continue
      taken.add(a.id)
      attachments.push(a)
    }

    return { brass, special: { def, count: specialCountFor(def.rarity) }, attachments }
  })
}

/** 보상방에서 부착물 한 장을 가져간다 */
export function claimAttachment(run: RunState, a: Attachment): string {
  if (a.rarity === 'relic') run.relicsSeen += 1
  return applyReward(run, { t: 'attachment', attachment: a })
}

/** 보상방에서 특수탄 묶음을 가져간다 */
export function claimSpecial(run: RunState, def: SpecialDef, count: number): string {
  return applyReward(run, { t: 'special', special: def, count })
}

/** 보상방에서 탄피를 가져간다 */
export function claimBrass(run: RunState, n: number): string {
  run.loadout.brass += n
  run.stats.brassEarned += n
  return '탄피 ' + n + '개를 챙겼다.'
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

/**
 * 정비소 진열 — **네 칸**.
 *
 * 예전에는 일곱 칸이었다(일반탄 2 · 희귀탄 1 · 부착물 2 · 레일 · 보급). 그런데
 * 칸이 일곱이면 고르는 것이 아니라 **훑는 것**이 된다 — 실측에서 봇은 한 런에
 * 33번을 샀다. 그건 상점이 아니라 자판기다.
 *
 * 카탈로그를 줄인 게 아니라 **한 번에 보이는 수**를 줄였다. 물건은 그대로 있고,
 * 다음 정비소에서 다른 넷이 나온다. 네 칸이면 한눈에 다 읽히고, 탄피가 한
 * 자릿수라 "이번엔 이것 하나" 가 실제로 강제된다.
 *
 * 마지막 칸은 레일이 남아 있으면 레일, 다 열었으면 응급 보급이다 — 둘 다
 * "화력이 아닌 것" 자리라 겹쳐 놓아도 성격이 흐려지지 않는다.
 */
const ARMORY_SLOTS = 4

export function armoryStock(run: RunState): ArmoryEntry[] {
  const r = makeRng(run.rngState ^ (run.sector * 7919 + run.nodeIndex * 131))
  const out: ArmoryEntry[] = []
  const taken = equippedIds(run)

  // ① 특수탄 한 종 — 묶음으로만 판다 (한 발씩 사면 계산이 끝없이 잘게 쪼개진다)
  const ammo = SPECIALS.filter((s) => s.rarity === 'common' || s.rarity === 'uncommon')
  if (ammo.length > 0) out.push(specialEntry(run, r.pick(ammo), PRICES.specialBundle))

  // ② 부착물 둘 — 이 화면의 본론
  for (let i = 0; i < 2; i += 1) {
    const rarity: Rarity = r.next() < 0.35 ? 'rare' : 'uncommon'
    const a = pickAttachment(r, { rarity, exclude: taken })
    if (a === null) continue
    taken.add(a.id)
    out.push(attachmentEntry(run, a))
  }

  // ③ 마지막 한 칸 — 레일이 남았으면 레일, 아니면 보급
  if (run.loadout.railSlots < MAX_RAIL_SLOTS) {
    out.push({
      kind: 'rail',
      price: shopPrice(PRICES.rail[run.loadout.railSlots] ?? 22, run.stake),
      label: '보조 레일 확장',
      sub: '광학을 하나 더 달 수 있다 (레일 자체엔 효과 없음)',
    })
  } else {
    out.push({
      kind: 'heal',
      price: shopPrice(PRICES.heal, run.stake),
      label: '응급 보급',
      sub: '다음 전투 시작 거리 +10m',
    })
  }
  return out.slice(0, ARMORY_SLOTS)
}

/**
 * 성소 진열 — **세 칸**. 여기는 값비싼 것만 나오는 자리라 더 좁힌다.
 *   레일은 정비소에서만 판다 — 성소는 "무엇을 붙일 것인가" 만 묻는 곳이다.
 */
const RELIQUARY_SLOTS = 3

export function reliquaryStock(run: RunState): ArmoryEntry[] {
  const r = makeRng((run.rngState ^ 0x5bf03635) + run.sector * 977)
  const out: ArmoryEntry[] = []
  const taken = equippedIds(run)
  for (let i = 0; i < 2; i += 1) {
    const rarity: Rarity = r.next() < 0.25 ? 'relic' : 'rare'
    const a = pickAttachment(r, { rarity, exclude: taken })
    if (a === null) continue
    taken.add(a.id)
    out.push(attachmentEntry(run, a))
  }
  const relicSp = SPECIALS.filter((s) => s.rarity === 'relic')
  if (relicSp.length > 0) out.push(specialEntry(run, r.pick(relicSp), 1))
  return out.slice(0, RELIQUARY_SLOTS)
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

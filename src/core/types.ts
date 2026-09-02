// ============================================================================
// GunBalatro — 코어 타입 계약 (v2)
// 이 파일은 모든 모듈이 의존하는 단일 계약이다. 여기 없는 개념은 존재하지 않는다.
// core/ 는 three.js 와 DOM 을 전혀 모른다.
//
// ── v2 의 방향 전환 ────────────────────────────────────────────────────────
// v1 은 발라트로의 "덱"을 그대로 가져와 탄종(AP/INC/HE/축성) × 등급(Mk.I~V) 으로
// 빌드를 만들었다. v2 는 그 축을 통째로 걷어낸다.
//
//   탄 = 기본탄(무한) + 특수탄(소모품)
//   빌드 = 오직 부착물
//
// 발라트로에 비유하면 "핸드를 하이카드로 고정해 두고 조커만으로 굴리는 게임"이다.
// 덱 무작위성이 사라진 자리에 부착물 조합과 특수탄 사용 타이밍이 들어온다.
// ============================================================================

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------
export interface Rng {
  /** [0,1) */
  next(): number
  /** [0,n) 정수 */
  int(n: number): number
  /** 배열에서 하나 */
  pick<T>(arr: readonly T[]): T
  /** 제자리 셔플 (Fisher-Yates) */
  shuffle<T>(arr: T[]): T[]
  /** 가중치 선택. weights 길이 == items 길이 */
  weighted<T>(items: readonly T[], weights: readonly number[]): T
  /** 현재 내부 상태 (저장/복원용) */
  state(): number
  setState(s: number): void
  /** 독립 스트림 분기 */
  fork(salt: number): Rng
}

// ---------------------------------------------------------------------------
// 레어도
// ---------------------------------------------------------------------------
export type Rarity = 'common' | 'uncommon' | 'rare' | 'relic'

// ---------------------------------------------------------------------------
// 탄 (Round)
// ---------------------------------------------------------------------------

/**
 * 탄창에 들어가는 한 발.
 * `special === null` 이면 기본탄이다 — **수량 무한**. 자체 효과는 없고
 * 부착물이 얹어주는 수치만 갖는다. 게임의 바닥이자 부착물이 곱해질 대상.
 */
export interface Round {
  /** 탄창 안에서의 식별자 (드래그 재배치용) */
  uid: string
  /** 특수탄 id. null 이면 기본탄 */
  special: string | null
}

/** 특수탄 정의 — 소모품. 자체적으로 효과를 지닌다. */
export interface SpecialDef {
  id: string
  name: string
  /** 툴팁 1줄 (40자 내외) */
  text: string
  rarity: Rarity
  /** 기본 데미지 */
  dmg: number
  /** 온도 획득 */
  heat: number
  /** 정비소 구매가 (1발) */
  price: number
  /** 카드 색 (hex) */
  color: string
  hooks?: RoundHooks
}

/** 특수탄이 걸 수 있는 훅. 부착물과 같은 컨텍스트를 쓴다. */
export interface RoundHooks {
  /** 발사 직전 — dmg/heatGain 을 덧셈으로만 수정 */
  onFire?(c: FireCtx): void
  /** 발사 직후 — 넉백·디버프·예약 효과 등 */
  onAfterShot?(c: FireCtx): void
}

/** 기본탄 스탯. 부착물이 여기에 덧셈으로 얹는다. */
export const BASIC_DMG = 12
export const BASIC_HEAT = 0.55

// ---------------------------------------------------------------------------
// 부착물 (Attachment) — v2 에서는 이것이 빌드의 전부다
// ---------------------------------------------------------------------------

/**
 * 부위. **같은 부위는 하나만 장착한다** — 총 한 자루에 총열은 하나다.
 * 물리적 직관이 곧 규칙이라 학습 비용이 0이다.
 */
/**
 * 부위.
 *   'rail' 은 **부착물의 종류가 아니라 자리(슬롯)** 다.
 *   보조 레일 자체에는 아무 효과가 없다 — 광학을 하나 더 달 수 있게 해줄 뿐이다.
 *   그래서 `Attachment.slot` 이 'rail' 인 부착물은 존재하지 않는다 (테스트가 강제한다).
 *   레일 칸에는 RAIL_ACCEPTS 부위의 부착물만 들어간다.
 */
export type SlotKind = 'barrel' | 'handguard' | 'optic' | 'stock' | 'magazine' | 'rail'

/** 보조 레일 칸이 받아들이는 부위 — 광학 전용 */
export const RAIL_ACCEPTS: SlotKind = 'optic'

export const HARDPOINTS: readonly SlotKind[] = [
  'barrel',
  'handguard',
  'optic',
  'stock',
  'magazine',
] as const

export const SLOT_LABEL: Record<SlotKind, string> = {
  barrel: '총열',
  handguard: '총열덮개',
  optic: '광학',
  stock: '개머리판',
  magazine: '탄창',
  rail: '보조 광학',
}

/** 전투 밖에서도 상시 적용되는 정적 보정 */
export interface StaticMods {
  /** 탄창 용량 증감 */
  cap?: number
  /** 전투 시작 거리 증감 (m) */
  startDist?: number
  /** 사격 행동 거리 비용 증감 (m, 음수가 이득) */
  fireCost?: number
  /** 적 접근 속도 증감 (음수가 이득, 최소 2로 클램프) */
  enemySpeed?: number
  /** 보조 레일 슬롯 증감 — 칸만 늘린다. 레일 자체에는 효과가 없다 */
  railSlots?: number
  /** 사격 시작 온도 증감 — BALANCE R6: 탄창 부위와 유물만 허용 */
  startHeat?: number
  /**
   * 사격 사이 온도 이월 비율 증감.
   * 기본 이월은 BASE_HEAT_CARRY(50%)이고, 여기 값이 더해진다 (0~1로 클램프).
   * 음수면 더 빨리 식는다 — "저온 빌드"를 여는 축이다.
   */
  heatCarry?: number
}

export interface Attachment {
  id: string
  name: string
  slot: SlotKind
  rarity: Rarity
  /** 툴팁 1줄 */
  text: string
  mods?: StaticMods
  hooks?: AttachmentHooks
  /** 탄창 부위 전용 — 규칙 변경자 */
  mag?: MagazineRules
}

/** 탄창 부위 부착물이 바꾸는 규칙 */
export interface MagazineRules {
  /** 기본 용량 */
  cap: number
  /** 온도 획득 배율 (드럼 = 0.7). 기본 1 */
  heatGainMul?: number
  /** 발사한 탄이 소모되지 않을 확률 (특수탄만 대상) */
  notConsumedChance?: number
}

export interface AttachmentHooks {
  /** 전투 시작 시 1회 */
  onCombatStart?(c: CombatCtx): void
  /** 전투 종료 시 1회 */
  onCombatEnd?(c: CombatCtx): void
  /** 사격(탄창) 시작 시. 온도 초기화 직후, 첫 발 전 */
  onMagStart?(c: MagCtx): void
  /** 사격 종료 시 */
  onMagEnd?(c: MagCtx): void
  /** ★ 발사 직전. ctx.dmg / ctx.heatGain 을 덧셈으로만 수정한다 */
  onFire?(c: FireCtx): void
  /** 발사 직후 */
  onAfterShot?(c: FireCtx): void
}

// ---------------------------------------------------------------------------
// 적 (Enemy)
// ---------------------------------------------------------------------------
export type EnemyArchetypeId = 'shambler' | 'runner' | 'bloat' | 'horde' | 'crawler'

export interface EnemyArchetype {
  id: EnemyArchetypeId
  name: string
  hpMul: number
  /** 접근 속도 (m/행동) */
  speed: number
  /** 시작 거리 (m) */
  startDist: number
  flavor: string
}

export interface EnemyPassive {
  id: string
  name: string
  text: string
  modifyHeatGain?(gain: number, c: FireCtx): number
  modifyDamage?(damage: number, c: FireCtx): number
  onCombatStart?(c: CombatCtx): void
  onMagStart?(c: MagCtx): void
  onMagEnd?(c: MagCtx): void
  onAfterShot?(c: FireCtx): void
}

export interface EnemyInstance {
  archetype: EnemyArchetype
  passive: EnemyPassive | null
  maxHp: number
  hp: number
  speed: number
  startDist: number
  label: string
  bodyCount: number
  /** 디버프: 이 전투 동안 받는 피해 증가분 (0.2 = +20%) */
  vuln: number
}

// ---------------------------------------------------------------------------
// 장비 (Loadout)
// ---------------------------------------------------------------------------
export interface Loadout {
  barrel: Attachment | null
  handguard: Attachment | null
  optic: Attachment | null
  stock: Attachment | null
  /** 탄창도 하나의 부위다 */
  magazine: Attachment | null
  /** 보조 레일 칸. 길이 == railSlots, 빈 칸은 null. **광학만 들어간다** */
  rails: (Attachment | null)[]
  railSlots: number
  /** 보유 중이지만 장착하지 않은 부착물 (전투 중 교체용) */
  stash: Attachment[]
  /** 특수탄 보유량. key = SpecialDef.id */
  specials: Record<string, number>
  brass: number
}

export type OrderedAttachments = Attachment[]

// ---------------------------------------------------------------------------
// 전투 상태
// ---------------------------------------------------------------------------
export interface CombatState {
  enemy: EnemyInstance
  /** 남은 거리 (m). <=0 이면 즉사 */
  distance: number

  /** 이번 전투에서 쓸 수 있는 특수탄 잔량 (전투 종료 시 loadout 에 반영) */
  specials: Record<string, number>

  cap: number

  heat: number
  heatStartBase: number
  peakHeat: number

  magsFired: number
  shotsFired: number
  totalDamage: number

  // --- 현재 탄창 스코프 ---
  magPlan: Round[]
  magFired: Round[]
  magDamage: number
  abortMag: boolean
  /** 다음 탄에 적용할 데미지 보너스 */
  pendingNextDmg: number
  /** 다음 탄의 효과 2배 (성탄) */
  doubleNext: boolean
  /** 이번 탄창 남은 발사의 온도 획득 2배 */
  heatDoublePending: boolean
  /** 이번 탄창 동안 모든 탄에 얹히는 데미지 (점착탄 등) */
  magDmgBonus: number

  vars: Record<string, number>
  runVars: Record<string, number>
  flags: Record<string, boolean>

  fireCost: number

  rng: Rng
  loadout: Loadout
  attachments: OrderedAttachments
  dryRun: boolean
  outcome: 'ongoing' | 'win' | 'lose'
}

export interface CombatCtx {
  s: CombatState
  /** 이 훅을 호출한 부착물/특수탄 id (연출용) */
  self: string
}

export interface MagCtx extends CombatCtx {
  plan: Round[]
}

export interface FireCtx extends CombatCtx {
  round: Round
  /** 이 발이 특수탄이면 그 정의 */
  def: SpecialDef | null
  /** 0-based, 이번 탄창 내 발사 순번 */
  index: number
  isFirst: boolean
  isLast: boolean
  prev: Round | null
  /** 발사 직전 온도 */
  heatBefore: number
  /** 누적 데미지 (mutable, 덧셈만) */
  dmg: number
  /** 누적 온도 획득 (mutable, 덧셈만) */
  heatGain: number
  triggered: string[]
}

// ---------------------------------------------------------------------------
// 사격 이벤트 로그 — core 가 만들고 sequencer 가 연출로 번역한다
// ---------------------------------------------------------------------------
export type FireEvent =
  | { t: 'magStart'; plan: Round[]; heat: number; cap: number }
  | {
      t: 'shot'
      index: number
      round: Round
      dmg: number
      heatBefore: number
      heatAfter: number
      damage: number
      rawDamage: number
      triggered: string[]
      enemyHpAfter: number
    }
  | { t: 'knockback'; meters: number; distanceAfter: number }
  | { t: 'notConsumed'; index: number; round: Round }
  | { t: 'debuff'; note: string }
  | { t: 'enemyDead'; overkill: number }
  | { t: 'magEnd'; heatCarried: number; heatAfter: number; totalDamage: number }
  | { t: 'advance'; meters: number; distanceAfter: number }
  | { t: 'playerDead' }

// ---------------------------------------------------------------------------
// 런 구조
// ---------------------------------------------------------------------------
export type NodeKind = 'combat' | 'armory' | 'reliquary' | 'derelict' | 'boss'
export type Threat = 1 | 2 | 3

export interface DoorOption {
  threat: Threat
  kind: NodeKind
  archetype: EnemyArchetypeId | null
  passiveId: string | null
  rewardHint: Rarity
  label: string
}

export interface PendingEffects {
  startDistDelta: number
  heatStartDelta: number
}

export interface SectorEffects {
  heatStartDelta: number
  startDistDelta: number
}

export interface RunState {
  seed: number
  sector: number
  nodeIndex: number
  loadout: Loadout
  doors: DoorOption[] | null
  current: NodeKind | null
  stake: number
  stats: RunStats
  bossPassiveId: string | null
  status: 'alive' | 'dead' | 'won'
  relicsSeen: number
  rngState: number
  pending: PendingEffects
  sectorMods: SectorEffects
  attVars: Record<string, number>
  attachmentsTaken: number
}

export interface RunStats {
  combatsWon: number
  shotsFired: number
  peakHeat: number
  totalDamage: number
  brassEarned: number
  specialsUsed: number
}

export interface CombatMods {
  startDistDelta: number
  heatStartDelta: number
  runVars?: Record<string, number>
  attachmentsTaken?: number
}

// ---------------------------------------------------------------------------
// 보상
// ---------------------------------------------------------------------------
export type RewardItem =
  | { t: 'attachment'; attachment: Attachment }
  | { t: 'special'; special: SpecialDef; count: number }

// ---------------------------------------------------------------------------
// 이벤트 (폐허)
// ---------------------------------------------------------------------------
export interface DerelictEvent {
  id: string
  name: string
  body: string
  options: DerelictOption[]
}

export interface DerelictOption {
  label: string
  apply(run: RunState, rng: Rng): string
}

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------
export const BASE_HEAT = 1.0
/**
 * ★ 사격 사이 온도 이월 기본값.
 * 온도는 더 이상 탄창마다 초기화되지 않는다 — 전투 내내 이어지는 자원이다.
 * 그래서 "언제 큰 걸 쏘는가"가 한 탄창 안이 아니라 전투 전체로 확장된다.
 *
 * 대가: 시작 온도가 높아질수록 탄창 안의 배열 격차는 줄어든다(BALANCE §7.5 법칙 1).
 * 그 반대 추로 **저온일수록 강해지는 탄**을 두어, 온도를 올릴지 낮게 유지할지
 * 자체가 선택이 되게 했다.
 */
export const BASE_HEAT_CARRY = 0.5
export const BASE_CAP = 5
export const MAX_RAIL_SLOTS = 2

export const HP_BASE = 400
export const HP_GROWTH = 1.87
export const HP_ENDLESS_GROWTH = 2.4
export const NODE_MUL = { small: 1.0, big: 1.63, boss: 2.5 } as const

export const THREAT_HP_MUL: Record<Threat, number> = { 1: 1.0, 2: 1.25, 3: 3.6 }
export const THREAT_SPEED_ADD: Record<Threat, number> = { 1: 0, 2: 1, 3: 3 }
export const THREAT_BRASS: Record<Threat, number> = { 1: 0, 2: 15, 3: 35 }
export const THREAT_REWARD_COUNT: Record<Threat, number> = { 1: 3, 2: 3, 3: 4 }
/** [common, uncommon, rare, relic] */
export const THREAT_RARITY_W: Record<Threat, [number, number, number, number]> = {
  1: [70, 26, 4, 0],
  2: [45, 40, 14, 1],
  3: [20, 45, 30, 5],
}

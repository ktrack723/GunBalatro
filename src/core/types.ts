// ============================================================================
// GunBalatro — 코어 타입 계약
// 이 파일은 모든 모듈이 의존하는 단일 계약이다. 여기 없는 개념은 존재하지 않는다.
// core/ 는 three.js 와 DOM 을 전혀 모른다.
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
// 탄 (Ammo)
// ---------------------------------------------------------------------------
export type AmmoType = 'AP' | 'INC' | 'HE' | 'SANC'
export type Grade = 1 | 2 | 3 | 4 | 5

export interface Ammo {
  /** 런 내 고유 식별자 */
  uid: string
  type: AmmoType
  grade: Grade
}

export interface AmmoStats {
  /** 기본 데미지 (칩) */
  dmg: number
  /** 온도 획득 (멀트) */
  heat: number
  /** HE 넉백 (m). 그 외 0 */
  knockback: number
  /** SANC 가 다음 탄에 주는 데미지 보너스. 그 외 0 */
  nextDmgBonus: number
}

// ---------------------------------------------------------------------------
// 레어도
// ---------------------------------------------------------------------------
export type Rarity = 'common' | 'uncommon' | 'rare' | 'relic'

// ---------------------------------------------------------------------------
// 부착물 (Attachment) — 발라트로의 조커
// ---------------------------------------------------------------------------
export type SlotKind = 'barrel' | 'handguard' | 'optic' | 'stock' | 'rail'

/** 전투 밖에서도 상시 적용되는 정적 보정 */
export interface StaticMods {
  /** 트레이 크기 증감 */
  tray?: number
  /** 탄창 용량 증감 */
  cap?: number
  /** 전투 시작 거리 증감 (m) */
  startDist?: number
  /** 사격 행동 거리 비용 증감 (m, 음수가 이득) */
  fireCost?: number
  /** 배출 행동 거리 비용 증감 (m, 음수가 이득) */
  ejectCost?: number
  /** 적 접근 속도 증감 (음수가 이득, 최소 2로 클램프) */
  enemySpeed?: number
  /** 보조 레일 슬롯 증감 */
  railSlots?: number
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
}

export interface AttachmentHooks {
  /** 전투 시작 시 1회 */
  onCombatStart?(c: CombatCtx): void
  /** 전투 종료 시 1회 (승리/패배 무관) */
  onCombatEnd?(c: CombatCtx): void
  /** 사격 행동(탄창) 시작 시. 온도 초기화 직후, 첫 발 전 */
  onMagStart?(c: MagCtx): void
  /** 사격 행동 종료 시 */
  onMagEnd?(c: MagCtx): void
  /** ★ 발사 직전. ctx.dmg / ctx.heatGain 을 덧셈으로만 수정한다 */
  onFire?(c: FireCtx): void
  /** 발사 직후. 누적 카운터 갱신 등 */
  onAfterShot?(c: FireCtx): void
}

// ---------------------------------------------------------------------------
// 탄창 (Magazine) — 규칙 변경자
// ---------------------------------------------------------------------------
export interface Magazine {
  id: string
  name: string
  /** 기본 용량 */
  cap: number
  text: string
  /** 온도 획득 배율 (M2 드럼 = 0.7). 기본 1 */
  heatGainMul?: number
  /** 트레이 증감 (M5 = -2) */
  trayDelta?: number
  /** 발사한 탄이 소모되지 않을 확률 (M3 = 0.75) */
  notConsumedChance?: number
  /** 사격 종료 시 다음 사격으로 이월할 온도 비율 (M7 = 0.4) */
  heatCarryRatio?: number
  /** 사격 행동 거리 비용 증감 (M8 = -2) */
  fireCostDelta?: number
  /** 사격 시작 온도 지정 (M9 = 12). 미지정 시 1.0 */
  startHeat?: number
  hooks?: AttachmentHooks
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
  /** 연출용 */
  flavor: string
}

export interface EnemyPassive {
  id: string
  name: string
  text: string
  /** 온도 획득 보정 (냉혈) */
  modifyHeatGain?(gain: number, c: FireCtx): number
  /** 최종 데미지 보정 (강직·장갑·성별거부) */
  modifyDamage?(damage: number, c: FireCtx): number
  onCombatStart?(c: CombatCtx): void
  onMagStart?(c: MagCtx): void
  onMagEnd?(c: MagCtx): void
  onAfterShot?(c: FireCtx): void
  /** 트레이에서 뒷면으로 가릴 장 수 (암흑) */
  hiddenTrayCount?: number
  /** 축성탄 와일드 판정 무효화 (성별 거부) */
  disableWildcard?: boolean
}

export interface EnemyInstance {
  archetype: EnemyArchetype
  passive: EnemyPassive | null
  maxHp: number
  hp: number
  /** 위험도 보정 적용 후 실제 접근 속도 */
  speed: number
  startDist: number
  /** 표시용 라벨 */
  label: string
  /** 무리(horde) 연출용 개체 수 */
  bodyCount: number
}

// ---------------------------------------------------------------------------
// 장비 (Loadout)
// ---------------------------------------------------------------------------
export interface Loadout {
  barrel: Attachment | null
  handguard: Attachment | null
  optic: Attachment | null
  stock: Attachment | null
  /** 길이 == railSlots. 빈 칸은 null */
  rails: (Attachment | null)[]
  railSlots: number
  magazine: Magazine
  bag: Ammo[]
  brass: number
}

/** 좌→우 순회 순서로 부착물 나열 (총열→덮개→광학→스톡→레일) */
export type OrderedAttachments = Attachment[]

// ---------------------------------------------------------------------------
// 전투 상태
// ---------------------------------------------------------------------------
export interface CombatState {
  enemy: EnemyInstance
  /** 남은 거리 (m). <=0 이면 즉사 */
  distance: number

  // --- 덱 ---
  bag: Ammo[]      // 미드로우 더미
  tray: Ammo[]     // 손에 든 탄
  spent: Ammo[]    // 발사/배출된 탄 (가방이 비면 회수)
  /** 예비칸 (탄약 주머니 등이 생성한 전투 한정 탄) */
  reserve: Ammo[]

  // --- 크기 ---
  traySize: number
  cap: number

  // --- 온도 ---
  heat: number
  /** 사격 시작 시 적용될 기본 온도 (부착물 누적으로 상승 가능) */
  heatStartBase: number
  peakHeat: number

  // --- 진행 카운터 ---
  magsFired: number
  ejectsUsed: number
  shotsFired: number
  totalDamage: number

  // --- 현재 탄창 스코프 (사격 중에만 유효) ---
  magPlan: Ammo[]
  magFired: Ammo[]
  magDamage: number
  /** true 면 남은 탄을 쏘지 않고 사격 종료 (열역학 패시브, 불안정 노심) */
  abortMag: boolean
  /** 다음 탄에 적용할 데미지 보너스 (축성탄) */
  pendingNextDmg: number
  /** 이번 탄창 남은 발사의 온도 획득 2배 (이단심문관의 화염) */
  heatDoublePending: boolean

  // --- 부착물 누적 저장소 ---
  /** 전투 스코프. 전투가 끝나면 사라진다 */
  vars: Record<string, number>
  /**
   * ★ 런 스코프. RunState.attVars 를 참조로 들고 있어 전투가 끝나도 살아남는다.
   * 발라트로의 "스케일링 조커"(런 내내 자라는 조커)에 대응하는 유일한 복리 장치다.
   * 곱셈 축을 온도 하나로 줄인 대가를 여기서 갚는다.
   * dryRun 클론은 반드시 이 객체를 **복사**해야 한다 (미리보기가 런을 오염시키면 안 된다).
   */
  runVars: Record<string, number>
  flags: Record<string, boolean>

  // --- 비용 ---
  fireCost: number
  ejectCost: number

  rng: Rng
  loadout: Loadout
  /** 순회 순서로 정렬된 활성 부착물 (기계교 각인 복제분 포함) */
  attachments: OrderedAttachments
  /** 암흑 패시브: 트레이 앞쪽 N장이 뒷면 */
  hiddenTrayCount: number
  /** 이번 계산이 미리보기(dry run)인가 */
  dryRun: boolean
  /** 종료 상태 */
  outcome: 'ongoing' | 'win' | 'lose'
}

/** 전투 단위 훅 컨텍스트 */
export interface CombatCtx {
  s: CombatState
  /** 이 훅을 호출한 부착물 id (연출용) */
  self: string
}

/** 탄창 단위 훅 컨텍스트 */
export interface MagCtx extends CombatCtx {
  plan: Ammo[]
}

/** 발사 단위 훅 컨텍스트 */
export interface FireCtx extends CombatCtx {
  ammo: Ammo
  /** 0-based, 이번 탄창 내 발사 순번 */
  index: number
  isFirst: boolean
  isLast: boolean
  /** 직전에 발사한 탄 (이번 탄창 내). 없으면 null */
  prev: Ammo | null
  /** 발사 직전 온도 (이번 발사의 heatGain 적용 전) */
  heatBefore: number
  /** 누적 데미지 (mutable, 덧셈만) */
  dmg: number
  /** 누적 온도 획득 (mutable, 덧셈만) */
  heatGain: number
  /** 발동한 부착물 id 목록 (연출용) */
  triggered: string[]
}

// ---------------------------------------------------------------------------
// 사격 이벤트 로그 — core 가 만들고 sequencer 가 연출로 번역한다
// ---------------------------------------------------------------------------
export type FireEvent =
  | {
      t: 'magStart'
      plan: Ammo[]
      heat: number
    }
  | {
      t: 'shot'
      index: number
      ammo: Ammo
      /** 부착물 보정 후 최종 칩 */
      dmg: number
      heatBefore: number
      heatAfter: number
      /** 적에게 실제로 들어간 피해 (패시브 보정 후) */
      damage: number
      /** 패시브 보정 전 원값 */
      rawDamage: number
      triggered: string[]
      enemyHpAfter: number
    }
  | { t: 'knockback'; meters: number; distanceAfter: number }
  | { t: 'notConsumed'; index: number; ammo: Ammo }
  | { t: 'attachmentProc'; id: string; note: string }
  | { t: 'enemyDead'; overkill: number }
  | { t: 'magEnd'; heatCarried: number; totalDamage: number }
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
  /** 표시용 보상 힌트 */
  rewardHint: Rarity
  label: string
}

/**
 * 한시적 효과. 전투 시작 시 consumeCombatMods() 로 소비된다.
 * WeakMap 이 아니라 RunState 의 필드여야 저장/복원(localStorage)에서 살아남는다.
 */
export interface PendingEffects {
  /** 다음 전투 1회 한정 시작 거리 보정 (m) */
  startDistDelta: number
  /** 다음 전투 1회 한정 사격 시작 온도 보정 */
  heatStartDelta: number
}

/** 섹터가 바뀔 때까지 유지되는 효과 */
export interface SectorEffects {
  /** 이번 섹터 내내 사격 시작 온도 보정 */
  heatStartDelta: number
  /** 이번 섹터 내내 전투 시작 거리 보정 (m) */
  startDistDelta: number
}

export interface RunState {
  seed: number
  sector: number
  /** 섹터 내 노드 인덱스 0..3 */
  nodeIndex: number
  loadout: Loadout
  /** 현재 제시된 갈림길 (없으면 null) */
  doors: DoorOption[] | null
  /** 현재 진행 중인 노드 */
  current: NodeKind | null
  stake: number
  /** 통계 */
  stats: RunStats
  /** 이번 섹터 보스 패시브 (섹터 시작 시 공개) */
  bossPassiveId: string | null
  status: 'alive' | 'dead' | 'won'
  /** 이미 등장한 유물 수 (런당 2개 제한) */
  relicsSeen: number
  /** 정비소 탄 제거 누적 횟수 (가격 상승) */
  removals: number
  rngState: number
  /** 다음 전투 1회 한정 효과 */
  pending: PendingEffects
  /** 이번 섹터 동안 유지되는 효과 */
  sectorMods: SectorEffects
  /** 런 내내 누적되는 부착물 카운터 (스케일링 조커) */
  attVars: Record<string, number>
  /** 이번 런에서 획득한 부착물 총 개수 (교체로 버린 것 포함) */
  attachmentsTaken: number
}

export interface RunStats {
  combatsWon: number
  shotsFired: number
  peakHeat: number
  totalDamage: number
  brassEarned: number
  deaths: number
}

/** startCombat 에 넘기는 런 레벨 보정 (pending + sectorMods 합산분) */
export interface CombatMods {
  startDistDelta: number
  heatStartDelta: number
  /** RunState.attVars 를 그대로 넘긴다 (참조 공유 — 전투 중 누적이 런에 남는다) */
  runVars?: Record<string, number>
  /** 이번 런에서 획득한 부착물 수 (성인의 유해 등이 참조) */
  attachmentsTaken?: number
}

// ---------------------------------------------------------------------------
// 보상
// ---------------------------------------------------------------------------
export type RewardItem =
  | { t: 'attachment'; attachment: Attachment }
  | { t: 'ammo'; ammo: Ammo }
  | { t: 'magazine'; magazine: Magazine }

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
  /** run 을 직접 변형한다. rng 는 run.rngState 로부터 파생 */
  apply(run: RunState, rng: Rng): string
}

// ---------------------------------------------------------------------------
// 상수 (밸런스 문서 §1, §3 과 1:1)
// ---------------------------------------------------------------------------
export const GRADE_BASE: Record<Grade, number> = { 1: 10, 2: 20, 3: 34, 4: 52, 5: 75 }

export const TYPE_DMG_MUL: Record<AmmoType, number> = { AP: 1.7, INC: 0.45, HE: 1.0, SANC: 0.7 }

export const BASE_TRAY = 8
export const BASE_BAG_SIZE = 24
export const BASE_HEAT = 1.0
/** HP(sector,node) = HP_BASE * HP_GROWTH^(sector-1) * nodeMul */
export const HP_BASE = 400
export const HP_GROWTH = 1.95
export const HP_ENDLESS_GROWTH = 2.4
export const NODE_MUL = { small: 1.0, big: 1.63, boss: 2.5 } as const

export const THREAT_HP_MUL: Record<Threat, number> = { 1: 1.0, 2: 1.25, 3: 2.15 }
export const THREAT_SPEED_ADD: Record<Threat, number> = { 1: 0, 2: 1, 3: 3 }
export const THREAT_BRASS: Record<Threat, number> = { 1: 0, 2: 15, 3: 35 }
export const THREAT_REWARD_COUNT: Record<Threat, number> = { 1: 3, 2: 3, 3: 4 }
/** [common, uncommon, rare, relic] */
export const THREAT_RARITY_W: Record<Threat, [number, number, number, number]> = {
  1: [70, 26, 4, 0],
  2: [45, 40, 14, 1],
  3: [20, 45, 30, 5],
}

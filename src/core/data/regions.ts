// ============================================================================
// 지역 (Region) — 런을 세 덩어리로 자른다.
//
// 왜 지역인가:
//   섹터는 여덟 개가 똑같이 생긴 복도였다. 숫자만 올라가고 **어디에 있는지**는
//   달라지지 않으니, 다섯 시간을 걸어도 한 자리에 있는 것 같았다. 지역은 그
//   구간에 얼굴을 준다 — 색, 밝기, 기물, 그리고 끝에 서 있는 것.
//
// 규칙:
//   런 = 3지역 × 3섹터 = 9섹터. 각 지역의 **마지막 섹터 보스 노드**에 그 지역의
//   고유 보스가 선다. 나머지 보스 노드는 지금까지처럼 아키타입 보스다.
//   세 지역을 전부 넘어서면 런이 끝나고 크레딧이 오른다.
//
// 이 파일은 **규칙과 글**만 담는다. 색·안개·조명 같은 그림 쪽 값은
// view3d/Biome.ts 가 지역 id 로 찾아 쓴다 — core 는 three.js 를 모른다.
// ============================================================================
import type { EnemyArchetype, EnemyArchetypeId } from '../types'

/** 한 지역이 품는 섹터 수 */
export const SECTORS_PER_REGION = 3
/** 지역 수 */
export const REGION_COUNT = 3
/** 마지막 섹터 (= 3 × 3) */
export const FINAL_SECTOR = SECTORS_PER_REGION * REGION_COUNT

export type RegionId = 'undercroft' | 'yellow' | 'sanctum'
export type BossId = 'boss_blinky' | 'boss_custodian' | 'boss_mother'

/**
 * 지역 보스.
 *   포피 플레이타임의 문법을 빌린다 — **큰 얼굴 하나, 단순한 덩어리, 과장된 팔.**
 *   무서운 것은 복잡한 것이 아니라 한 장으로 읽히는 것이다. 그래서 셋 다
 *   실루엣만으로 구별되고, 셋 다 눈과 입이 몸통만큼 크다.
 *
 * 대사:
 *   맞을 때마다 한 줄씩 **순서대로** 흘린다. 무작위로 뽑으면 같은 줄이 연달아
 *   나와 '반응' 이 아니라 '소음' 이 된다. 순서대로 돌면 맞을수록 말이 무너지는
 *   구성을 쓸 수 있다 — 세 보스 다 뒤로 갈수록 문장이 짧아진다.
 */
export interface BossDef {
  id: BossId
  /** 화면에 뜨는 이름 */
  name: string
  /** 문에 뜨는 한 줄 */
  title: string
  /** 전투 시작 시 한 번 */
  intro: string
  /** 피격당할 때마다 순서대로 */
  hits: readonly string[]
  /** HP 절반 아래로 처음 내려갔을 때 (hits 를 끊고 끼어든다) */
  half: string
  /** 죽을 때 */
  death: string
  /** 대사 말풍선 색 */
  color: string
  /** 규칙상의 몸 — 아키타입과 같은 자리에 들어간다 */
  archetype: EnemyArchetype
}

// ---------------------------------------------------------------------------
// 지역 1 「강철 하복부」 — 배전과 배관. 차갑고 어둡다.
//   보스 「깜빡이」: 배전함이 몸이고 전구 두 개가 눈이다. 팔은 케이블 다발.
//   말투는 끝까지 정중한 안내방송 — 그게 제일 불쾌하다.
// ---------------------------------------------------------------------------
const BLINKY: BossDef = {
  id: 'boss_blinky',
  name: '깜빡이',
  title: '배전실의 것',
  intro: '어서 오십시오. 조명을 조정하겠습니다.',
  hits: [
    '괜찮습니다. 계속하십시오.',
    '전압이 조금 흔들렸습니다.',
    '수리 요청을 접수했습니다.',
    '그 소리는 처음 듣습니다.',
    '조명을 조정하겠습니다.',
    '조명을. 조명을.',
    '어둡습니다.',
    '누가 껐습니까.',
    '아직 켜져 있습니다.',
    '아직.',
  ],
  half: '점검이 필요합니다. 움직이지 마십시오.',
  death: '불이… 꺼집니다…',
  color: '#ffd98a',
  archetype: {
    id: 'boss_blinky',
    name: '깜빡이',
    hpMul: 2.3,
    speed: 5,
    startDist: 30,
    flavor: '배전함이 걸어 나온다. 전구 두 개가 눈처럼 깜빡인다.',
  },
}

// ---------------------------------------------------------------------------
// 지역 2 「노란 층계」 — 백룸. 젖은 카펫, 노란 벽지, 꺼지지 않는 형광등.
//   보스 「관리인」: 벽지와 같은 색의 매끈한 거인. 검은 눈 두 개와 초승달 입.
//   그림자가 없다 — 이 지역에는 그림자가 없기 때문이다.
// ---------------------------------------------------------------------------
const CUSTODIAN: BossDef = {
  id: 'boss_custodian',
  name: '관리인',
  title: '노란 복도의 것',
  intro: '여기서 나가는 문은 없어요. 제가 다 닦았거든요.',
  hits: [
    '아, 자국이 남잖아요.',
    '그건 제가 치워야 하는데.',
    '벽지는 건드리지 마세요.',
    '여긴 원래 조용했어요.',
    '조용히. 조용히요.',
    '자국이. 자국이.',
    '닦아야 해요.',
    '닦아야.',
    '못 닦아요.',
    '나가지 마세요.',
  ],
  half: '왜 자꾸 벽을 더럽히세요. 제가 다 닦는데.',
  death: '이제… 아무도… 안 와요…',
  color: '#fff3a8',
  archetype: {
    id: 'boss_custodian',
    name: '관리인',
    hpMul: 2.6,
    speed: 7,
    startDist: 36,
    flavor: '벽지와 같은 색이다. 웃는 입만 사람 것이 아니다.',
  },
}

// ---------------------------------------------------------------------------
// 지역 3 「붉은 성소」 — 살과 촛불. 뜨겁고 검붉다.
//   보스 「어머니」: 종처럼 늘어진 살덩이, 가운데 큰 눈 하나, 세로로 벌어진 입.
//   말은 다정하다. 그래서 더 나쁘다.
// ---------------------------------------------------------------------------
const MOTHER: BossDef = {
  id: 'boss_mother',
  name: '어머니',
  title: '성소의 것',
  intro: '멀리도 왔구나. 이리 오렴.',
  hits: [
    '아프지 않단다.',
    '괜찮아. 계속하렴.',
    '너도 여기서 났잖니.',
    '기억나지 않는 거니.',
    '이리 오렴.',
    '이리.',
    '얘야.',
    '얘야…',
    '가지 마.',
    '가지 마라.',
  ],
  half: '왜 이렇게 컸니. 안아 줄 수가 없잖아.',
  death: '잘… 가렴…',
  color: '#ff9aa2',
  archetype: {
    id: 'boss_mother',
    name: '어머니',
    hpMul: 1.95,
    speed: 4,
    startDist: 28,
    flavor: '천장까지 늘어진 살덩이. 가운데 눈 하나가 너를 따라온다.',
  },
}

export const BOSSES: readonly BossDef[] = [BLINKY, CUSTODIAN, MOTHER]

export const BOSS_BY_ID: Record<string, BossDef> = (() => {
  const m: Record<string, BossDef> = {}
  for (const b of BOSSES) m[b.id] = b
  return m
})()

// ---------------------------------------------------------------------------
// 지역
// ---------------------------------------------------------------------------
export interface RegionDef {
  id: RegionId
  index: 1 | 2 | 3
  /** 화면에 뜨는 이름 */
  name: string
  /** 진입할 때 한 줄 */
  tagline: string
  /** 지역 보스 */
  boss: BossDef
}

export const REGIONS: readonly RegionDef[] = [
  {
    id: 'undercroft',
    index: 1,
    name: '강철 하복부',
    tagline: '배관과 배전. 아직 사람이 만든 것의 모양을 하고 있다.',
    boss: BLINKY,
  },
  {
    id: 'yellow',
    index: 2,
    name: '노란 층계',
    tagline: '젖은 카펫과 꺼지지 않는 형광등. 여기엔 그림자가 없다.',
    boss: CUSTODIAN,
  },
  {
    id: 'sanctum',
    index: 3,
    name: '붉은 성소',
    tagline: '벽이 숨을 쉰다. 여기서부터는 만든 것이 아니다.',
    boss: MOTHER,
  },
]

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------
/** 섹터가 속한 지역 번호 (1..3). 범위를 벗어나면 끝 지역으로 붙인다 */
export function regionIndexOf(sector: number): number {
  const s = Number.isFinite(sector) ? Math.max(1, Math.floor(sector)) : 1
  return Math.min(REGION_COUNT, Math.ceil(s / SECTORS_PER_REGION))
}

export function regionOf(sector: number): RegionDef {
  return REGIONS[regionIndexOf(sector) - 1] as RegionDef
}

/** 그 지역 안에서 몇 번째 섹터인가 (1..3) */
export function sectorInRegion(sector: number): number {
  const s = Math.max(1, Math.floor(sector))
  return ((s - 1) % SECTORS_PER_REGION) + 1
}

/** 이 섹터의 보스 노드에 지역 보스가 서는가 — 지역의 마지막 섹터에서만 */
export function isRegionBossSector(sector: number): boolean {
  return sectorInRegion(sector) === SECTORS_PER_REGION
}

/** 이 섹터 보스 노드의 지역 보스. 없으면 null */
export function regionBossOf(sector: number): BossDef | null {
  return isRegionBossSector(sector) ? regionOf(sector).boss : null
}

/** 지역 보스 아키타입 id 목록 — 일반 적 풀에서 걸러낼 때 쓴다 */
export const BOSS_ARCHETYPE_IDS: readonly string[] = BOSSES.map((b) => b.id)

export const BOSS_ARCHETYPES: Record<string, EnemyArchetype> = (() => {
  const m: Record<string, EnemyArchetype> = {}
  for (const b of BOSSES) m[b.id] = b.archetype
  return m
})()

export function isBossArchetype(id: EnemyArchetypeId | string): boolean {
  return BOSS_ARCHETYPE_IDS.includes(id)
}

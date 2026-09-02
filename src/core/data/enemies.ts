// 적 아키타입 5종(BALANCE.md §3)과 보스/엘리트 패시브 10종(GDD.md §8.3)의 데이터 정의.
// HP 곡선 계산(baseHp)과 실제 개체 생성(makeEnemy)도 여기서 담당한다.
// 패시브는 훅으로만 규칙을 왜곡한다 — 수치를 새로 만들지 않는다.

import type {
  Attachment,
  EnemyArchetype,
  EnemyArchetypeId,
  EnemyInstance,
  EnemyPassive,
  FireCtx,
  MagCtx,
  Threat,
} from '../types'
import {
  HP_BASE,
  HP_ENDLESS_GROWTH,
  HP_GROWTH,
  THREAT_HP_MUL,
  THREAT_SPEED_ADD,
} from '../types'

// ---------------------------------------------------------------------------
// 아키타입 (BALANCE.md §3 "아키타입 · 위험도 보정" 표와 1:1)
//   행동 수 = floor(D0 / S) — 이 값이 전투의 성격을 결정한다.
// ---------------------------------------------------------------------------

const SHAMBLER: EnemyArchetype = {
  id: 'shambler',
  name: '배회자',
  hpMul: 1.0,
  speed: 5,
  startDist: 30,
  flavor: '느리지만 멈추지 않는다. 모든 계산의 기준선.',
}

const RUNNER: EnemyArchetype = {
  id: 'runner',
  name: '주자',
  hpMul: 0.55,
  speed: 10,
  startDist: 32,
  flavor: '어둠 속에서 갑자기 속도를 올린다. 세 번이면 끝난다.',
}

const BLOAT: EnemyArchetype = {
  id: 'bloat',
  name: '비대체',
  hpMul: 1.8,
  speed: 3,
  startDist: 26,
  flavor: '부푼 몸이 복도를 메운다. 오래 예열할 시간을 준다.',
}

const HORDE: EnemyArchetype = {
  id: 'horde',
  name: '무리',
  hpMul: 1.3,
  speed: 6,
  startDist: 34,
  flavor: '여럿이 한 덩어리로 밀려온다. 연출은 다수, 규칙은 하나.',
}

const CRAWLER: EnemyArchetype = {
  id: 'crawler',
  name: '기어다니는 것',
  hpMul: 0.7,
  speed: 4,
  startDist: 18,
  flavor: '바닥을 기어 이미 코앞이다. 근거리 부착물이 깨어난다.',
}

/**
 * 추적자: 빠른데 단단하다. 주자(HP 0.55)는 '세 번이면 끝' 이었지만 이 녀석은
 * 네 번 안에 1.15배 HP 를 깎아야 한다 — 거리 자원이 가장 빡빡한 적.
 */
const STALKER: EnemyArchetype = {
  id: 'stalker',
  name: '추적자',
  hpMul: 1.15,
  speed: 8,
  startDist: 38,
  flavor: '발소리가 없다. 눈을 뗀 사이에 반쯤 와 있다.',
}

/**
 * 거상: 비대체(1.8) 위의 체력 벽. 느리지만 2.6배 — 예열할 시간은 주되
 * 한 탄창으로는 절대 안 끝난다. 장기전 패시브와 붙으면 최악이다.
 */
const COLOSSUS: EnemyArchetype = {
  id: 'colossus',
  name: '거상',
  hpMul: 2.6,
  speed: 3,
  startDist: 22,
  flavor: '천장을 긁으며 온다. 복도가 좁아지는 게 아니라 저게 커지는 것이다.',
}

export const ARCHETYPES: EnemyArchetype[] = [SHAMBLER, RUNNER, BLOAT, HORDE, CRAWLER, STALKER, COLOSSUS]

export const ARCH_BY_ID: Record<EnemyArchetypeId, EnemyArchetype> = {
  shambler: SHAMBLER,
  runner: RUNNER,
  bloat: BLOAT,
  horde: HORDE,
  crawler: CRAWLER,
  stalker: STALKER,
  colossus: COLOSSUS,
}

// ---------------------------------------------------------------------------
// 패시브 (GDD.md §8.3) — 각 패시브는 정확히 하나의 축만 봉쇄한다.
// ---------------------------------------------------------------------------

/**
 * 강직: 순서 축 봉쇄. index 는 0-based 이므로 2번째 탄 == index 1.
 * 데미지만 0 이면 2번 칸에 싼 예열탄을 끼워 넘길 수 있었다 — 온도도 함께 막아야
 * '그 칸을 어떻게 쓸까' 가 진짜 문제가 된다. (유효HP배수 1.15 → 1.32)
 */
const RIGID: EnemyPassive = {
  id: 'rigid',
  name: '강직',
  text: '탄창의 2번째 탄은 데미지도 온도도 얻지 못한다',
  modifyDamage: (d, c) => (c.index === 1 ? 0 : d),
  modifyHeatGain: (g, c) => (c.index === 1 ? 0 : g),
}

/**
 * 장갑: 데미지를 깎으면 '그냥 아프기만' 하다 — 재배열로 회복되는 폭이 +2.3% 뿐이었다.
 * 온도를 깎으면 예열 계획 자체를 다시 짜야 한다 (회복 +12.8%, 배수 1.14 → 1.26).
 */
const PLATED: EnemyPassive = {
  id: 'plated',
  name: '장갑',
  text: '매 사격의 첫 2발은 온도를 절반만 얻는다',
  modifyHeatGain: (g, c) => (c.index < 2 ? g * 0.5 : g),
}

/** 최후 방벽: 마지막 한 칸만으로는 지분이 40% 뿐이라 배수 1.12 에 그쳤다 → 두 칸 */
const BULWARK: EnemyPassive = {
  id: 'bulwark',
  name: '최후 방벽',
  text: '탄창의 마지막 두 탄 데미지 50%',
  modifyDamage: (d, c) =>
    c.index >= c.s.magPlan.length - 2 ? Math.round(d * 0.5) : d,
}

const LUNGE: EnemyPassive = {
  id: 'lunge',
  name: '돌진',
  text: '사격을 마칠 때마다 추가로 4m 접근',
  onMagEnd: (c) => {
    if (c.s.enemy.hp <= 0) return
    c.s.distance -= 4
  },
}

/** 냉혈: 유일한 곱셈 축을 직접 깎는다. 0.6 은 10종 중 최상위(배수 1.59)라 과했다 */
const COLDBLOOD: EnemyPassive = {
  id: 'coldblood',
  name: '냉혈',
  text: '온도 획득 25% 감소',
  modifyHeatGain: (g) => g * 0.75,
}

/**
 * 재생: 사격당 고정 4% 는 어떤 빌드에도 똑같이 걸리는 순수 세금이었다(배수 1.20, 범위 1.08~1.28).
 * **발당** 1.5% 로 바꾸면 대용량 탄창일수록 아프므로 탄창 선택과 맞물린다.
 */
const REGEN: EnemyPassive = {
  id: 'regen',
  name: '재생',
  text: '사격을 마칠 때 쏜 탄 1발마다 최대 HP의 1.5% 회복',
  onMagEnd: (c) => {
    const e = c.s.enemy
    if (e.hp <= 0) return
    const back = Math.round(e.maxHp * 0.015 * c.s.magFired.length)
    e.hp = Math.min(e.maxHp, e.hp + back)
  },
}

/** 특수탄 축 봉쇄 — 특수탄 의존 빌드에만 아프다 */
/** 봉인: 0.5 는 배수 1.40~1.61(최대 3.59)로 과했다. '특수탄을 안 쓴다' 는 대응이 없다 */
const SEALED: EnemyPassive = {
  id: 'sealed',
  name: '봉인',
  text: '특수탄 데미지 30% 감소',
  modifyDamage: (d, c) => (c.round.special !== null ? Math.round(d * 0.7) : d),
}

/** 특수탄 재고 압박 — 장기전을 벌하고 속공을 강요한다 */
const DEVOUR: EnemyPassive = {
  id: 'devour',
  name: '탐식',
  text: '사격을 마칠 때마다 특수탄 3발이 소실된다',
  onMagEnd: (c) => {
    if (c.s.dryRun || c.s.enemy.hp <= 0) return
    for (let i = 0; i < 3; i += 1) {
      const ids = Object.keys(c.s.specials).filter((k) => (c.s.specials[k] ?? 0) > 0)
      if (ids.length === 0) return
      const id = ids[c.s.rng.int(ids.length)]
      c.s.specials[id] = Math.max(0, (c.s.specials[id] ?? 0) - 1)
    }
  },
}

/**
 * 부착물 축 봉쇄 — 광학에 투자한 빌드에만 아프다.
 *
 * 두 가지가 깨져 있었다:
 *  ① '보조 레일에 단 광학' 만 껐는데 레일이 0칸인 플레이어에게는 아무 일도 안 일어났다
 *     (16빌드 중 14개가 정확히 무효). 광학 부위 전체로 넓힌다.
 *  ② attachments 배열을 직접 걸러냈는데, swapAttachment 가 orderedAttachments 로
 *     통째로 다시 만들기 때문에 **광학이 아닌 아무 부품을 한 번 교체하는 것만으로**
 *     봉쇄가 풀렸다 (실측 총피해 22% → 95% 복구). 플래그로 남기고 재계산 뒤 다시 적용한다.
 */
const JAMMING: EnemyPassive = {
  id: 'jamming',
  name: '교란',
  text: '이번 전투 동안 광학이 작동하지 않는다',
  onCombatStart: (c) => {
    c.s.flags['jammed'] = true
    applyJam(c.s)
  },
}

/** 교란 상태를 attachments 에 반영한다. swapAttachment 도 재계산 후 이걸 부른다. */
export function applyJam(s: { flags: Record<string, boolean>; attachments: Attachment[] }): void {
  if (s.flags['jammed'] !== true) return
  s.attachments = s.attachments.filter((a) => a.slot !== 'optic')
}

/**
 * 온도 상한 — 과열 빌드에만 아프다.
 * '넘으면 사격 중단' 은 복권이었다: 중앙값 배수 1.09 인데 최대 10.21 (한 발 차이로
 * 탄창이 통째로 날아간다). **상한형**으로 바꾸면 같은 축을 막으면서 분산이 사라진다
 * (배수 1.15~1.33, 무효 빌드 16개 중 2개).
 */
const ENTROPY: EnemyPassive = {
  id: 'entropy',
  name: '열역학',
  text: '온도가 26을 넘지 않는다 — 초과분은 얻지 못한다',
  modifyHeatGain: (g, c) => {
    const room = 26 - c.s.heat
    return room <= 0 ? 0 : Math.min(g, room)
  },
}

/**
 * 굶주림: 사격을 마칠 때마다 속도 +2 — 사격 비용이 매번 오른다.
 * 돌진(고정 −4m)과 달리 **오래 끌수록 가속**하므로 저온·장기전 빌드에 아프다.
 * fireCost 재계산은 combat.ts 가 magEnd 훅 뒤에 속도 변화를 보고 처리한다.
 */
const HUNGER: EnemyPassive = {
  id: 'hunger',
  name: '굶주림',
  text: '사격을 마칠 때마다 적 속도 +2 (사격 비용이 늘어난다)',
  onMagEnd: (c) => {
    if (c.s.enemy.hp <= 0) return
    c.s.enemy.speed += 2
  },
}

/**
 * 심연: 온도가 사격 사이에 이월되지 않는다. 열역학(상한 26)이 '얼마나 뜨거운가' 를
 * 막는다면 심연은 '뜨거움을 들고 넘어가는 것' 을 막는다 — 매 사격이 첫 사격이다.
 * 냉각 자켓·이월 빌드에만 아프고, 빙하의 성해 빌드는 오히려 무관하다.
 */
const ABYSS: EnemyPassive = {
  id: 'abyss',
  name: '심연',
  text: '이번 전투 동안 온도가 사격 사이에 이월되지 않는다',
  onCombatStart: (c) => {
    c.s.flags['noCarry'] = true
  },
}

/**
 * 흡열: 뜨거운 탄을 맞을수록 회복한다. 재생(발수 비례)이 대용량을 벌한다면
 * 흡열은 **고온 자체**를 벌한다 — 온도 15 이상에서 쏜 발마다 최대 HP 2% 회복.
 * 발당 회복이라 뜨거운 대용량 탄창은 이중으로 손해다. 한 탄창 최대 12% 로 캡.
 */
const SIPHON: EnemyPassive = {
  id: 'siphon',
  name: '흡열',
  text: '온도 15 이상에서 쏜 탄 1발마다 최대 HP 2% 회복 (사격당 최대 12%)',
  onMagStart: (c) => { c.s.vars['siphonMag'] = 0 },
  onAfterShot: (c) => {
    if (c.heatBefore < 15) return
    const e = c.s.enemy
    if (e.hp <= 0) return
    const used = c.s.vars['siphonMag'] ?? 0
    if (used >= 6) return
    c.s.vars['siphonMag'] = used + 1
    e.hp = Math.min(e.maxHp, e.hp + Math.round(e.maxHp * 0.02))
  },
}

export const PASSIVES: EnemyPassive[] = [
  RIGID,
  PLATED,
  BULWARK,
  LUNGE,
  COLDBLOOD,
  REGEN,
  SEALED,
  DEVOUR,
  JAMMING,
  ENTROPY,
  HUNGER,
  ABYSS,
  SIPHON,
]

export const PASSIVE_BY_ID: Record<string, EnemyPassive> = (() => {
  const m: Record<string, EnemyPassive> = {}
  for (const p of PASSIVES) m[p.id] = p
  return m
})()

// ---------------------------------------------------------------------------
// HP 곡선 (BALANCE.md §3)
//   HP(sector, node) = HP_BASE × HP_GROWTH^(sector-1) × nodeMul  (상수는 types.ts)
//   엔드리스(섹터 9+)는 8섹터까지 HP_GROWTH, 그 이후 구간만 HP_ENDLESS_GROWTH 를 곱한다.
//   난이도 상향(R10): 380 × 1.91^(s-1), big 1.8 / boss 2.2, 위험도 1.05/1.35/3.5.
// ---------------------------------------------------------------------------

const LAST_SECTOR = 8

export function baseHp(sector: number, nodeMul: number, endless: boolean): number {
  // 방어: 섹터는 1 이상의 정수로만 다룬다 (호출부 실수로 NaN 이 새지 않게).
  const s = Number.isFinite(sector) ? Math.max(1, Math.floor(sector)) : 1
  const mul = Number.isFinite(nodeMul) ? nodeMul : 1

  if (!endless || s <= LAST_SECTOR) {
    return Math.round(HP_BASE * Math.pow(HP_GROWTH, s - 1) * mul)
  }
  const normal = Math.pow(HP_GROWTH, LAST_SECTOR - 1)
  const extra = Math.pow(HP_ENDLESS_GROWTH, s - LAST_SECTOR)
  return Math.round(HP_BASE * normal * extra * mul)
}

// ---------------------------------------------------------------------------
// 개체 생성
// ---------------------------------------------------------------------------

/** 위험도 표기 — 문 UI 와 라벨에서 공용으로 쓰는 마름모 표기 */
function threatMark(threat: Threat): string {
  let s = ''
  for (let i = 0; i < threat; i++) s += '◆'
  return s
}

export function makeEnemy(opts: {
  archetypeId: EnemyArchetypeId
  passiveId: string | null
  sector: number
  nodeMul: number
  threat: Threat
  stakeHpMul?: number
}): EnemyInstance {
  const arch = ARCH_BY_ID[opts.archetypeId]
  const passive = opts.passiveId ? PASSIVE_BY_ID[opts.passiveId] ?? null : null

  // 엔드리스 여부는 섹터 번호가 곧 답이다 (섹터 9+ == 엔드리스 구간).
  const base = baseHp(opts.sector, opts.nodeMul, opts.sector > LAST_SECTOR)
  const stakeMul = opts.stakeHpMul ?? 1
  const hp = Math.max(1, Math.round(base * arch.hpMul * THREAT_HP_MUL[opts.threat] * stakeMul))

  const speed = arch.speed + THREAT_SPEED_ADD[opts.threat]

  return {
    archetype: arch,
    passive,
    maxHp: hp,
    hp,
    speed,
    startDist: arch.startDist,
    label: arch.name + ' ' + threatMark(opts.threat),
    // 무리만 연출상 다수. 규칙상으로는 언제나 단일 개체다 (GDD §8.2).
    bodyCount: arch.id === 'horde' ? 5 : 1,
    vuln: 0,
  }
}

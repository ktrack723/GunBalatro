// 적 아키타입 5종(BALANCE.md §3)과 보스/엘리트 패시브 10종(GDD.md §8.3)의 데이터 정의.
// HP 곡선 계산(baseHp)과 실제 개체 생성(makeEnemy)도 여기서 담당한다.
// 패시브는 훅으로만 규칙을 왜곡한다 — 수치를 새로 만들지 않는다.

import type {
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

export const ARCHETYPES: EnemyArchetype[] = [SHAMBLER, RUNNER, BLOAT, HORDE, CRAWLER]

export const ARCH_BY_ID: Record<EnemyArchetypeId, EnemyArchetype> = {
  shambler: SHAMBLER,
  runner: RUNNER,
  bloat: BLOAT,
  horde: HORDE,
  crawler: CRAWLER,
}

// ---------------------------------------------------------------------------
// 패시브 (GDD.md §8.3) — 각 패시브는 정확히 하나의 축만 봉쇄한다.
// ---------------------------------------------------------------------------

/** 강직: 순서 축 봉쇄. index 는 0-based 이므로 2번째 탄 == index 1. */
const RIGID: EnemyPassive = {
  id: 'rigid',
  name: '강직',
  text: '탄창의 2번째 탄 데미지 0',
  modifyDamage: (d, c) => (c.index === 1 ? 0 : d),
}

const PLATED: EnemyPassive = {
  id: 'plated',
  name: '장갑',
  text: '매 사격의 첫 2발 데미지 50%',
  modifyDamage: (d, c) => (c.index < 2 ? Math.round(d * 0.5) : d),
}

const BULWARK: EnemyPassive = {
  id: 'bulwark',
  name: '최후 방벽',
  text: '탄창의 마지막 탄 데미지 50%',
  modifyDamage: (d, c) => (c.isLast ? Math.round(d * 0.5) : d),
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

const COLDBLOOD: EnemyPassive = {
  id: 'coldblood',
  name: '냉혈',
  text: '온도 획득 40% 감소',
  modifyHeatGain: (g) => g * 0.6,
}

const REGEN: EnemyPassive = {
  id: 'regen',
  name: '재생',
  text: '사격 사이 최대 HP의 4% 회복',
  onMagEnd: (c) => {
    const e = c.s.enemy
    if (e.hp <= 0) return
    e.hp = Math.min(e.maxHp, e.hp + Math.round(e.maxHp * 0.04))
  },
}

/** 특수탄 축 봉쇄 — 특수탄 의존 빌드에만 아프다 */
const SEALED: EnemyPassive = {
  id: 'sealed',
  name: '봉인',
  text: '특수탄 데미지 50%',
  modifyDamage: (d, c) => (c.round.special !== null ? Math.round(d * 0.5) : d),
}

/** 특수탄 재고 압박 — 장기전을 벌하고 속공을 강요한다 */
const DEVOUR: EnemyPassive = {
  id: 'devour',
  name: '탐식',
  text: '사격을 마칠 때마다 특수탄 1발이 소실된다',
  onMagEnd: (c) => {
    if (c.s.dryRun || c.s.enemy.hp <= 0) return
    const ids = Object.keys(c.s.specials).filter((k) => (c.s.specials[k] ?? 0) > 0)
    if (ids.length === 0) return
    const id = ids[c.s.rng.int(ids.length)]
    c.s.specials[id] = Math.max(0, (c.s.specials[id] ?? 0) - 1)
  },
}

/** 부착물 축 봉쇄 — 레일 조합 빌드에만 아프다 */
const JAMMING: EnemyPassive = {
  id: 'jamming',
  name: '교란',
  text: '이번 전투 동안 보조 레일 부착물이 작동하지 않는다',
  onCombatStart: (c) => {
    const railIds = new Set(c.s.loadout.rails.filter((r) => r !== null).map((r) => r!.id))
    if (railIds.size === 0) return
    c.s.attachments = c.s.attachments.filter((a) => !railIds.has(a.id))
  },
}

/** 온도 상한 — 과열 빌드에만 아프다 */
const ENTROPY: EnemyPassive = {
  id: 'entropy',
  name: '열역학',
  text: '온도가 26을 넘으면 그 사격이 즉시 종료된다',
  onAfterShot: (c) => {
    if (c.s.heat > 26) c.s.abortMag = true
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
]

export const PASSIVE_BY_ID: Record<string, EnemyPassive> = (() => {
  const m: Record<string, EnemyPassive> = {}
  for (const p of PASSIVES) m[p.id] = p
  return m
})()

// ---------------------------------------------------------------------------
// HP 곡선 (BALANCE.md §3)
//   HP(sector, node) = 400 × 2.15^(sector-1) × nodeMul
//   엔드리스(섹터 9+)는 8섹터까지 2.15, 그 이후 구간만 2.60 을 곱한다.
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

// 적 아키타입 5종(BALANCE.md §3)과 보스/엘리트 패시브 10종(GDD.md §8.3)의 데이터 정의.
// HP 곡선 계산(baseHp)과 실제 개체 생성(makeEnemy)도 여기서 담당한다.
// 패시브는 훅으로만 규칙을 왜곡한다 — 수치를 새로 만들지 않는다.

import type {
  Ammo,
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
import { ammoStats } from '../ammoStats'

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
  text: '탄창의 2번째 탄은 데미지가 0이 된다.',
  modifyDamage(damage: number, c: FireCtx): number {
    return c.index === 1 ? 0 : damage
  },
}

/** 장갑: 앞부분 축 봉쇄. 매 사격의 첫 2발(index 0,1)이 42%. */
const PLATED: EnemyPassive = {
  id: 'plated',
  name: '장갑',
  text: '매 사격의 첫 2발은 데미지가 42%가 된다.',
  modifyDamage(damage: number, c: FireCtx): number {
    return c.index < 2 ? Math.round(damage * 0.42) : damage
  },
}

/** 돌진: 자원(거리) 축 봉쇄. 사격 행동의 거리 소모와 별개로 추가 6m. */
const LUNGE: EnemyPassive = {
  id: 'lunge',
  name: '돌진',
  text: '사격 행동이 끝날 때마다 거리가 6m 더 줄어든다.',
  onMagEnd(c: MagCtx): void {
    c.s.distance -= 6
  },
}

/** 냉혈: 온도 축 봉쇄. 획득분에만 곱한다(누적 온도 자체를 건드리지 않는다). */
const COLDBLOOD: EnemyPassive = {
  id: 'coldblood',
  name: '냉혈',
  text: '온도 획득이 48% 줄어든다.',
  modifyHeatGain(gain: number): number {
    return gain * 0.52
  },
}

/** 재생: 시간 축 봉쇄. 사격 사이에 최대 HP 의 6% 회복. */
const REGEN: EnemyPassive = {
  id: 'regen',
  name: '재생',
  text: '사격 사이에 최대 체력의 6%를 회복한다.',
  onMagEnd(c: MagCtx): void {
    const e = c.s.enemy
    if (e.hp <= 0) return
    const heal = Math.round(e.maxHp * 0.06)
    e.hp = Math.min(e.maxHp, e.hp + heal)
  },
}

/** 역병: 덱 축 봉쇄. 가방+트레이에서 1발을 이번 전투 한정으로 소멸시킨다(spent 로도 안 간다). */
const PLAGUE: EnemyPassive = {
  id: 'plague',
  name: '역병',
  text: '사격이 끝날 때마다 탄 1발이 이번 전투에서 소멸한다.',
  onMagEnd(c: MagCtx): void {
    if (c.s.dryRun) return
    const bagLen = c.s.bag.length
    const total = bagLen + c.s.tray.length
    if (total <= 0) return
    const i = c.s.rng.int(total)
    if (i < bagLen) c.s.bag.splice(i, 1)
    else c.s.tray.splice(i - bagLen, 1)
  },
}

/** 암흑: 정보 축 봉쇄. 트레이 앞쪽 5장이 뒷면. */
const BLIND: EnemyPassive = {
  id: 'blind',
  name: '암흑',
  text: '트레이의 5발이 뒷면으로 가려진다.',
  hiddenTrayCount: 5,
}

/** 성별 거부: 특정 탄종 축 봉쇄. 축성탄 데미지 0 + 와일드 판정 무효. */
const ANATHEMA: EnemyPassive = {
  id: 'anathema',
  name: '성별 거부',
  text: '축성탄 데미지 0. 와일드 판정도 불가.',
  disableWildcard: true,
  modifyDamage(damage: number, c: FireCtx): number {
    return c.ammo.type === 'SANC' ? 0 : damage
  },
}

/** 열역학: 상한 축 봉쇄. 발사 직후 온도가 17을 넘었으면 그 사격을 끊는다. */
const ENTROPY: EnemyPassive = {
  id: 'entropy',
  name: '열역학',
  text: '온도가 17을 넘으면 그 사격이 즉시 끝난다.',
  onAfterShot(c: FireCtx): void {
    if (c.s.heat > 17) c.s.abortMag = true
  },
}

/** 포식: 최고치 축 봉쇄. 사격 시작 시 트레이의 최고 데미지 탄 1발을 먹는다. */
const DEVOUR: EnemyPassive = {
  id: 'devour',
  name: '포식',
  text: '사격 시작 시 트레이의 최고 데미지 탄을 삼킨다.',
  onMagStart(c: MagCtx): void {
    if (c.s.dryRun) return
    const tray = c.s.tray
    if (tray.length === 0) return
    let best = 0
    let bestDmg = ammoStats(tray[0]).dmg
    for (let i = 1; i < tray.length; i++) {
      const d = ammoStats(tray[i]).dmg
      if (d > bestDmg) {
        bestDmg = d
        best = i
      }
    }
    const eaten: Ammo[] = tray.splice(best, 1)
    if (eaten.length > 0) c.s.spent.push(eaten[0])
  },
}

export const PASSIVES: EnemyPassive[] = [
  RIGID,
  PLATED,
  LUNGE,
  COLDBLOOD,
  REGEN,
  PLAGUE,
  BLIND,
  ANATHEMA,
  ENTROPY,
  DEVOUR,
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
  }
}

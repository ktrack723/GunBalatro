// BALANCE.md §7 손계산 3건을 실제 엔진으로 재현해 문서와 대조한다.
// 엔진이 정답이고 문서가 손계산이므로, 어긋나는 자리는 실측값을 expect 에 넣고
// DOC/ACTUAL 주석으로 문서 수정이 필요한 지점을 못박아 둔다.

import { describe, expect, it } from 'vitest'

import type {
  Ammo,
  AmmoType,
  Attachment,
  EnemyInstance,
  FireEvent,
  Grade,
  Loadout,
  Magazine,
} from '../types'
import { HP_BASE, HP_GROWTH, HP_ENDLESS_GROWTH, NODE_MUL } from '../types'
import { makeRng } from '../rng'
import { fire, startCombat } from '../combat'
import { ATT_BY_ID } from '../data/attachments'
import { ARCH_BY_ID, baseHp } from '../data/enemies'
import { MAG_BY_ID } from '../data/magazines'

// ---------------------------------------------------------------------------
// 조립 헬퍼
// ---------------------------------------------------------------------------

let uid = 0
function A(type: AmmoType, grade: Grade): Ammo {
  uid += 1
  return { uid: 'b' + uid, type, grade }
}

/** 검산은 "한 탄창이 끝까지 발사되는지"만 보면 되므로 표적 HP 는 사실상 무한이다. */
function target(): EnemyInstance {
  return {
    archetype: ARCH_BY_ID.shambler,
    passive: null,
    maxHp: 1e12,
    hp: 1e12,
    speed: 5,
    startDist: 30,
    label: '검산 표적',
    bodyCount: 1,
  }
}

function mount(l: Loadout, a: Attachment): void {
  switch (a.slot) {
    case 'barrel':
      l.barrel = a
      break
    case 'handguard':
      l.handguard = a
      break
    case 'optic':
      l.optic = a
      break
    case 'stock':
      l.stock = a
      break
    case 'rail':
      l.railSlots += 1
      l.rails.push(a)
      break
  }
}

function buildLoadout(attachmentIds: readonly string[], magazine: Magazine, bag: Ammo[]): Loadout {
  const l: Loadout = {
    barrel: null,
    handguard: null,
    optic: null,
    stock: null,
    rails: [],
    railSlots: 0,
    magazine,
    bag,
    brass: 0,
  }
  for (const id of attachmentIds) {
    const a = ATT_BY_ID[id]
    expect(a, `부착물 id 가 카탈로그에 없다: ${id}`).toBeTruthy()
    mount(l, a)
  }
  return l
}

interface MagResult {
  chips: number[]
  heats: number[]
  damages: number[]
  total: number
}

/**
 * 한 탄창을 그대로 발사하고 발사별 (칩 / 발사 후 온도 / 피해) 를 돌려준다.
 * startHeat 은 냉각 자켓 이월분을 흉내내기 위한 "사격 시작 온도" 강제값이다.
 */
function shootMag(
  attachmentIds: readonly string[],
  magazine: Magazine,
  plan: Ammo[],
  startHeat?: number,
): MagResult {
  const l = buildLoadout(attachmentIds, magazine, plan.slice())
  const s = startCombat(l, target(), makeRng(1))
  if (startHeat !== undefined) s.heatStartBase = startHeat
  const events: FireEvent[] = fire(s, plan)

  const shots = events.filter((e): e is Extract<FireEvent, { t: 'shot' }> => e.t === 'shot')
  return {
    chips: shots.map((e) => e.dmg),
    heats: shots.map((e) => e.heatAfter),
    damages: shots.map((e) => e.damage),
    total: s.magDamage,
  }
}

function closeAll(actual: number[], expected: number[]): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i], 6)
  }
}

// ---------------------------------------------------------------------------
// §7.1 섹터 1 · 부착물 0개 · 시작 덱
// ---------------------------------------------------------------------------

describe('BALANCE.md §7.1 — 부착물 0개 시작 덱', () => {
  const forward = (): Ammo[] => [A('INC', 2), A('INC', 2), A('INC', 1), A('AP', 1), A('AP', 2)]
  const reverse = (): Ammo[] => [A('AP', 2), A('AP', 1), A('INC', 1), A('INC', 2), A('INC', 2)]

  it('예열 → 피니셔 순서: 합계 263', () => {
    const r = shootMag([], MAG_BY_ID['m1'], forward())
    expect(r.damages).toEqual([18, 27, 19, 65, 134])
    closeAll(r.heats, [2.0, 3.0, 3.75, 3.85, 3.95])
    expect(r.total).toBe(263)
  })

  it('역순 배열: 합계 130 — 정확히 절반', () => {
    const r = shootMag([], MAG_BY_ID['m1'], reverse())
    expect(r.damages).toEqual([37, 20, 10, 27, 36])
    closeAll(r.heats, [1.1, 1.2, 1.95, 2.95, 3.95])
    expect(r.total).toBe(130)
  })

  it('순서만 뒤집어도 데미지가 2배 이상 갈린다 (게임의 존재의의)', () => {
    const f = shootMag([], MAG_BY_ID['m1'], forward()).total
    const b = shootMag([], MAG_BY_ID['m1'], reverse()).total
    expect(f / b).toBeGreaterThan(2)
  })

  it('섹터 1 소형(400)은 2탄창, 보스(1,000)는 4탄창 안에 정리된다', () => {
    const per = shootMag([], MAG_BY_ID['m1'], forward()).total
    expect(Math.ceil(baseHp(1, NODE_MUL.small, false) / per)).toBe(2)
    expect(Math.ceil(baseHp(1, NODE_MUL.boss, false) / per)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// §7.2 섹터 4 · 중급 빌드
// ---------------------------------------------------------------------------

describe('BALANCE.md §7.2 — 중급 빌드', () => {
  // 중총열(AP+28) / 소이 촉매(INC HEAT+0.6) / 열화상(전탄 DMG+20) / 고정 개머리판 / 죽음의 성사
  const BUILD = [
    'br_heavy_barrel',
    'hg_incendiary_catalyst',
    'op_thermal_scope',
    'st_fixed_stock',
    'rl_death_rite',
  ]
  const plan = (): Ammo[] => [A('INC', 3), A('INC', 3), A('INC', 3), A('AP', 4), A('AP', 4)]

  it('합계 3,948', () => {
    const r = shootMag(BUILD, MAG_BY_ID['m1'], plan())
    expect(r.chips).toEqual([35, 35, 35, 136, 136])
    closeAll(r.heats, [2.85, 4.7, 6.55, 6.65, 18.75])
    expect(r.damages).toEqual([100, 165, 229, 904, 2550])
    expect(r.total).toBe(3948)
  })

  it('중급 빌드가 섹터 4 소형은 1탄창, 보스는 6행동 안에 잡는다', () => {
    const per = shootMag(BUILD, MAG_BY_ID['m1'], plan()).total
    // 절대값이 아니라 "몇 탄창인가"를 잠근다 — HP 곡선은 시뮬레이션으로 튜닝되는 값이다.
    expect(Math.ceil(baseHp(4, NODE_MUL.small, false) / per)).toBe(1)
    const bossMags = Math.ceil(baseHp(4, NODE_MUL.boss, false) / per)
    expect(bossMags).toBeGreaterThanOrEqual(2) // 너무 싱거우면 안 된다
    expect(bossMags).toBeLessThanOrEqual(4) // 배회자 6행동 안에 들어와야 한다
  })
})

// ---------------------------------------------------------------------------
// §7.3 섹터 8 보스 · 완성 빌드
// ---------------------------------------------------------------------------

describe('BALANCE.md §7.3 — 완성 빌드 (이월 온도 8.00 시작)', () => {
  // 심판의 총열 / 용광로 심장 / 영혼 표식 / 거인의 보폭 / 죽음의 성사 + 피의 계약, 탄창 M7
  const BUILD = [
    'br_judgment',
    'hg_furnace_heart',
    'op_soul_mark',
    'st_giant_stride',
    'rl_death_rite',
    'rl_blood_pact',
  ]
  const plan = (): Ammo[] => [A('INC', 5), A('INC', 5), A('INC', 5), A('AP', 5), A('AP', 5)]

  // DOC: 44,530 / ACTUAL: 30,272 — 문서 수정 필요.
  //   원인은 임계 조건의 기준 온도다. 문서 표는 용광로 심장(온도 10 이상)을 heatBefore=9.75 인
  //   2번 탄에, 피의 계약(온도 15 초과)을 heatBefore=14.50 인 3번 탄에 적용해 두 효과를 각각
  //   한 발씩 일찍 터뜨린다 — 즉 "이번 발사의 heatGain 을 더한 뒤" 판정한 손계산이다.
  //   스펙(GDD §4)과 data/attachments.ts 구현은 둘 다 heatBefore(발사 전 온도) 기준이므로
  //   두 효과가 한 발씩 늦게 켜지고 합계가 낮아진다.
  it('합계 (DOC: 44,530 / ACTUAL: 30,272)', () => {
    const r = shootMag(BUILD, MAG_BY_ID['m7'], plan(), 8)

    // 칩: [34, 34, 34, 128+110, 128+110+round(5881×8%)]
    // DOC: [34, 34, 144, 238, 951]
    expect(r.chips).toEqual([34, 34, 34, 238, 708])

    // 온도: 용광로 심장은 3번 탄(heatBefore 11.50)부터 켜진다.
    // DOC: [9.75, 14.50, 19.25, 22.35, 37.45]
    closeAll(r.heats, [9.75, 11.5, 16.25, 19.35, 34.45])

    // DOC: [331, 493, 2772, 5319, 35615]
    expect(r.damages).toEqual([332, 391, 553, 4605, 24391])

    expect(r.total).toBe(30272)
  })

  it('용광로 심장은 발사 전 온도(heatBefore) 10 이상부터 켜진다', () => {
    const r = shootMag(BUILD, MAG_BY_ID['m7'], plan(), 8)
    // 2번 탄의 온도 상승분은 소이 Mk.V 의 +1.75 뿐 (용광로 +3.00 이 아직 안 붙는다)
    expect(r.heats[1] - r.heats[0]).toBeCloseTo(1.75, 6)
    // 3번 탄부터 +1.75 +3.00
    expect(r.heats[2] - r.heats[1]).toBeCloseTo(4.75, 6)
  })

  it('피의 계약은 발사 전 온도 15 초과부터 켜진다', () => {
    const r = shootMag(BUILD, MAG_BY_ID['m7'], plan(), 8)
    // 3번 탄은 heatBefore 11.50 이라 아직 +110 이 없다 (DOC 는 여기서 144 로 계산)
    expect(r.chips[2]).toBe(34)
    // 4번 탄은 heatBefore 16.25 → +110
    expect(r.chips[3]).toBe(128 + 110)
  })

  /**
   * 섹터 8 보스가 "완성 빌드로 아슬아슬하게 잡히는" 관계를 잠근다.
   * HP_GROWTH 를 튜닝하면 절대값은 변하므로 절대값이 아니라 **관계**를 검증한다.
   * 배회자 T1 은 6행동이므로 필요 탄창 수가 6 이하여야 클리어 가능하고,
   * 3 미만이면 최종 보스가 너무 싱겁다는 뜻이다.
   */
  it('완성 빌드가 섹터 8 보스를 6탄창 이내에 잡되 3탄창 미만은 아니다', () => {
    const per = shootMag(BUILD, MAG_BY_ID['m7'], plan(), 8).total
    const bossHp = baseHp(8, NODE_MUL.boss, false)
    const mags = bossHp / per
    expect(mags).toBeLessThanOrEqual(6)
    expect(mags).toBeGreaterThan(3)
  })

  it('영혼 표식은 이 검산에서 발동하지 않는다 (문서 표에도 +10 이 없다)', () => {
    const withMark = shootMag(BUILD, MAG_BY_ID['m7'], plan(), 8)
    const withoutMark = shootMag(
      BUILD.filter((id) => id !== 'op_soul_mark'),
      MAG_BY_ID['m7'],
      plan(),
      8,
    )
    expect(withMark.total).toBe(withoutMark.total)
  })
})

// ---------------------------------------------------------------------------
// §3 HP 곡선 — 표는 유효숫자 3자리 반올림본이므로 공식 기준으로 본다
// ---------------------------------------------------------------------------

describe('BALANCE.md §3 — HP 곡선', () => {
  /** 문서 §3 표 (소형 · T1 기준). 유효숫자 3자리로 반올림되어 있다. */
  const DOC_SMALL = [400, 860, 1850, 3980, 8560, 18400, 39500, 85000]

  it('공식 HP = HP_BASE × HP_GROWTH^(s−1) × nodeMul 이 상수와 정확히 일치한다', () => {
    // 문서 표를 하드코딩하지 않는다 — HP 곡선은 시뮬레이션으로 튜닝되는 값이므로
    // "표와 같은가"가 아니라 "공식대로 계산되는가"를 잠근다.
    for (let sector = 1; sector <= 8; sector += 1) {
      for (const mul of [NODE_MUL.small, NODE_MUL.big, NODE_MUL.boss]) {
        const expected = Math.round(HP_BASE * Math.pow(HP_GROWTH, sector - 1) * mul)
        expect(baseHp(sector, mul, false)).toBe(expected)
      }
    }
  })

  it('엔드리스 구간(섹터 9+)만 ×2.60 으로 갈아탄다', () => {
    // 반올림을 한 번만 하도록 공식과 직접 대조한다 (중간 반올림을 끼우면 1 이 어긋난다).
    const expected = Math.round(HP_BASE * Math.pow(HP_GROWTH, 7) * HP_ENDLESS_GROWTH * NODE_MUL.small)
    expect(baseHp(9, NODE_MUL.small, true)).toBe(expected)
    // 엔드리스를 끄면 2.15 곡선이 그대로 이어진다
    expect(baseHp(9, NODE_MUL.small, false)).toBe(
      Math.round(HP_BASE * Math.pow(HP_GROWTH, 8) * NODE_MUL.small),
    )
  })
})

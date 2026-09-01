// 파이프라인 계약 회귀 테스트 — 탄 스탯표 · STEP 순서 · 축성 예약 · 넉백 · 미리보기 순수성.
// 부착물 56종과 적 패시브 10종이 "장착만 해도" 크래시 없이 도는지도 여기서 훑는다.
// 문서 수치 검산(BALANCE.md §7)은 balance.test.ts 가 담당한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  Ammo,
  AmmoType,
  Attachment,
  EnemyInstance,
  EnemyPassive,
  FireEvent,
  Grade,
  Loadout,
  Magazine,
} from '../types'
import { ammoStats } from '../ammoStats'
import { makeRng } from '../rng'
import { drawToTray, eject, fire, previewDamage, startCombat } from '../combat'
import { ATTACHMENTS } from '../data/attachments'
import { ARCH_BY_ID, PASSIVES } from '../data/enemies'
import { MAGAZINES, MAG_BY_ID } from '../data/magazines'
import { makeStartingBag } from '../data/startingBag'

// ---------------------------------------------------------------------------
// 테스트 전용 조립 헬퍼 (프로덕션 코드가 아니라 이 파일 안에서만 쓴다)
// ---------------------------------------------------------------------------

let uid = 0
/** 테스트용 탄 1발. uid 는 런 uid 와 겹치지 않게 't' 접두를 쓴다. */
function A(type: AmmoType, grade: Grade): Ammo {
  uid += 1
  return { uid: 't' + uid, type, grade }
}

function dummyEnemy(hp: number, passive: EnemyPassive | null = null): EnemyInstance {
  return {
    archetype: ARCH_BY_ID.shambler,
    passive,
    maxHp: hp,
    hp,
    speed: 5,
    startDist: 30,
    label: '표적',
    bodyCount: 1,
  }
}

function emptyLoadout(bag: Ammo[], magazine: Magazine = MAG_BY_ID['m1']): Loadout {
  return {
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
}

/** 부착물을 제 부위에 꽂는다. 레일 부착물이면 레일 칸을 하나 연다. */
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

function loadoutWith(ids: readonly Attachment[], bag: Ammo[], magazine?: Magazine): Loadout {
  const l = emptyLoadout(bag, magazine)
  for (const a of ids) mount(l, a)
  return l
}

/** 부착물 없이 plan 그대로 1탄창 발사하고 shot 이벤트만 돌려준다 */
function shootPlain(plan: Ammo[]): { shots: Extract<FireEvent, { t: 'shot' }>[]; total: number } {
  const l = emptyLoadout(plan.slice())
  const s = startCombat(l, dummyEnemy(1e12), makeRng(1))
  const events = fire(s, plan)
  const shots = events.filter((e): e is Extract<FireEvent, { t: 'shot' }> => e.t === 'shot')
  return { shots, total: s.magDamage }
}

// ---------------------------------------------------------------------------
// 1. 탄 스탯 원표 (BALANCE.md §1 "완성 스탯표")
// ---------------------------------------------------------------------------

describe('ammoStats — BALANCE.md §1 완성 스탯표', () => {
  /** [탄종, 등급, dmg, heat, knockback, nextDmgBonus] — 문서 표를 그대로 옮긴 20개 조합 */
  const TABLE: ReadonlyArray<readonly [AmmoType, Grade, number, number, number, number]> = [
    ['AP', 1, 17, 0.1, 0, 0],
    ['AP', 2, 34, 0.1, 0, 0],
    ['AP', 3, 58, 0.1, 0, 0],
    ['AP', 4, 88, 0.1, 0, 0],
    ['AP', 5, 128, 0.1, 0, 0],
    ['INC', 1, 5, 0.75, 0, 0],
    ['INC', 2, 9, 1.0, 0, 0],
    ['INC', 3, 15, 1.25, 0, 0],
    ['INC', 4, 23, 1.5, 0, 0],
    ['INC', 5, 34, 1.75, 0, 0],
    ['HE', 1, 10, 0.3, 0.5, 0],
    ['HE', 2, 20, 0.3, 1.0, 0],
    ['HE', 3, 34, 0.3, 1.5, 0],
    ['HE', 4, 52, 0.3, 2.0, 0],
    ['HE', 5, 75, 0.3, 2.5, 0],
    ['SANC', 1, 7, 0.4, 0, 20],
    ['SANC', 2, 14, 0.4, 0, 40],
    ['SANC', 3, 24, 0.4, 0, 60],
    ['SANC', 4, 36, 0.4, 0, 80],
    ['SANC', 5, 53, 0.4, 0, 100],
  ]

  for (const [type, grade, dmg, heat, knockback, nextDmgBonus] of TABLE) {
    it(`${type} Mk.${grade} = ${dmg} dmg / +${heat} heat`, () => {
      const st = ammoStats(A(type, grade))
      expect(st.dmg).toBe(dmg)
      expect(st.heat).toBeCloseTo(heat, 10)
      expect(st.knockback).toBeCloseTo(knockback, 10)
      expect(st.nextDmgBonus).toBe(nextDmgBonus)
    })
  }

  it('20개 조합이 전부 표에 있다 (탄종 4 × 등급 5)', () => {
    expect(TABLE.length).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// 2. STEP 순서 — 자신이 올린 온도는 자신에게 적용된다 (GDD §4.1)
// ---------------------------------------------------------------------------

describe('STEP5 — 자신이 올린 온도가 자신에게 적용된다', () => {
  it('소이 Mk.I 한 발: round(5 × (1.00+0.75)) = 9', () => {
    const { shots } = shootPlain([A('INC', 1)])
    expect(shots.length).toBe(1)
    expect(shots[0].heatBefore).toBeCloseTo(1.0, 10)
    expect(shots[0].heatAfter).toBeCloseTo(1.75, 10)
    // 자기 온도가 자기에게 적용되지 않았다면 5 × 1.00 = 5 가 나왔을 것이다.
    expect(shots[0].damage).toBe(9)
  })

  it('철갑 Mk.II 한 발: round(34 × 1.10) = 37', () => {
    const { shots } = shootPlain([A('AP', 2)])
    expect(shots[0].damage).toBe(37)
  })

  it('앞 발의 heatAfter 가 다음 발의 heatBefore 가 된다 (온도 누적)', () => {
    const { shots } = shootPlain([A('INC', 2), A('INC', 2), A('AP', 1)])
    expect(shots[0].heatAfter).toBeCloseTo(shots[1].heatBefore, 10)
    expect(shots[1].heatAfter).toBeCloseTo(shots[2].heatBefore, 10)
    expect(shots[2].heatBefore).toBeCloseTo(3.0, 10)
  })
})

// ---------------------------------------------------------------------------
// 3. 축성탄 — 다음 탄에만 적용되고 자기 자신에겐 적용되지 않는다
// ---------------------------------------------------------------------------

describe('축성탄 nextDmgBonus', () => {
  it('자기 자신은 보너스를 먹지 않는다', () => {
    const { shots } = shootPlain([A('SANC', 3), A('AP', 1)])
    // 축성 Mk.III 는 24 dmg. 자기 보너스(+60)를 먹었다면 84 였을 것이다.
    expect(shots[0].dmg).toBe(24)
    expect(shots[0].damage).toBe(Math.round(24 * 1.4))
  })

  it('바로 다음 탄이 +20×등급 을 받는다', () => {
    const { shots } = shootPlain([A('SANC', 3), A('AP', 1)])
    expect(shots[1].dmg).toBe(17 + 60)
    expect(shots[1].damage).toBe(Math.round(77 * 1.5))
  })

  it('그 다음 탄까지 이어지지는 않는다 (1발 한정)', () => {
    const { shots } = shootPlain([A('SANC', 1), A('AP', 1), A('AP', 1)])
    expect(shots[1].dmg).toBe(17 + 20)
    expect(shots[2].dmg).toBe(17)
  })

  it('축성탄이 연달아 오면 각자 다음 탄에만 예약된다', () => {
    const { shots } = shootPlain([A('SANC', 2), A('SANC', 2), A('AP', 1)])
    expect(shots[0].dmg).toBe(14)
    expect(shots[1].dmg).toBe(14 + 40)
    expect(shots[2].dmg).toBe(17 + 40)
  })
})

// ---------------------------------------------------------------------------
// 4. 고폭탄 넉백 — 거리를 되사온다
// ---------------------------------------------------------------------------

describe('HE 넉백', () => {
  it('발사 직후 거리가 +0.5×등급 만큼 늘어난다', () => {
    const plan = [A('HE', 3)]
    const l = emptyLoadout(plan.slice())
    const s = startCombat(l, dummyEnemy(1e12), makeRng(1))
    const start = s.distance
    const events = fire(s, plan)

    const kb = events.filter((e): e is Extract<FireEvent, { t: 'knockback' }> => e.t === 'knockback')
    expect(kb.length).toBe(1)
    expect(kb[0].meters).toBeCloseTo(1.5, 10)
    expect(kb[0].distanceAfter).toBeCloseTo(start + 1.5, 10)
    // 넉백 뒤 사격 비용(=접근 속도 5)이 빠진다
    expect(s.distance).toBeCloseTo(start + 1.5 - s.fireCost, 10)
  })

  it('철갑탄은 넉백을 만들지 않는다', () => {
    const plan = [A('AP', 5)]
    const l = emptyLoadout(plan.slice())
    const s = startCombat(l, dummyEnemy(1e12), makeRng(1))
    const events = fire(s, plan)
    expect(events.some((e) => e.t === 'knockback')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 5. previewDamage 순수성 — 원본과 rng 를 전혀 건드리지 않는다
// ---------------------------------------------------------------------------

describe('previewDamage 는 원본을 변경하지 않는다', () => {
  /** 함수는 빠지지만 숫자/배열/플래그는 전부 담기는 비교용 스냅샷 */
  function snapshot(s: ReturnType<typeof startCombat>): string {
    return JSON.stringify({
      hp: s.enemy.hp,
      distance: s.distance,
      bag: s.bag,
      tray: s.tray,
      spent: s.spent,
      reserve: s.reserve,
      traySize: s.traySize,
      cap: s.cap,
      heat: s.heat,
      heatStartBase: s.heatStartBase,
      peakHeat: s.peakHeat,
      magsFired: s.magsFired,
      ejectsUsed: s.ejectsUsed,
      shotsFired: s.shotsFired,
      totalDamage: s.totalDamage,
      magPlan: s.magPlan,
      magFired: s.magFired,
      magDamage: s.magDamage,
      abortMag: s.abortMag,
      pendingNextDmg: s.pendingNextDmg,
      heatDoublePending: s.heatDoublePending,
      vars: s.vars,
      flags: s.flags,
      outcome: s.outcome,
      dryRun: s.dryRun,
      attachmentCount: s.attachments.length,
      loadoutBag: s.loadout.bag,
      brass: s.loadout.brass,
      rails: s.loadout.rails.map((r) => (r === null ? null : r.id)),
    })
  }

  it('상태 스냅샷과 rng 상태가 호출 전후로 동일하다', () => {
    // 런 자원(탄피·가방)을 건드리는 부착물을 일부러 섞는다 — dryRun 가드까지 함께 본다.
    const wanted = ['st_charm_pouch', 'op_prescient_lens', 'rl_gambler_litany', 'hg_martyr_forge']
    const picks = ATTACHMENTS.filter((a) => wanted.indexOf(a.id) >= 0)
    const l = loadoutWith(picks, makeStartingBag())
    const s = startCombat(l, dummyEnemy(1e9), makeRng(4242))

    const before = snapshot(s)
    const rngBefore = s.rng.state()

    const plan = s.tray.slice(0, s.cap)
    const first = previewDamage(s, plan)
    const second = previewDamage(s, plan)

    expect(snapshot(s)).toBe(before)
    expect(s.rng.state()).toBe(rngBefore)
    // 원본이 그대로이므로 두 번 호출해도 같은 값이 나온다 (결정론).
    expect(second.expected).toBe(first.expected)
    expect(Number.isFinite(first.expected)).toBe(true)
  })

  it('미소모 탄창(M3)에서는 approximate=true 로 알린다', () => {
    const l = emptyLoadout(makeStartingBag(), MAG_BY_ID['m3'])
    const s = startCombat(l, dummyEnemy(1e9), makeRng(9))
    const before = snapshot(s)
    const rngBefore = s.rng.state()

    const res = previewDamage(s, s.tray.slice(0, s.cap))

    expect(res.approximate).toBe(true)
    expect(snapshot(s)).toBe(before)
    expect(s.rng.state()).toBe(rngBefore)
  })

  it('예측값이 실제 발사 결과와 같다 (무작위 요소가 없을 때)', () => {
    const picks = ATTACHMENTS.filter(
      (a) => a.id === 'br_heavy_barrel' || a.id === 'hg_incendiary_catalyst',
    )
    const l = loadoutWith(picks, makeStartingBag())
    const s = startCombat(l, dummyEnemy(1e9), makeRng(77))
    const plan = s.tray.slice(0, s.cap)

    const pre = previewDamage(s, plan)
    expect(pre.approximate).toBe(false)
    fire(s, plan)
    expect(s.magDamage).toBe(pre.expected)
  })
})

// ---------------------------------------------------------------------------
// 6~8. 스모크 — 장착만 해도 도는가
// ---------------------------------------------------------------------------

/** safeCall 이 훅 예외를 console.warn 으로 삼키므로, 경고 자체를 실패로 취급한다. */
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

/**
 * 1탄창 발사 + 배출 + 1탄창 더. 누적형 훅(onMagEnd/onCombatEnd)까지 한 번씩 밟는다.
 * 적 HP 를 크게 잡아 중간에 전투가 끝나지 않게 한다.
 */
function smokeCombat(l: Loadout, passive: EnemyPassive | null, seed: number): void {
  const s = startCombat(l, dummyEnemy(1e9, passive), makeRng(seed))

  for (let mag = 0; mag < 2; mag += 1) {
    const hand = s.tray.concat(s.reserve)
    fire(s, hand.slice(0, s.cap))
    expect(Number.isFinite(s.totalDamage)).toBe(true)
    expect(Number.isFinite(s.heat)).toBe(true)
    expect(Number.isFinite(s.distance)).toBe(true)
    expect(s.totalDamage).toBeGreaterThanOrEqual(0)

    if (s.outcome !== 'ongoing') break
    const uids = s.tray.slice(0, 2).map((a) => a.uid)
    eject(s, uids)
    drawToTray(s)
    if (s.outcome !== 'ongoing') break
  }
}

describe('부착물 56종 스모크', () => {
  it('카탈로그가 56종이다', () => {
    expect(ATTACHMENTS.length).toBe(56)
  })

  for (const a of ATTACHMENTS) {
    it(`${a.id} (${a.name}) 장착 후 2탄창이 크래시 없이 돈다`, () => {
      const l = loadoutWith([a], makeStartingBag())
      smokeCombat(l, null, 1234)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  }
})

describe('적 패시브 10종 스모크', () => {
  it('패시브가 10종이다', () => {
    expect(PASSIVES.length).toBe(10)
  })

  for (const p of PASSIVES) {
    it(`${p.id} (${p.name}) 전투가 크래시 없이 돈다`, () => {
      const l = emptyLoadout(makeStartingBag())
      smokeCombat(l, p, 555)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  }
})

describe('탄창 10종 스모크', () => {
  it('탄창이 10종이다', () => {
    expect(MAGAZINES.length).toBe(10)
  })

  for (const m of MAGAZINES) {
    it(`${m.id} (${m.name}) 전투가 크래시 없이 돈다`, () => {
      const l = emptyLoadout(makeStartingBag(), m)
      smokeCombat(l, null, 31337)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  }
})

describe('부착물 × 적 패시브 교차 스모크 (레어도 전 구간 표본)', () => {
  // 전조합 560개는 과하다. 유물/영웅을 포함한 표본 8종 × 패시브 10종만 돈다.
  const sample = ATTACHMENTS.filter(
    (a) => a.rarity === 'relic' || a.id === 'hg_furnace_heart' || a.id === 'rl_unstable_core',
  )

  for (const a of sample) {
    for (const p of PASSIVES) {
      it(`${a.id} × ${p.id}`, () => {
        const l = loadoutWith([a], makeStartingBag())
        smokeCombat(l, p, 8080)
        expect(warnSpy).not.toHaveBeenCalled()
      })
    }
  }
})

// ============================================================================
// 코어 규칙 테스트 (v2)
//   파이프라인의 순서·곱셈 위치·특수탄 효과·콘텐츠 무결성을 잠근다.
// ============================================================================
import { describe, expect, it } from 'vitest'
import type { Attachment, EnemyInstance, Loadout, Round } from '../types'
import { BASIC_DMG, BASIC_HEAT, HP_BASE, HP_GROWTH, NODE_MUL, RAIL_ACCEPTS } from '../types'
import { makeRng } from '../rng'
import { ATTACHMENTS, ATT_BY_ID, STARTER_MAGAZINE } from '../data/attachments'
import { SPECIALS, SPECIAL_BY_ID } from '../data/specials'
import { ARCHETYPES, PASSIVES, baseHp, makeEnemy } from '../data/enemies'
import { basicRound, fire, makeRound, previewDamage, startCombat } from '../combat'
import { computeCap } from '../pipeline'

function loadout(ids: string[] = [], specials: Record<string, number> = {}): Loadout {
  const l: Loadout = {
    barrel: null,
    handguard: null,
    optic: null,
    stock: null,
    magazine: STARTER_MAGAZINE,
    rails: [null, null],
    railSlots: 2,
    stash: [],
    specials,
    brass: 0,
  }
  for (const id of ids) {
    const a = ATT_BY_ID[id]
    if (a === undefined) continue
    if (a.slot === RAIL_ACCEPTS && l.optic !== null) {
      const at = l.rails.findIndex((r) => r === null)
      if (at >= 0) l.rails[at] = a
    } else {
      ;(l as unknown as Record<string, Attachment>)[a.slot] = a
    }
  }
  return l
}

function dummy(hp = 1e9): EnemyInstance {
  return {
    archetype: ARCHETYPES[0],
    passive: null,
    maxHp: hp,
    hp,
    speed: 5,
    startDist: 30,
    label: '표적',
    bodyCount: 1,
    vuln: 0,
  }
}

function shoot(l: Loadout, plan: Round[]) {
  const s = startCombat(l, dummy(), makeRng(1))
  const events = fire(s, plan)
  const shots = events.filter((e) => e.t === 'shot') as Array<Extract<typeof events[number], { t: 'shot' }>>
  return { s, events, shots, total: shots.reduce((a, e) => a + e.damage, 0) }
}

// ---------------------------------------------------------------------------
describe('기본탄과 곱셈', () => {
  it('기본탄 한 발: DMG × 시작온도(1.00)', () => {
    const { shots } = shoot(loadout(), [basicRound()])
    expect(shots).toHaveLength(1)
    expect(shots[0].dmg).toBe(BASIC_DMG)
    expect(shots[0].heatAfter).toBeCloseTo(1 + BASIC_HEAT, 6)
    expect(shots[0].damage).toBe(Math.round(BASIC_DMG * (1 + BASIC_HEAT)))
  })

  it('자신이 올린 온도는 자신에게도 적용된다', () => {
    const { shots } = shoot(loadout(), [basicRound()])
    expect(shots[0].heatBefore).toBe(1)
    expect(shots[0].heatAfter).toBeGreaterThan(shots[0].heatBefore)
    expect(shots[0].damage).toBe(Math.round(shots[0].dmg * shots[0].heatAfter))
  })

  it('온도는 탄창 안에서 누적된다', () => {
    const { shots } = shoot(loadout(), [basicRound(), basicRound(), basicRound()])
    expect(shots[1].heatAfter).toBeGreaterThan(shots[0].heatAfter)
    expect(shots[2].heatAfter).toBeGreaterThan(shots[1].heatAfter)
  })
})

describe('순서가 데미지를 바꾼다 — 이 게임의 존재 이유', () => {
  it('예열(소이탄) 먼저가 나중보다 강하다', () => {
    const l = loadout([], { sp_incendiary: 1, sp_ap: 1 })
    const pre = shoot(l, [makeRound('sp_incendiary'), makeRound('sp_ap')]).total
    const post = shoot(l, [makeRound('sp_ap'), makeRound('sp_incendiary')]).total
    expect(pre).toBeGreaterThan(post)
  })
})

describe('특수탄', () => {
  it('충격탄은 거리를 늘린다 (넉백)', () => {
    const l = loadout([], { sp_shock: 1 })
    const s = startCombat(l, dummy(), makeRng(2))
    const before = s.distance
    fire(s, [makeRound('sp_shock')])
    // 넉백 +4m 후 사격 비용만큼 전진 → 순변화는 4 - fireCost
    expect(s.distance).toBe(before + 4 - s.fireCost)
  })

  it('점착탄은 이후 탄의 데미지를 올린다', () => {
    const l = loadout([], { sp_adhesive: 1 })
    const { shots } = shoot(l, [makeRound('sp_adhesive'), basicRound()])
    expect(shots[1].dmg).toBe(BASIC_DMG + 30)
  })

  it('표식탄은 적을 취약하게 만든다', () => {
    const l = loadout([], { sp_marker: 1 })
    const s = startCombat(l, dummy(), makeRng(3))
    fire(s, [makeRound('sp_marker'), basicRound()])
    expect(s.enemy.vuln).toBeCloseTo(0.25, 6)
  })

  it('특수탄은 소모되고 기본탄은 무한하다', () => {
    const l = loadout([], { sp_ap: 2 })
    const s = startCombat(l, dummy(), makeRng(4))
    fire(s, [makeRound('sp_ap'), basicRound(), basicRound()])
    expect(s.specials['sp_ap']).toBe(1)
  })

  it('보유량을 넘는 특수탄은 계획에서 걸러진다', () => {
    const l = loadout([], { sp_ap: 1 })
    const { shots } = shoot(l, [makeRound('sp_ap'), makeRound('sp_ap'), makeRound('sp_ap')])
    expect(shots).toHaveLength(1)
  })
})

describe('미리보기는 상태를 오염시키지 않는다', () => {
  it('previewDamage 후 원본 state 와 rng 가 그대로다', () => {
    const l = loadout([], { sp_ap: 2 })
    const s = startCombat(l, dummy(), makeRng(9))
    const snap = {
      heat: s.heat,
      dist: s.distance,
      hp: s.enemy.hp,
      rng: s.rng.state(),
      sp: s.specials['sp_ap'],
      mags: s.magsFired,
    }
    previewDamage(s, [makeRound('sp_ap'), basicRound()])
    expect(s.heat).toBe(snap.heat)
    expect(s.distance).toBe(snap.dist)
    expect(s.enemy.hp).toBe(snap.hp)
    expect(s.rng.state()).toBe(snap.rng)
    expect(s.specials['sp_ap']).toBe(snap.sp)
    expect(s.magsFired).toBe(snap.mags)
  })

  it('예측값과 실제 피해가 일치한다 (확률 요소 없는 빌드)', () => {
    const l = loadout(['br_long', 'hg_fin'], { sp_incendiary: 1 })
    const plan = [makeRound('sp_incendiary'), basicRound(), basicRound()]
    const s = startCombat(l, dummy(), makeRng(11))
    const pred = previewDamage(s, plan).expected
    const actual = fire(s, plan)
      .filter((e) => e.t === 'shot')
      .reduce((a, e) => a + (e as { damage: number }).damage, 0)
    expect(actual).toBe(pred)
  })
})

describe('콘텐츠 무결성', () => {
  it('부착물 id 가 중복되지 않는다', () => {
    const ids = new Set(ATTACHMENTS.map((a) => a.id))
    expect(ids.size).toBe(ATTACHMENTS.length)
  })

  it('모든 부위에 부착물이 존재한다', () => {
    for (const slot of ['barrel', 'handguard', 'optic', 'stock', 'magazine']) {
      expect(ATTACHMENTS.filter((a) => a.slot === slot).length).toBeGreaterThan(0)
    }
  })

  it("보조 레일은 자리일 뿐이므로 slot:'rail' 부착물은 존재하지 않는다", () => {
    expect(ATTACHMENTS.filter((a) => a.slot === 'rail')).toHaveLength(0)
  })

  it('보조 레일에는 광학만 들어간다', () => {
    expect(RAIL_ACCEPTS).toBe('optic')
  })

  it('탄창 부위 부착물은 전부 mag 규칙을 갖는다', () => {
    for (const a of ATTACHMENTS.filter((x) => x.slot === 'magazine')) {
      expect(a.mag).toBeDefined()
      expect(a.mag?.cap).toBeGreaterThan(0)
    }
  })

  it('BALANCE R6 — 시작 온도를 올리는 것은 탄창 부위와 유물뿐이다', () => {
    for (const a of ATTACHMENTS) {
      if (a.mods?.startHeat === undefined) continue
      expect(a.slot === 'magazine' || a.rarity === 'relic').toBe(true)
    }
  })

  it('부착물 45종 각각이 장착만 해도 크래시 없이 사격된다', () => {
    for (const a of ATTACHMENTS) {
      const l = loadout([a.id], { sp_ap: 2, sp_incendiary: 2 })
      const s = startCombat(l, dummy(), makeRng(17))
      const plan: Round[] = []
      for (let i = 0; i < computeCap(l); i += 1) plan.push(i === 0 ? makeRound('sp_incendiary') : basicRound())
      expect(() => fire(s, plan)).not.toThrow()
    }
  })

  it('특수탄 12종 각각이 크래시 없이 발사된다', () => {
    for (const def of SPECIALS) {
      const l = loadout([], { [def.id]: 2 })
      const s = startCombat(l, dummy(), makeRng(23))
      expect(() => fire(s, [makeRound(def.id), basicRound()])).not.toThrow()
    }
  })

  it('적 패시브 10종 각각이 크래시 없이 동작한다', () => {
    for (const p of PASSIVES) {
      const e = makeEnemy({
        archetypeId: 'shambler',
        passiveId: p.id,
        sector: 3,
        nodeMul: 1,
        threat: 2,
      })
      const l = loadout(['rl_pact'], { sp_ap: 2 })
      const s = startCombat(l, e, makeRng(29))
      expect(() => fire(s, [makeRound('sp_ap'), basicRound(), basicRound()])).not.toThrow()
    }
  })

  it('특수탄 id 와 색이 모두 정의되어 있다', () => {
    for (const d of SPECIALS) {
      expect(SPECIAL_BY_ID[d.id]).toBe(d)
      expect(d.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('HP 곡선', () => {
  it('공식대로 계산된다', () => {
    for (let sector = 1; sector <= 8; sector += 1) {
      for (const mul of [NODE_MUL.small, NODE_MUL.big, NODE_MUL.boss]) {
        expect(baseHp(sector, mul, false)).toBe(
          Math.round(HP_BASE * Math.pow(HP_GROWTH, sector - 1) * mul),
        )
      }
    }
  })
})

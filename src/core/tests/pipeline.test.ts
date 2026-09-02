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
import { basicRound, fire, makeRound, previewDamage, settleSpecials, startCombat } from '../combat'
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
    // 넉백 +3m 후 사격 비용만큼 전진 → 순변화는 3 - fireCost
    expect(s.distance).toBe(before + 3 - s.fireCost)
  })

  // 아래 두 상수는 specials.ts 의 값과 **의도적으로 묶여 있다.**
  // 밸런스 조정으로 숫자가 바뀌면 여기서 터져야 한다 — 조용히 지나가면
  // '기능은 살아 있는데 값이 사라진' 회귀를 못 잡는다.
  it('점착탄은 이후 탄의 데미지를 올린다 (+10)', () => {
    const l = loadout([], { sp_adhesive: 1 })
    const { shots } = shoot(l, [makeRound('sp_adhesive'), basicRound()])
    expect(shots[1].dmg).toBe(BASIC_DMG + 10)
  })

  it('표식탄은 적을 취약하게 만든다 (+42%)', () => {
    const l = loadout([], { sp_marker: 1 })
    const s = startCombat(l, dummy(), makeRng(3))
    fire(s, [makeRound('sp_marker'), basicRound()])
    expect(s.enemy.vuln).toBeCloseTo(0.42, 6)
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

describe('구조 불변식 — 실측으로 잡아낸 결함', () => {
  it('사격은 어떤 조합에서도 적을 회복시키지 않는다', () => {
    // 도박꾼의 성구(−40)가 기본탄 바닥값 12 를 넘겨 음수 피해를 냈고,
    // `enemy.hp -= damage` 가 그대로 회복으로 작동했다 (실측 2,000발 중 1,022발).
    let negatives = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const s = startCombat(loadout(['rl_gambler']), dummy(), makeRng(seed))
      const ev = fire(s, [basicRound(), basicRound(), basicRound(), basicRound(), basicRound()])
      for (const x of ev) if (x.t === 'shot' && x.damage < 0) negatives += 1
    }
    expect(negatives).toBe(0)
  })

  it('볼터의 원형은 탄창을 넘겨도 누적되지 않는다', () => {
    // onAfterShot 이 자기가 올려준 기본탄 값을 다시 최고값으로 삼아
    // 탄창마다 계단식으로 자랐다 (실측 42 → 462).
    const s = startCombat(loadout(['br_archetype']), dummy(), makeRng(7))
    const peak: number[] = []
    for (let m = 0; m < 4; m += 1) {
      const ev = fire(s, [basicRound(), basicRound(), basicRound(), basicRound(), basicRound()])
      peak.push(Math.max(...ev.filter((x) => x.t === 'shot').map((x) => (x as { dmg: number }).dmg)))
    }
    expect(Math.max(...peak)).toBeLessThanOrEqual(peak[0] as number)
  })

  it('미소모 재발사는 탄당 2회로 제한된다', () => {
    // 탐식의 성궤(미소모 80%)가 용량 2 로 한 탄창에 평균 10.0발(최대 34발)을 쐈다.
    let worst = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const s = startCombat(
        loadout(['mg_greed'], { sp_thermite: 5, sp_ap: 5 }),
        dummy(),
        makeRng(seed),
      )
      const ev = fire(s, [makeRound('sp_thermite'), makeRound('sp_ap')])
      worst = Math.max(worst, ev.filter((x) => x.t === 'shot').length)
    }
    // 탄 2발 × (원발사 1 + 재발사 최대 2) = 6
    expect(worst).toBeLessThanOrEqual(6)
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

// ---------------------------------------------------------------------------
// 난이도 상향 — 신규 아키타입·패시브
// ---------------------------------------------------------------------------
describe('신규 적', () => {
  it('추적자·거상이 카탈로그와 ID 맵에 있고 HP 배수가 의도대로다', () => {
    const ids = ARCHETYPES.map((a) => a.id)
    expect(ids).toContain('stalker')
    expect(ids).toContain('colossus')
    const st = makeEnemy({ archetypeId: 'stalker', passiveId: null, sector: 1, nodeMul: 1, threat: 1 })
    const co = makeEnemy({ archetypeId: 'colossus', passiveId: null, sector: 1, nodeMul: 1, threat: 1 })
    const base = makeEnemy({ archetypeId: 'shambler', passiveId: null, sector: 1, nodeMul: 1, threat: 1 })
    expect(st.maxHp / base.maxHp).toBeCloseTo(1.15, 1)
    expect(co.maxHp / base.maxHp).toBeCloseTo(2.6, 1)
    expect(st.speed).toBeGreaterThan(base.speed)
  })

  it('굶주림: 사격을 마칠 때마다 속도가 오르고 사격 비용이 다시 계산된다', () => {
    const e = { ...dummy(), passive: PASSIVES.find((p) => p.id === 'hunger') ?? null }
    const s = startCombat(loadout(), e, makeRng(1))
    const cost0 = s.fireCost
    const speed0 = s.enemy.speed
    fire(s, [basicRound(), basicRound()])
    expect(s.enemy.speed).toBe(speed0 + 2)
    expect(s.fireCost).toBeGreaterThan(cost0)
  })

  it('심연: 사격 사이에 온도가 이월되지 않는다', () => {
    const e = { ...dummy(), passive: PASSIVES.find((p) => p.id === 'abyss') ?? null }
    const s = startCombat(loadout(), e, makeRng(1))
    const events = fire(s, [basicRound(), basicRound(), basicRound()])
    const end = events.find((x) => x.t === 'magEnd')
    expect(end !== undefined && end.t === 'magEnd' ? end.heatCarried : -1).toBe(0)
    // 기본 이월(50%)이면 0 이 아니어야 한다 — 대조군
    const s2 = startCombat(loadout(), dummy(), makeRng(1))
    const ev2 = fire(s2, [basicRound(), basicRound(), basicRound()])
    const end2 = ev2.find((x) => x.t === 'magEnd')
    expect(end2 !== undefined && end2.t === 'magEnd' ? end2.heatCarried : 0).toBeGreaterThan(0)
  })

  it('흡열: 온도 15 이상에서 쏜 발마다 2% 회복하되 사격당 12% 를 넘지 않는다', () => {
    const e = { ...dummy(10000), passive: PASSIVES.find((p) => p.id === 'siphon') ?? null }
    const s = startCombat(loadout(['mg_drum']), e, makeRng(1))
    s.heatStartBase = 30 // 뜨거운 상태로 시작 — 모든 발이 조건 성립
    const plan: Round[] = []
    for (let i = 0; i < s.cap; i += 1) plan.push(basicRound())
    const hpBefore = s.enemy.hp
    const events = fire(s, plan)
    let dealt = 0
    for (const ev of events) if (ev.t === 'shot') dealt += ev.damage
    const healed = s.enemy.hp - (hpBefore - dealt)
    expect(healed).toBeGreaterThan(0)
    expect(healed).toBeLessThanOrEqual(Math.round(10000 * 0.02) * 6)
  })
})

// ---------------------------------------------------------------------------
// 같은 탄 반복 감쇠 — 소이·소이·철갑 도배를 막는 규칙
// ---------------------------------------------------------------------------
describe('반복 감쇠', () => {
  it('같은 특수탄을 겹치면 2번째·3번째의 자기 값이 줄어든다', () => {
    const l = loadout([], { sp_ap: 3 })
    const r = shoot(l, [makeRound('sp_ap'), makeRound('sp_ap'), makeRound('sp_ap')])
    expect(r.shots).toHaveLength(3)
    // 온도가 발마다 오르므로 절대값은 비교할 수 없다 — 같은 온도로 나눈 '칩' 을 본다
    const chips = r.shots.map((s) => s.dmg)
    expect(chips[1]! / chips[0]!).toBeLessThan(0.8)
    expect(chips[2]! / chips[0]!).toBeLessThan(0.6)
  })

  it('서로 다른 특수탄을 엮는 콤보는 감쇠하지 않는다', () => {
    const l = loadout([], { sp_ap: 1, sp_incendiary: 1 })
    const solo = shoot(loadout([], { sp_ap: 1 }), [makeRound('sp_ap')])
    const combo = shoot(l, [makeRound('sp_incendiary'), makeRound('sp_ap')])
    // 2번째 발이지만 탄종이 다르므로 자기 칩은 온전하다
    expect(combo.shots[1]!.dmg).toBeGreaterThanOrEqual(solo.shots[0]!.dmg)
  })

  it('기본탄은 감쇠하지 않는다 (탄창 대부분이 기본탄이다)', () => {
    const r = shoot(loadout(), [basicRound(), basicRound(), basicRound()])
    expect(r.shots[0]!.dmg).toBe(r.shots[1]!.dmg)
    expect(r.shots[1]!.dmg).toBe(r.shots[2]!.dmg)
  })
})

// ---------------------------------------------------------------------------
// 전투 결과가 장비에 반영되는가 — 없으면 특수탄이 무한이 된다
// ---------------------------------------------------------------------------
describe('특수탄 정산', () => {
  it('전투에서 쓴 만큼 장비의 특수탄이 줄어든다', () => {
    const l = loadout([], { sp_ap: 3, sp_incendiary: 2 })
    const s = startCombat(l, dummy(), makeRng(1))
    fire(s, [makeRound('sp_ap'), makeRound('sp_incendiary'), basicRound()])
    // 전투 중에는 사본만 줄어든다 (장비는 아직 그대로)
    expect(l.specials['sp_ap']).toBe(3)
    settleSpecials(l, s)
    expect(l.specials['sp_ap']).toBe(2)
    expect(l.specials['sp_incendiary']).toBe(1)
  })

  it('미리보기는 특수탄을 소모하지 않는다', () => {
    const l = loadout([], { sp_ap: 2 })
    const s = startCombat(l, dummy(), makeRng(1))
    previewDamage(s, [makeRound('sp_ap'), makeRound('sp_ap')])
    settleSpecials(l, s)
    expect(l.specials['sp_ap']).toBe(2)
  })

  it('전투 중 보급(탄띠 걸이)은 정산에서 남는다', () => {
    const l = loadout(['st_bandolier'], { sp_ap: 1 })
    const s = startCombat(l, dummy(), makeRng(1))
    fire(s, [basicRound()])
    settleSpecials(l, s)
    let total = 0
    for (const v of Object.values(l.specials)) total += v
    expect(total).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// 유일탄 — 탄창 구성에 값이 걸리는 탄 (페이오프의 랭크를 올리는 장치)
// ---------------------------------------------------------------------------
describe('유일탄', () => {
  it('혼자 들어가면 크게 터지고, 다른 특수탄이 끼면 죽는다', () => {
    const solo = shoot(loadout([], { sp_solitary: 1 }), [makeRound('sp_solitary'), basicRound()])
    const withOther = shoot(
      loadout([], { sp_solitary: 1, sp_ap: 1 }),
      [makeRound('sp_solitary'), makeRound('sp_ap')],
    )
    expect(solo.shots[0]!.dmg).toBeGreaterThan(withOther.shots[0]!.dmg * 2)
  })
})

describe('심판탄', () => {
  it('겹칠수록 발당 가치가 떨어진다 (자기 증식하지 않는다)', () => {
    const l = loadout([], { sp_judgment: 2 })
    const s = startCombat(l, dummy(1e9), makeRng(5))
    const hp0 = s.enemy.hp
    fire(s, [basicRound(), basicRound(), makeRound('sp_judgment'), makeRound('sp_judgment')])
    const dealt = hp0 - s.enemy.hp
    // 두 번째가 첫 번째가 만든 추가 피해까지 다시 먹으면 총합이 폭발한다.
    // magDamage 에 되먹이지 않으므로 그런 일이 없어야 한다.
    expect(dealt).toBeLessThan(s.magDamage * 4)
  })
})

// ============================================================================
// 특수탄 (Special Rounds) — 소모품
//   기본탄이 "부착물이 곱해질 바닥"이라면, 특수탄은 "플레이어가 쓰는 순간을 고르는 카드"다.
//   수량이 유한하므로 **언제 쓰는가**가 결정이고, 탄창 안 어디에 넣는가가 두 번째 결정이다.
// ============================================================================
import type { FireCtx, SpecialDef } from '../types'

function proc(c: FireCtx): void {
  c.triggered.push(c.self)
}

/** 성탄(doubleNext)이 걸려 있으면 효과량을 2배로 */
function amp(c: FireCtx, v: number): number {
  return c.s.doubleNext ? v * 2 : v
}

export const SPECIALS: SpecialDef[] = [
  // --- 일반 -----------------------------------------------------------------
  {
    id: 'sp_incendiary',
    name: '소이탄',
    text: '온도 +5.0. 예열용',
    rarity: 'common',
    dmg: 6,
    heat: 5,
    price: 14,
    color: '#ff7a2a',
  },
  {
    id: 'sp_ap',
    name: '철갑탄',
    text: '데미지 +110',
    rarity: 'common',
    dmg: 110,
    heat: 0.2,
    price: 16,
    color: '#b9c0c7',
  },
  {
    id: 'sp_shock',
    name: '충격탄',
    text: '적을 4m 뒤로 밀어낸다',
    rarity: 'common',
    dmg: 20,
    heat: 0.4,
    price: 18,
    color: '#7fc7e8',
    hooks: {
      onAfterShot(c) {
        const m = amp(c, 4)
        c.s.distance += m
        proc(c)
      },
    },
  },

  // --- 희귀 -----------------------------------------------------------------
  {
    id: 'sp_adhesive',
    name: '점착탄',
    text: '이번 탄창의 남은 모든 탄 DMG +30',
    rarity: 'uncommon',
    dmg: 14,
    heat: 0.4,
    price: 30,
    color: '#a8d24a',
    hooks: {
      onAfterShot(c) {
        c.s.magDmgBonus += amp(c, 30)
        proc(c)
      },
    },
  },
  {
    id: 'sp_thermite',
    name: '테르밋탄',
    text: '온도 +12.0. 강력한 예열',
    rarity: 'uncommon',
    dmg: 8,
    heat: 12,
    price: 34,
    color: '#ffb03a',
  },
  {
    id: 'sp_marker',
    name: '표식탄',
    text: '이번 전투 동안 적이 받는 피해 +25%',
    rarity: 'uncommon',
    dmg: 16,
    heat: 0.4,
    price: 36,
    color: '#e05fa0',
    hooks: {
      onAfterShot(c) {
        c.s.enemy.vuln += amp(c, 0.25)
        proc(c)
      },
    },
  },
  {
    id: 'sp_chill',
    name: '냉각탄',
    text: '적 접근 속도 −2 (이번 전투)',
    rarity: 'uncommon',
    dmg: 18,
    heat: 0.3,
    price: 32,
    color: '#8fd8ff',
    hooks: {
      onAfterShot(c) {
        const e = c.s.enemy
        e.speed = Math.max(2, e.speed - amp(c, 2))
        c.s.fireCost = Math.max(1, e.speed)
        proc(c)
      },
    },
  },

  // --- 영웅 -----------------------------------------------------------------
  {
    id: 'sp_sanctified',
    name: '성탄',
    text: '다음 탄의 효과가 2배가 된다',
    rarity: 'rare',
    dmg: 10,
    heat: 0.6,
    price: 55,
    color: '#f2e6c4',
    hooks: {
      onAfterShot(c) {
        c.s.doubleNext = true
        proc(c)
      },
    },
  },
  {
    id: 'sp_cascade',
    name: '연쇄 점화탄',
    text: '이번 탄창의 남은 탄 온도 획득 2배',
    rarity: 'rare',
    dmg: 12,
    heat: 2,
    price: 60,
    color: '#ff5a2a',
    hooks: {
      onAfterShot(c) {
        c.s.heatDoublePending = true
        proc(c)
      },
    },
  },
  {
    id: 'sp_breach',
    name: '관통탄',
    text: '적 방어 패시브를 무시하고 DMG +150',
    rarity: 'rare',
    dmg: 150,
    heat: 0.2,
    price: 65,
    color: '#d0d6dd',
    hooks: {
      onFire(c) {
        c.s.flags['pierce'] = true
        proc(c)
      },
    },
  },

  // --- 유물 -----------------------------------------------------------------
  {
    id: 'sp_singularity',
    name: '특이점탄',
    text: '온도가 이번 탄창의 발사 수 ×6 만큼 오른다',
    rarity: 'relic',
    dmg: 20,
    heat: 0,
    price: 110,
    color: '#c88bff',
    hooks: {
      onFire(c) {
        c.heatGain += amp(c, c.s.magFired.length * 6)
        proc(c)
      },
    },
  },
  {
    id: 'sp_judgment',
    name: '심판탄',
    text: '지금까지 이번 탄창이 입힌 피해의 40%를 추가',
    rarity: 'relic',
    dmg: 30,
    heat: 0.5,
    price: 120,
    color: '#ffd76a',
    hooks: {
      onFire(c) {
        c.dmg += Math.round(amp(c, c.s.magDamage * 0.4))
        proc(c)
      },
    },
  },
]

export const SPECIAL_BY_ID: Record<string, SpecialDef> = Object.fromEntries(
  SPECIALS.map((s) => [s.id, s]),
)

export function specialsOfRarity(r: SpecialDef['rarity']): SpecialDef[] {
  return SPECIALS.filter((s) => s.rarity === r)
}

/** 시작 특수탄 — 적고 단순하게. 나머지는 보상/상점으로 얻는다. */
export function startingSpecials(): Record<string, number> {
  return { sp_incendiary: 3, sp_ap: 2 }
}

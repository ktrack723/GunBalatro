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
    price: 18,
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
    // 상한 없이 탄창마다 한 발이면 전투 길이가 무한히 늘어난다 (실측 비대체 9→141탄창).
    // 4m 는 그대로 두고 **전투당 누계 12m** 로 막는다 — 6m 로 올리면 유효 발수가
    // 3→2 로 줄어 '몇 발을 언제 쓰나' 라는 산수 결정의 해상도가 반토막 난다.
    text: '적을 4m 뒤로 밀어낸다 (전투당 누계 12m)',
    rarity: 'common',
    dmg: 20,
    heat: 0.4,
    price: 18,
    color: '#7fc7e8',
    hooks: {
      onAfterShot(c) {
        const used = c.s.vars['knockTotal'] ?? 0
        const room = 12 - used
        if (room <= 0) return
        const m = Math.min(room, amp(c, 4))
        c.s.distance += m
        c.s.vars['knockTotal'] = used + m
        proc(c)
      },
    },
  },

  // --- 희귀 -----------------------------------------------------------------
  {
    id: 'sp_adhesive',
    name: '점착탄',
    text: '이번 탄창의 남은 모든 탄 DMG +45',
    rarity: 'uncommon',
    dmg: 14,
    heat: 0.4,
    price: 30,
    color: '#a8d24a',
    hooks: {
      onAfterShot(c) {
        c.s.magDmgBonus += amp(c, 45)
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
    price: 48,
    color: '#ffb03a',
  },
  {
    id: 'sp_marker',
    name: '표식탄',
    text: '이번 전투 동안 적이 받는 피해 +35%',
    rarity: 'uncommon',
    dmg: 16,
    heat: 0.4,
    price: 36,
    color: '#e05fa0',
    hooks: {
      onAfterShot(c) {
        c.s.enemy.vuln += amp(c, 0.35)
        proc(c)
      },
    },
  },
  {
    id: 'sp_chill',
    name: '냉각탄',
    text: '적 접근 속도 −2 (이번 전투, 누계 −2 까지)',
    rarity: 'uncommon',
    dmg: 18,
    heat: 0.3,
    price: 32,
    color: '#8fd8ff',
    hooks: {
      // fireCost 를 여기서 덮어쓰면 부착물 보정(간이 거리계·완충기 등)이 통째로
      // 날아간다 (실측 −36.3%). 재계산은 파이프라인 STEP7 이 맡는다.
      // 누계 상한이 없으면 2발로 전투 길이가 2.5배가 된다 — 충격탄과 같은 처방.
      onAfterShot(c) {
        const used = c.s.vars['chillTotal'] ?? 0
        const room = 2 - used
        if (room <= 0) return
        const cut = Math.min(room, amp(c, 2))
        const e = c.s.enemy
        e.speed = Math.max(2, e.speed - cut)
        c.s.vars['chillTotal'] = used + cut
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
    price: 52,
    color: '#d0d6dd',
    hooks: {
      onFire(c) {
        c.s.flags['pierce'] = true
        proc(c)
      },
    },
  },

  // --- 저온 축 — 온도가 낮을수록 강하다 -------------------------------------
  //   온도 이월(기본 50%)이 있는 v2 에서, 이 탄들은 "굳이 식힌다"는 반대 선택을 만든다.
  {
    id: 'sp_cryo',
    name: '냉동탄',
    text: '발사 전 온도가 낮을수록 강하다 (DMG +(18−온도)×26)',
    rarity: 'uncommon',
    dmg: 18,
    heat: 0.15,
    price: 34,
    color: '#7fe3ff',
    hooks: {
      onFire(c) {
        const gap = 18 - c.heatBefore
        if (gap <= 0) return
        c.dmg += Math.round(amp(c, gap * 26))
        proc(c)
      },
    },
  },
  {
    id: 'sp_firststrike',
    name: '초탄',
    // 임계 3.5 는 이월 정상상태에서 첫 칸에서만 성립했다. 6.0 이면 전체 탄창의
    // 55% (첫 탄창)에서 성립하고 최선 칸이 1번이 아니라 2번이 되어 배치 결정이 생긴다.
    text: '발사 전 온도 6.0 이하면 DMG +240',
    rarity: 'rare',
    dmg: 40,
    heat: 0.1,
    price: 44,
    color: '#cfe6ff',
    hooks: {
      onFire(c) {
        if (c.heatBefore > 6.0) return
        c.dmg += amp(c, 240)
        proc(c)
      },
    },
  },
  {
    id: 'sp_purge',
    name: '방열탄',
    text: '온도를 절반 버리고 버린 만큼을 DMG 로 (뜨거울수록 강하다)',
    rarity: 'uncommon',
    dmg: 10,
    heat: 0,
    price: 30,
    color: '#a9c4d6',
    hooks: {
      onFire(c) {
        // 34/온도 는 발당 평균이 기본탄의 6.0배로 유물탄(특이점 4.9배)보다 셌다. 26 으로.
        const drop = c.s.heat / 2
        c.dmg += Math.round(amp(c, drop * 20))
        c.s.heat -= drop
        proc(c)
      },
    },
  },

  // --- 유물 -----------------------------------------------------------------
  {
    id: 'sp_singularity',
    name: '특이점탄',
    text: '온도가 이번 탄창의 발사 수 ×10 만큼 오른다',
    rarity: 'relic',
    dmg: 20,
    heat: 0,
    price: 110,
    color: '#c88bff',
    hooks: {
      onFire(c) {
        c.heatGain += amp(c, c.s.magFired.length * 10)
        proc(c)
      },
    },
  },
  {
    id: 'sp_judgment',
    name: '심판탄',
    // 누적 피해를 dmg 에 얹으면 STEP5 가 그것을 온도로 **다시** 곱한다 —
    // 그래서 섹터가 오를수록 기여가 단조 증가했다(계수를 아무리 낮춰도 남는다).
    // 적 HP 에서 직접 빼는 방식으로 바꾸면 섹터와 무관한 고정 비율이 된다.
    text: '지금까지 이번 탄창이 입힌 피해의 80%를 적에게 직접 가한다',
    rarity: 'relic',
    dmg: 30,
    heat: 0.5,
    price: 120,
    color: '#ffd76a',
    hooks: {
      onAfterShot(c) {
        const extra = Math.round(amp(c, c.s.magDamage * 0.8))
        if (extra <= 0) return
        c.s.enemy.hp -= extra
        c.s.magDamage += extra
        c.s.totalDamage += extra
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

// ============================================================================
// 특수탄 (Special Rounds) — 소모품
//   기본탄이 "부착물이 곱해질 바닥"이라면, 특수탄은 "플레이어가 쓰는 순간을 고르는 카드"다.
//   수량이 유한하므로 **언제 쓰는가**가 결정이고, 탄창 안 어디에 넣는가가 두 번째 결정이다.
//
//   수치는 전부 data/tuning.ts 의 TR 에 있다. text 도 그 값에서 **생성**한다 —
//   손으로 쓰면 어긋난다 (특이점탄이 text ×10 / 코드 ×6 이었던 것이 그 예다).
// ============================================================================
import type { FireCtx, SpecialDef } from '../types'
import { TR, n, pc } from './tuning'

function proc(c: FireCtx): void {
  c.triggered.push(c.self)
}

/**
 * 이 탄이 **스스로** 얹는 효과량. 성탄(doubleNext)이면 2배, 같은 탄을 겹쳤으면
 * 반복 감쇠(ctx.repeat)를 곱한다. 훅에 힘이 실린 탄은 전부 이 함수를 지나가므로,
 * 여기 한 곳에서 두 규칙이 동시에 걸린다.
 */
function amp(c: FireCtx, v: number): number {
  return (c.s.doubleNext ? v * 2 : v) * c.repeat
}

export const SPECIALS: SpecialDef[] = [
  // --- 일반 -----------------------------------------------------------------
  {
    id: 'sp_incendiary',
    name: '소이탄',
    text: '온도 +' + n(TR.sp_incendiary.heat) + '. 예열 전용 — 자체 피해는 거의 없다',
    rarity: 'common',
    dmg: TR.sp_incendiary.dmg,
    heat: TR.sp_incendiary.heat,
    price: TR.sp_incendiary.price,
    color: '#ff7a2a',
  },
  {
    id: 'sp_ap',
    name: '철갑탄',
    text: '데미지 +' + n(TR.sp_ap.dmg) + '. 온도는 거의 오르지 않는다',
    rarity: 'common',
    dmg: TR.sp_ap.dmg,
    heat: TR.sp_ap.heat,
    price: TR.sp_ap.price,
    color: '#b9c0c7',
  },
  {
    id: 'sp_shock',
    name: '충격탄',
    // 상한 없이 탄창마다 한 발이면 전투 길이가 무한히 늘어난다 (실측 비대체 9→141탄창).
    // 4m 는 그대로 두고 **전투당 누계** 로 막는다 — 크게 올리면 유효 발수가
    // 3→2 로 줄어 '몇 발을 언제 쓰나' 라는 산수 결정의 해상도가 반토막 난다.
    text: '적을 ' + n(TR.sp_shock.knock) + 'm 뒤로 밀어낸다 (전투당 누계 ' + n(TR.sp_shock.cap) + 'm)',
    rarity: 'common',
    dmg: TR.sp_shock.dmg,
    heat: TR.sp_shock.heat,
    price: TR.sp_shock.price,
    color: '#7fc7e8',
    hooks: {
      onAfterShot(c) {
        const used = c.s.vars['knockTotal'] ?? 0
        const room = TR.sp_shock.cap - used
        if (room <= 0) return
        const m = Math.min(room, amp(c, TR.sp_shock.knock))
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
    text: '이번 탄창의 남은 모든 탄 DMG +' + n(TR.sp_adhesive.bonus),
    rarity: 'uncommon',
    dmg: TR.sp_adhesive.dmg,
    heat: TR.sp_adhesive.heat,
    price: TR.sp_adhesive.price,
    color: '#a8d24a',
    hooks: {
      onAfterShot(c) {
        c.s.magDmgBonus += amp(c, TR.sp_adhesive.bonus)
        proc(c)
      },
    },
  },
  {
    id: 'sp_thermite',
    name: '테르밋탄',
    text: '온도 +' + n(TR.sp_thermite.heat) + '. 강력한 예열 — 자체 피해는 거의 없다',
    rarity: 'uncommon',
    dmg: TR.sp_thermite.dmg,
    heat: TR.sp_thermite.heat,
    price: TR.sp_thermite.price,
    color: '#ffb03a',
  },
  {
    id: 'sp_marker',
    name: '표식탄',
    text: '이번 전투 동안 적이 받는 피해 +' + pc(TR.sp_marker.vuln) + '%',
    rarity: 'uncommon',
    dmg: TR.sp_marker.dmg,
    heat: TR.sp_marker.heat,
    price: TR.sp_marker.price,
    color: '#e05fa0',
    hooks: {
      onAfterShot(c) {
        c.s.enemy.vuln += amp(c, TR.sp_marker.vuln)
        proc(c)
      },
    },
  },
  {
    id: 'sp_chill',
    name: '냉각탄',
    text:
      '데미지 +' + n(TR.sp_chill.dmg) + ' · 적 접근 속도 −' + n(TR.sp_chill.slow) +
      ' (이번 전투, 누계 −' + n(TR.sp_chill.cap) + ' 까지)',
    rarity: 'uncommon',
    dmg: TR.sp_chill.dmg,
    heat: TR.sp_chill.heat,
    price: TR.sp_chill.price,
    color: '#8fd8ff',
    hooks: {
      // fireCost 를 여기서 덮어쓰면 부착물 보정(간이 거리계·완충기 등)이 통째로
      // 날아간다 (실측 −36.3%). 재계산은 파이프라인 STEP7 이 맡는다.
      // 누계 상한이 없으면 2발로 전투 길이가 2.5배가 된다 — 충격탄과 같은 처방.
      onAfterShot(c) {
        const used = c.s.vars['chillTotal'] ?? 0
        const room = TR.sp_chill.cap - used
        if (room <= 0) return
        const cut = Math.min(room, amp(c, TR.sp_chill.slow))
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
    dmg: TR.sp_sanctified.dmg,
    heat: TR.sp_sanctified.heat,
    price: TR.sp_sanctified.price,
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
    dmg: TR.sp_cascade.dmg,
    heat: TR.sp_cascade.heat,
    price: TR.sp_cascade.price,
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
    text: '적 방어 패시브를 무시한다 (DMG ' + n(TR.sp_breach.dmg) + ')',
    rarity: 'rare',
    dmg: TR.sp_breach.dmg,
    heat: TR.sp_breach.heat,
    price: TR.sp_breach.price,
    color: '#d0d6dd',
    hooks: {
      onFire(c) {
        c.s.flags['pierce'] = true
        proc(c)
      },
    },
  },

  {
    /**
     * 단독 종결탄. **이 탄창의 유일한 특수탄일 때만** 값이 나온다.
     *
     * 이 게임의 페이오프는 (탄의 성질 × 자리) 라는 랭크 1 곱이라, 최적해가 언제나
     * '예열 먼저, 큰 것 나중' 하나로 수렴했다 — 상태가 달라져도 정답이 안 바뀌니
     * 선택이 사라진다. 이 탄은 값이 **탄창의 구성**에 걸리므로 그 곱을 깬다:
     * "예열을 쌓아 콤보로 갈까, 아니면 이 한 발만 넣고 끝낼까" 라는 갈림길이 생긴다.
     * 예열 없이도 성립하므로 온도가 낮은 첫 탄창·소용량 탄창의 답이 되기도 한다.
     */
    id: 'sp_solitary',
    name: '유일탄',
    text: '이 탄창의 유일한 특수탄이면 DMG +' + n(TR.sp_solitary.bonus),
    rarity: 'rare',
    dmg: TR.sp_solitary.dmg,
    heat: TR.sp_solitary.heat,
    price: TR.sp_solitary.price,
    color: '#ffe9a8',
    hooks: {
      onFire(c) {
        const specials = c.s.magPlan.filter((r) => r.special !== null).length
        if (specials > 1) return
        c.dmg += amp(c, TR.sp_solitary.bonus)
        proc(c)
      },
    },
  },

  // --- 저온 축 — 온도가 낮을수록 강하다 -------------------------------------
  //   온도 이월이 있는 v2 에서, 이 탄들은 "굳이 식힌다"는 반대 선택을 만든다.
  {
    id: 'sp_cryo',
    name: '냉동탄',
    text:
      '발사 전 온도가 낮을수록 강하다 (DMG +(' + n(TR.sp_cryo.thr) + '−온도)×' + n(TR.sp_cryo.mul) + ')',
    rarity: 'uncommon',
    dmg: TR.sp_cryo.dmg,
    heat: TR.sp_cryo.heat,
    price: TR.sp_cryo.price,
    color: '#7fe3ff',
    hooks: {
      onFire(c) {
        const gap = TR.sp_cryo.thr - c.heatBefore
        if (gap <= 0) return
        c.dmg += Math.round(amp(c, gap * TR.sp_cryo.mul))
        proc(c)
      },
    },
  },
  {
    id: 'sp_firststrike',
    name: '초탄',
    // 임계 3.5 는 이월 정상상태에서 첫 칸에서만 성립했다. 6.0 이면 전체 탄창의
    // 55% (첫 탄창)에서 성립하고 최선 칸이 1번이 아니라 2번이 되어 배치 결정이 생긴다.
    text: '발사 전 온도 ' + n(TR.sp_firststrike.thr) + ' 이하면 DMG +' + n(TR.sp_firststrike.bonus),
    rarity: 'rare',
    dmg: TR.sp_firststrike.dmg,
    heat: TR.sp_firststrike.heat,
    price: TR.sp_firststrike.price,
    color: '#cfe6ff',
    hooks: {
      onFire(c) {
        if (c.heatBefore > TR.sp_firststrike.thr) return
        c.dmg += amp(c, TR.sp_firststrike.bonus)
        proc(c)
      },
    },
  },
  {
    id: 'sp_purge',
    name: '방열탄',
    text: '온도를 절반 버리고 버린 만큼 ×' + n(TR.sp_purge.mul) + ' 를 DMG 로 (뜨거울수록 강하다)',
    rarity: 'uncommon',
    dmg: TR.sp_purge.dmg,
    heat: TR.sp_purge.heat,
    price: TR.sp_purge.price,
    color: '#a9c4d6',
    hooks: {
      onFire(c) {
        const drop = c.s.heat / 2
        c.dmg += Math.round(amp(c, drop * TR.sp_purge.mul))
        c.s.heat -= drop
        proc(c)
      },
    },
  },

  // --- 유물 -----------------------------------------------------------------
  {
    id: 'sp_singularity',
    name: '특이점탄',
    text: '온도가 이번 탄창의 발사 수 ×' + n(TR.sp_singularity.mul) + ' 만큼 오른다',
    rarity: 'relic',
    dmg: TR.sp_singularity.dmg,
    heat: TR.sp_singularity.heat,
    price: TR.sp_singularity.price,
    color: '#c88bff',
    hooks: {
      onFire(c) {
        c.heatGain += amp(c, c.s.magFired.length * TR.sp_singularity.mul)
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
    text: '지금까지 이번 탄창이 입힌 피해의 ' + pc(TR.sp_judgment.mul) + '%를 적에게 직접 가한다',
    rarity: 'relic',
    dmg: TR.sp_judgment.dmg,
    heat: TR.sp_judgment.heat,
    price: TR.sp_judgment.price,
    color: '#ffd76a',
    hooks: {
      onAfterShot(c) {
        const extra = Math.round(amp(c, c.s.magDamage * TR.sp_judgment.mul))
        if (extra <= 0) return
        c.s.enemy.hp -= extra
        // magDamage 에는 **더하지 않는다.** 더하면 두 번째 심판탄이 첫 번째가 만든
        // 추가 피해까지 다시 먹어 겹칠수록 발당 가치가 **올라갔다**
        // (실측 1발 8.7 → 2발 10.2). 반복 감쇠로도 못 막는 자기 증식이었다.
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

/**
 * 눈금(TR)을 카탈로그 객체에 다시 흘려보낸다.
 *   dmg/heat/price 는 객체 **필드**라 모듈 로드 시점에 한 번 굳는다 — 훅과 달리
 *   호출 때마다 TR 을 읽지 않는다. 튜너가 TR 을 흔든 뒤 이걸 불러야 반영된다.
 *   (text 는 굳어도 상관없다. 최종 눈금을 tuning.ts 에 써 넣으면 다시 로드되면서
 *    맞는 문구가 생성된다.)
 */
export function syncSpecials(): void {
  const t = TR as unknown as Record<string, Record<string, number>>
  for (const def of SPECIALS) {
    const k = t[def.id]
    if (k === undefined) continue
    if (typeof k['dmg'] === 'number') def.dmg = k['dmg']
    if (typeof k['heat'] === 'number') def.heat = k['heat']
    if (typeof k['price'] === 'number') def.price = k['price']
  }
}

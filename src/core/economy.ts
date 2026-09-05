// ============================================================================
// 경제 — 탄피(Brass)
//   소득 원천은 전부 "잘 싸웠다"의 다른 표현이다 (GDD §10).
//   v2 의 지출처: 특수탄 / 부착물 / 레일 확장 / 응급 보급
// ============================================================================
import type { CombatState, Rarity, Threat } from './types'
import { THREAT_BRASS } from './types'

/**
 * ★ 탄피는 **한 자릿수 화폐**다.
 *
 * 예전에는 부착물 하나가 70, 유물이 260, 런 잔액이 500을 넘었다. 그 크기에서는
 * 숫자를 읽는 것이 아니라 자릿수를 보게 된다 — 70과 130 의 차이가 "두 배쯤"
 * 이라는 뭉갠 감각으로만 남고, 한 발에 3 이라는 특수탄은 그냥 공짜로 읽힌다.
 * 값이 4·7·13·26 이면 "유물 하나 = 일반 여섯 개" 가 한눈에 보인다.
 *
 * 규모를 줄이면서 **구매력**은 같이 줄였다 (economy 실측 §아래). 싸진 게 아니라
 * 단위만 바뀐 것이다.
 */
export const PRICES = {
  attachment: { common: 4, uncommon: 7, rare: 13, relic: 26 } as Record<Rarity, number>,
  rail: [12, 22] as [number, number],
  heal: 3,
  /** 특수탄은 SpecialDef.price 를 쓴다 — 여기 값은 묶음 크기와 할인 배수 */
  specialBundle: 2,
  specialBundleMul: 1.8,
}

export function stakeShopMul(stake: number): number {
  return stake >= 4 ? 1.4 : 1
}

export function shopPrice(base: number, stake: number): number {
  return Math.max(1, Math.round(base * stakeShopMul(stake)))
}

export function distanceLeft(s: CombatState): number {
  return Math.max(0, Math.floor(s.distance))
}

/**
 * 전투 보상 탄피.
 *   승리 1 + 남은 거리 12m당 1 + 최고 온도 50당 1 + 위험도 보너스
 *
 * 소득이 "빨리·뜨겁게 끝내라"는 게임 목표와 정렬되어 있다는 성질은 그대로다 —
 * 나눗셈의 분모만 커졌다. 예전 식(25 + 거리 + 온도/10×2)은 전투당 평균 40 을
 * 뱉었고, 런 하나에서 33번을 살 수 있었다. 그러면 상점은 선택이 아니라 자판기다.
 * 지금은 전투당 4~6 이라 한 번 들를 때 보통 하나를 산다.
 */
export function combatBrass(s: CombatState, threat: Threat): number {
  const base = 1
  const dist = Math.floor(distanceLeft(s) / 12)
  const heat = Math.floor(s.peakHeat / 50)
  return base + dist + heat + (THREAT_BRASS[threat] ?? 0)
}

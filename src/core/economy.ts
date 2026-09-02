// ============================================================================
// 경제 — 탄피(Brass)
//   소득 원천은 전부 "잘 싸웠다"의 다른 표현이다 (GDD §10).
//   v2 의 지출처: 특수탄 / 부착물 / 레일 확장 / 응급 보급
// ============================================================================
import type { CombatState, Rarity, Threat } from './types'
import { THREAT_BRASS } from './types'

export const PRICES = {
  attachment: { common: 35, uncommon: 70, rare: 130, relic: 260 } as Record<Rarity, number>,
  rail: [120, 220] as [number, number],
  heal: 25,
  /** 특수탄은 SpecialDef.price 를 쓴다 — 여기 값은 묶음 할인 배수 */
  specialBundle: 3,
  specialBundleMul: 2.6,
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
 *   승리 25 + 남은 거리 1m당 1 + 최고 온도 10당 2 + 위험도 보너스
 * 소득이 "빨리·뜨겁게 끝내라"는 게임 목표와 정확히 정렬되어 있다.
 */
export function combatBrass(s: CombatState, threat: Threat): number {
  const base = 25
  const dist = distanceLeft(s)
  const heat = Math.floor(s.peakHeat / 10) * 2
  return base + dist + heat + (THREAT_BRASS[threat] ?? 0)
}

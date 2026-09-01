// 탄피(Brass) 경제 — BALANCE.md §5 가격표와 전투 1회 정산식만 담당한다.
// 상태를 바꾸지 않는 순수 계산 모듈이다 (실제 구매 실행은 run.ts).
// 성전 등급 4 이상의 "정비소 가격 +40%"(GDD §12)도 여기서 계산한다.

import type { CombatState, Grade, Rarity, Threat } from './types'
import { THREAT_BRASS } from './types'

// ---------------------------------------------------------------------------
// 가격표 (BALANCE.md §5 "지출 가격표")
// ---------------------------------------------------------------------------

export interface PriceTable {
  /** Mk.I..Mk.V 구매가. 문서에 없는 Mk.IV/V 는 곡선 연장분 90/160 */
  ammo: [number, number, number, number, number]
  /** 등급 +1 승급 */
  upgrade: number
  /** Mk.IV → Mk.V 승급만 별도 가격 */
  upgradeToV: number
  /** 일반/희귀/영웅/유물. 유물은 성소 전용가 260 */
  attachment: Record<Rarity, number>
  magazine: number
  /** 보조 레일 1번째 / 2번째 */
  rail: [number, number]
  /** 다음 전투 시작 거리 +10m */
  heal: number
}

export const PRICES: PriceTable = {
  ammo: [12, 24, 45, 90, 160],
  upgrade: 30,
  upgradeToV: 70,
  attachment: { common: 35, uncommon: 70, rare: 130, relic: 260 },
  magazine: 60,
  rail: [120, 220],
  heal: 25,
}

/** 보상 건너뛰기 보상 (GDD §10.1) */
export const SKIP_REWARD_BRASS = 20

/** 보조 레일 상한 (ATTACHMENTS.md §6 "보조 레일 0~2") */
export const MAX_RAIL_SLOTS = 2

// ---------------------------------------------------------------------------
// 개별 가격 조회
// ---------------------------------------------------------------------------

/** 탄 제거는 살 때마다 +10 씩 비싸진다. 압축은 유한한 자원이어야 한다. */
export function removalPrice(removals: number): number {
  const n = Number.isFinite(removals) ? Math.max(0, Math.floor(removals)) : 0
  return 20 + 10 * n
}

export function ammoPrice(grade: Grade): number {
  return PRICES.ammo[grade - 1]
}

/** 현재 등급 기준 승급가. Mk.IV → V 만 70. */
export function upgradePrice(from: Grade): number {
  return from >= 4 ? PRICES.upgradeToV : PRICES.upgrade
}

export function attachmentPrice(rarity: Rarity): number {
  return PRICES.attachment[rarity]
}

/** 이미 가진 레일 칸 수(0 또는 1)를 넣으면 다음 확장 가격을 준다. */
export function railPrice(owned: number): number {
  const n = Number.isFinite(owned) ? Math.max(0, Math.floor(owned)) : 0
  return n <= 0 ? PRICES.rail[0] : PRICES.rail[1]
}

// ---------------------------------------------------------------------------
// 성전 등급 (Stake) 보정
// ---------------------------------------------------------------------------

/** 성전 등급 4 "정비소 가격 +40%" (GDD §12) */
export function stakeShopMul(stake: number): number {
  return stake >= 4 ? 1.4 : 1
}

/** 상점 표시가. 최소 1 탄피. */
export function shopPrice(base: number, stake: number): number {
  const p = Math.round(base * stakeShopMul(stake))
  return p < 1 ? 1 : p
}

/** 성전 등급 2 "보상방 건너뛰기 보상 없음" (GDD §12) */
export function skipRewardBrass(stake: number): number {
  return stake >= 2 ? 0 : SKIP_REWARD_BRASS
}

// ---------------------------------------------------------------------------
// 전투 정산 (BALANCE.md §5 "전투 1회 평균 소득")
//   승리 25 + 남은 거리 1m당 1 + 최고 온도 10마다 2 + 위험도 보너스
//   전리품 벨트가 붙어 있으면 남은 거리 1m당 +2 가 더 붙는다 (합산 +3).
// ---------------------------------------------------------------------------

/** 전리품 벨트 (ATTACHMENTS.md §5) */
const LOOT_BELT_ID = 'st_loot_belt'

function hasLootBelt(s: CombatState): boolean {
  for (const a of s.attachments) {
    if (a.id === LOOT_BELT_ID) return true
  }
  const l = s.loadout
  if (l.barrel?.id === LOOT_BELT_ID) return true
  if (l.handguard?.id === LOOT_BELT_ID) return true
  if (l.optic?.id === LOOT_BELT_ID) return true
  if (l.stock?.id === LOOT_BELT_ID) return true
  for (const r of l.rails) {
    if (r?.id === LOOT_BELT_ID) return true
  }
  return false
}

/** 남은 거리(내림, 음수는 0) */
export function distanceLeft(s: CombatState): number {
  const d = Number.isFinite(s.distance) ? Math.floor(s.distance) : 0
  return d > 0 ? d : 0
}

/** 최고 온도 보너스 — 10마다 +2 */
export function heatBrass(peakHeat: number): number {
  const h = Number.isFinite(peakHeat) ? Math.max(0, peakHeat) : 0
  return Math.floor(h / 10) * 2
}

export function combatBrass(s: CombatState, threat: Threat): number {
  const left = distanceLeft(s)
  let brass = 25 + left + heatBrass(s.peakHeat) + THREAT_BRASS[threat]
  if (hasLootBelt(s)) brass += left * 2
  return brass
}

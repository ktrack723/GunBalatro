// 탄 1발의 파생 스탯(데미지/온도/넉백/다음탄보너스)과 표시용 라벨을 계산한다.
// BALANCE.md §1 "완성 스탯표"가 유일한 정답이며 이 파일이 그 표의 코드판이다.
// uid 발급도 여기서 담당한다 — 카운터 기반이라 Math.random 없이 결정론적이다.

import type { Ammo, AmmoStats, AmmoType, Grade } from './types'
import { GRADE_BASE, TYPE_DMG_MUL } from './types'

// --- 표시용 상수 -------------------------------------------------------------

const TYPE_SHORT: Record<AmmoType, string> = {
  AP: 'AP',
  INC: 'INC',
  HE: 'HE',
  SANC: 'SANC',
}

const TYPE_NAME: Record<AmmoType, string> = {
  AP: '철갑',
  INC: '소이',
  HE: '고폭',
  SANC: '축성',
}

const TYPE_COLOR: Record<AmmoType, string> = {
  AP: '#b9c0c7',
  INC: '#ff7a2a',
  HE: '#c9a14a',
  SANC: '#f2e6c4',
}

/** 카드 위 등급 표기 (유니코드 로마숫자 — 좁은 카드용) */
const GRADE_ROMAN: Record<Grade, string> = { 1: 'Ⅰ', 2: 'Ⅱ', 3: 'Ⅲ', 4: 'Ⅳ', 5: 'Ⅴ' }

/** 문장용 등급 표기 (GDD §5.2 의 Mk.I~Mk.V 표기) */
const GRADE_MARK: Record<Grade, string> = {
  1: 'Mk.I',
  2: 'Mk.II',
  3: 'Mk.III',
  4: 'Mk.IV',
  5: 'Mk.V',
}

// --- 스탯 --------------------------------------------------------------------

/**
 * BALANCE.md §1 완성 스탯표와 1:1.
 *   AP  17/34/58/88/128, INC 5/9/15/23/34, HE 10/20/34/52/75, SANC 7/14/24/36/53
 * dmg 는 round(등급기본치 × 탄종계수) 로 위 값이 정확히 재현된다 (검산 완료).
 */
export function ammoStats(a: Ammo): AmmoStats {
  const g = a.grade
  return {
    dmg: Math.round(GRADE_BASE[g] * TYPE_DMG_MUL[a.type]),
    heat: heatOf(a.type, g),
    knockback: a.type === 'HE' ? 0.5 * g : 0,
    nextDmgBonus: a.type === 'SANC' ? 20 * g : 0,
  }
}

function heatOf(t: AmmoType, g: Grade): number {
  switch (t) {
    case 'AP':
      return 0.1
    case 'INC':
      return 0.5 + 0.25 * g
    case 'HE':
      return 0.3
    case 'SANC':
      return 0.4
  }
}

// --- 라벨 --------------------------------------------------------------------

/** "철갑 Mk.III" */
export function ammoLabel(a: Ammo): string {
  return TYPE_NAME[a.type] + ' ' + GRADE_MARK[a.grade]
}

export function typeShort(t: AmmoType): string {
  return TYPE_SHORT[t]
}

export function typeName(t: AmmoType): string {
  return TYPE_NAME[t]
}

export function typeColor(t: AmmoType): string {
  return TYPE_COLOR[t]
}

export function gradeRoman(g: Grade): string {
  return GRADE_ROMAN[g]
}

// --- 생성 / uid --------------------------------------------------------------

let uidCounter = 0

/** 결정론적 uid. 런 시작 시 resetUidCounter() 로 초기화한다. */
export function nextUid(): string {
  return 'u' + uidCounter++
}

export function resetUidCounter(): void {
  uidCounter = 0
}

export function makeAmmo(type: AmmoType, grade: Grade, uid: string): Ammo {
  return { uid, type, grade }
}

// --- 탄종 판정 ----------------------------------------------------------------

/** wildcard 가 켜져 있으면 축성탄은 모든 탄종으로 취급된다 (GDD §5.1). */
export function sameType(a: Ammo, b: Ammo, wildcard: boolean): boolean {
  if (wildcard && (a.type === 'SANC' || b.type === 'SANC')) return true
  return a.type === b.type
}

/**
 * "서로 다른 탄종 수" 판정. 최대 4로 클램프.
 * wildcard 시: 비-축성 탄종의 distinct 개수 + 축성탄 발 수 (축성 1발 = 새로운 1종 취급).
 * wildcard 꺼짐: 축성도 그냥 한 탄종으로 세는 단순 distinct.
 */
export function distinctTypeCount(ammos: readonly Ammo[], wildcard: boolean): number {
  const seen: Record<string, boolean> = {}
  let count = 0
  let sancShots = 0
  for (const a of ammos) {
    if (wildcard && a.type === 'SANC') {
      sancShots++
      continue
    }
    if (!seen[a.type]) {
      seen[a.type] = true
      count++
    }
  }
  const total = count + sancShots
  return total > 4 ? 4 : total
}

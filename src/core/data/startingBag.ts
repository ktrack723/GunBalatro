// 시작 가방 24발 구성(BALANCE.md §2)과 보상용 탄 풀을 만든다.
// 소이가 가장 많고 축성이 가장 적다 — 첫 판부터 "예열"을 학습시키기 위한 배분이다.
// 무작위는 여기서 굴리지 않는다. 셔플은 전투 시작 시 Rng 가 담당한다.

import type { Ammo, AmmoType, Grade } from '../types'
import { makeAmmo, nextUid } from '../ammoStats'

/** [탄종, 등급, 발수] — BALANCE.md §2 시작 가방 표 그대로 */
const STARTING_COMPOSITION: ReadonlyArray<readonly [AmmoType, Grade, number]> = [
  ['AP', 1, 4],
  ['AP', 2, 2],
  ['INC', 1, 5],
  ['INC', 2, 3],
  ['HE', 1, 4],
  ['HE', 2, 2],
  ['SANC', 1, 3],
  ['SANC', 2, 1],
]

/** 시작 가방 24발. uid 는 nextUid() 로 결정론적으로 발급된다. */
export function makeStartingBag(): Ammo[] {
  const bag: Ammo[] = []
  for (const [type, grade, count] of STARTING_COMPOSITION) {
    for (let i = 0; i < count; i++) {
      bag.push(makeAmmo(type, grade, nextUid()))
    }
  }
  return bag
}

const ALL_TYPES: readonly AmmoType[] = ['AP', 'INC', 'HE', 'SANC']
const ALL_GRADES: readonly Grade[] = [1, 2, 3, 4, 5]

/** 보상/상점이 뽑아 쓰는 탄 풀. 전 탄종 × 등급 1~5 = 20종. */
export function makeAmmoPool(): { type: AmmoType; grade: Grade }[] {
  const pool: { type: AmmoType; grade: Grade }[] = []
  for (const type of ALL_TYPES) {
    for (const grade of ALL_GRADES) {
      pool.push({ type, grade })
    }
  }
  return pool
}

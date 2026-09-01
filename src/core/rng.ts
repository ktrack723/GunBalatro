// 결정론적 난수원. mulberry32 기반으로 types.ts 의 Rng 계약을 구현한다.
// Date.now / Math.random 을 절대 쓰지 않는다 — 모든 무작위는 시드에서만 나온다.
// fork 는 부모 상태를 소비하지 않고 독립 스트림을 만든다 (재현성 보존).

import type { Rng } from './types'

/** 32bit 정수 두 개를 섞어 새 시드를 만든다 (splitmix 계열 파이널라이저) */
function mix32(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ 0x9e3779b9, 0x85ebca6b)) | 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h | 0
}

/** 문자열 → 32bit 시드 (FNV-1a + 비트 확산). 같은 문자열은 항상 같은 값. */
export function hashSeed(str: string): number {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d)
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b)
  h ^= h >>> 16
  return h >>> 0
}

export function makeRng(seed: number): Rng {
  // 내부 상태는 32bit 정수 하나뿐이다. state()/setState() 로 그대로 저장/복원된다.
  let s = seed | 0

  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const rng: Rng = {
    next,

    int(n: number): number {
      if (!(n > 1)) return 0
      const v = Math.floor(next() * n)
      return v < n ? v : n - 1
    },

    pick<T>(arr: readonly T[]): T {
      return arr[rng.int(arr.length)]
    },

    shuffle<T>(arr: T[]): T[] {
      // Fisher-Yates 역순 루프. 제자리 변경 후 같은 배열을 반환한다.
      for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.int(i + 1)
        const tmp = arr[i]
        arr[i] = arr[j]
        arr[j] = tmp
      }
      return arr
    },

    weighted<T>(items: readonly T[], weights: readonly number[]): T {
      let total = 0
      const n = items.length < weights.length ? items.length : weights.length
      for (let i = 0; i < n; i++) {
        const w = weights[i]
        if (w > 0) total += w
      }
      // 방어: 가중치 합이 0(또는 음수뿐)이면 첫 원소.
      if (total <= 0) return items[0]
      let r = next() * total
      for (let i = 0; i < n; i++) {
        const w = weights[i]
        if (!(w > 0)) continue
        r -= w
        if (r < 0) return items[i]
      }
      return items[n - 1]
    },

    state(): number {
      return s
    },

    setState(v: number): void {
      s = v | 0
    },

    fork(salt: number): Rng {
      // 현재 상태를 읽기만 하고 소비하지 않는다 → 부모 스트림은 그대로 이어진다.
      return makeRng(mix32(s, salt | 0))
    },
  }

  return rng
}

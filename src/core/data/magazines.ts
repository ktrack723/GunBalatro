// 탄창 10종(GDD §6). 탄창은 수치가 아니라 "규칙 구조"를 바꾸는 변경자다.
// 선언적 필드로 표현 가능한 것은 전부 필드로 두고, 훅은 정말 필요한 3종(M4/M6/M10)에만 쓴다.
// 훅 안의 증가는 전부 덧셈이다 — 단 하나의 예외는 M10 의 "첫 발 데미지 0" 대입이다.

import type { FireCtx, Magazine } from '../types'
import { ammoStats } from '../ammoStats'

export const MAGAZINES: Magazine[] = [
  {
    id: 'm1',
    name: '표준 5연발',
    cap: 5,
    text: '기준 탄창. 특수 규칙 없음.',
  },
  {
    id: 'm2',
    name: '드럼 8연발',
    cap: 8,
    text: '온도 획득 -45%, 트레이 -1. 얕고 넓게.',
    heatGainMul: 0.55,
    trayDelta: -1,
  },
  {
    id: 'm3',
    name: '탐식의 성궤',
    cap: 2,
    text: '발사한 탄이 80% 확률로 소모되지 않는다.',
    notConsumedChance: 0.8,
  },
  {
    id: 'm4',
    name: '정밀 3연발',
    cap: 3,
    text: '발사마다 온도 +2.8. 거리 소모 -2m, 트레이 +1.',
    trayDelta: 1,
    fireCostDelta: -2,
    hooks: {
      onFire(c: FireCtx): void {
        c.heatGain += 2.8
      },
    },
  },
  {
    id: 'm5',
    name: '무한 벨트',
    cap: 7,
    text: '7발 장전. 대신 트레이 -3.',
    trayDelta: -3,
  },
  {
    id: 'm6',
    name: '성궤 탄창',
    cap: 4,
    text: '축성탄 다음 탄 보너스 4배. 거리 -1m, 트레이 +1.',
    trayDelta: 1,
    fireCostDelta: -1,
    hooks: {
      onAfterShot(c: FireCtx): void {
        // 파이프라인이 이미 1배를 예약했다. 여기서 3배를 더 얹어 총 4배가 된다.
        // 2배로는 G3 축성탄 기준 +60 — 용량 4 의 손해(-1발)를 갚지 못해 앵커가 죽어 있었다.
        if (c.ammo.type === 'SANC') {
          c.s.pendingNextDmg += ammoStats(c.ammo).nextDmgBonus * 3
        }
      },
    },
  },
  {
    id: 'm7',
    name: '냉각 자켓',
    cap: 5,
    text: '사격 종료 시 온도의 35%를 다음 사격에 이월.',
    heatCarryRatio: 0.35,
  },
  {
    id: 'm8',
    name: '역장 급탄기',
    cap: 5,
    text: '사격 행동의 거리 소모 -1m. 트레이 -1.',
    fireCostDelta: -1,
    trayDelta: -1,
  },
  {
    id: 'm9',
    name: '처형자',
    cap: 1,
    text: '단발. 사격 시작 온도 19.00, 거리 소모 -3m.',
    startHeat: 19,
    fireCostDelta: -3,
  },
  {
    id: 'm10',
    name: '참회의 탄대',
    cap: 5,
    text: '첫 발 데미지 0. 이후 모든 발사 온도 +1.20.',
    hooks: {
      onFire(c: FireCtx): void {
        // ★ 규칙 예외: "첫 탄은 제물" 규칙의 직접 구현이라 유일하게 대입(=)을 쓴다.
        //   덧셈으로는 "데미지 0"을 표현할 수 없다. 다른 어떤 곳에서도 이 형태를 쓰지 않는다.
        if (c.isFirst) {
          c.dmg = 0
        }
        if (!c.isFirst) {
          c.heatGain += 1.2
        }
      },
    },
  },
]

export const MAG_BY_ID: Record<string, Magazine> = (() => {
  const m: Record<string, Magazine> = {}
  for (const mag of MAGAZINES) m[mag.id] = mag
  return m
})()

export const STARTER_MAGAZINE: Magazine = MAG_BY_ID['m1']

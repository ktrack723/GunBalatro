// ============================================================================
// 등급 밴드 유도 — "이 등급은 값이 얼마여야 하는가" 를 **정하지 않고 계산한다**.
//
// 예전 밴드(일반 12~24 · 희귀 24~41 …)는 실측 중앙값에서 거꾸로 맞춘 숫자였다.
// 맞긴 했지만 왜 그 값인지 말할 수 없으니, 카탈로그가 바뀌면 밴드도 같이 흔들렸다.
// 여기서는 **규칙 세 개 + 드롭 확률**에서 밴드를 뽑는다. 규칙이 바뀌지 않는 한
// 밴드는 카탈로그와 무관하게 고정된다.
//
// ── 규칙 ───────────────────────────────────────────────────────────────────
//  R1  같은 등급 안의 폭은 ×SPREAD 를 넘지 않는다.
//      넘으면 같은 등급인데 한쪽이 명백히 낫다 — 그건 '성격 차이' 가 아니라 실수다.
//  R2  등급 사이 계단은 밴드 폭보다 커야 한다. 그래야 밴드가 겹치지 않고,
//      '등급' 이라는 라벨이 값을 예측하는 정보가 된다.
//  R3  바닥 눈금은 게임 안의 불변량에 못 박는다 (아래 ANCHOR).
//
// ── 왜 확률로 계단을 정하지 않는가 ─────────────────────────────────────────
//  드롭 확률에서 계단을 뽑으면(희소도^α) 사다리가 심하게 기운다:
//    일반 45.0% · 희귀 37.8% · 영웅 15.5% · 유물 1.75%  →  희소도비 1.19 / 2.44 / 8.86
//  일반→희귀 계단이 겨우 1.19 배라 등급 라벨이 소음이 되고, 영웅→유물은 8.9 배라
//  유물 하나가 빌드를 끝낸다. 확률은 **계단의 크기**가 아니라 아래 두 가지를 정한다:
//    ① 문(위험도)마다의 기대 보상값 — 이게 갈림길을 진짜 선택으로 만든다
//    ② 가격 — 희소한 것이 비싸야 정비소가 의미를 갖는다
// ============================================================================
import type { Rarity, Threat } from '../core/types'
import { THREAT_RARITY_W } from '../core/types'

export const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'relic']

/** R1 — 같은 등급 안에서 허용하는 최고/최저 비 */
export const SPREAD = 1.5
/** R2 — 등급 한 계단. SPREAD 보다 커야 밴드가 겹치지 않는다 */
export const STEP = 1.6

/**
 * R3 — 바닥 눈금.
 *
 *  부착물: **일반 부착물 한 장 = 탄창에 기본탄 한 발을 더 넣는 것**.
 *    5연발에 한 발을 더하면 처리량이 +20% 다. 그래서 일반의 중앙은 20(%).
 *    이 못은 카탈로그와 무관하다 — 용량과 기본탄만으로 정의된다.
 *
 *  탄: **일반 특수탄 한 발 = 기본탄 4발**.
 *    특수탄은 쓰면 사라지는데 기본탄은 무한이다. 소모품이 무한 자원보다
 *    '조금' 나은 정도면 아무도 아껴 쓸 이유가 없다 — 명확히 넘어야 한다.
 *    4배는 '한 발로 한 탄창의 8할' 이라는 체감의 하한이다.
 */
export const ANCHOR = { attach: 20, round: 4.0 }

export interface Band {
  lo: number
  mid: number
  hi: number
}

function ladder(anchor: number): Record<Rarity, Band> {
  const half = Math.sqrt(SPREAD)
  const out = {} as Record<Rarity, Band>
  RARITIES.forEach((r, i) => {
    const mid = anchor * Math.pow(STEP, i)
    out[r] = { lo: mid / half, mid, hi: mid * half }
  })
  return out
}

export const ATTACH_BANDS = ladder(ANCHOR.attach)
export const ROUND_BANDS = ladder(ANCHOR.round)

// ---------------------------------------------------------------------------
// 드롭 확률 — 카탈로그가 아니라 run.ts 의 규칙에서 나온다
// ---------------------------------------------------------------------------
/**
 * 문은 항상 두 장이고 짝은 [1,2] 또는 [2,3] 이 반반이다 (run.ts THREAT_PAIRS).
 * 플레이어가 더 위험한 쪽을 고를 확률 q 를 받아 **입장하는** 위험도 분포를 낸다.
 * q = 0.5 가 설계 목표다 — 갈림길이 진짜 반반의 선택이라는 뜻이므로.
 */
export function threatMix(q = 0.5): Record<Threat, number> {
  return {
    1: 0.5 * (1 - q),
    2: 0.5 * q + 0.5 * (1 - q),
    3: 0.5 * q,
  }
}

/** 보상 한 장이 각 등급일 확률 (위험도 분포로 주변화) */
export function rarityMix(q = 0.5): Record<Rarity, number> {
  const tm = threatMix(q)
  const out = { common: 0, uncommon: 0, rare: 0, relic: 0 } as Record<Rarity, number>
  for (const t of [1, 2, 3] as Threat[]) {
    const w = THREAT_RARITY_W[t]
    const sum = w[0] + w[1] + w[2] + w[3]
    RARITIES.forEach((r, i) => {
      out[r] += tm[t] * ((w[i] ?? 0) / sum)
    })
  }
  return out
}

/** 위험도별 보상 한 장의 기대 밴드값 — 문 선택이 진짜 저울질인지 보는 눈금 */
export function expectedRewardValue(bands: Record<Rarity, Band>): Record<Threat, number> {
  const out = {} as Record<Threat, number>
  for (const t of [1, 2, 3] as Threat[]) {
    const w = THREAT_RARITY_W[t]
    const sum = w[0] + w[1] + w[2] + w[3]
    let v = 0
    RARITIES.forEach((r, i) => {
      v += ((w[i] ?? 0) / sum) * bands[r].mid
    })
    out[t] = v
  }
  return out
}

/**
 * 가격 사다리 — 여기가 확률이 실제로 일하는 자리다.
 *   같은 밴드값이라도 희소한 것은 비싸야 한다. 안 그러면 정비소에서 늘 영웅만 사고
 *   일반은 아무도 안 산다 (값/가격이 등급마다 같아야 '싸게 여러 장 vs 비싸게 한 장'
 *   이 저울에 오른다).
 *   가격 = 밴드 중앙 × 희소도^PRICE_ALPHA × 눈금.
 *
 *   α 를 크게 잡으면(0.5) 유물이 332 탄피가 되어 값/가격이 일반의 1/5 로 떨어진다 —
 *   그러면 정비소에서 유물은 절대 사면 안 되는 물건이 되어 저울이 아니게 된다.
 *   α = 0.15 는 **완만한 희소 프리미엄** 이다: 값/가격이 등급을 따라 조금씩만
 *   나빠지므로, 싼 것을 여러 장 사는 길과 비싼 것 한 장에 거는 길이 둘 다 살아 있고,
 *   유물은 '사는 것보다 줍는 것이 낫다' 는 로그라이트다운 결이 남는다.
 */
export const PRICE_ALPHA = 0.15

export function priceLadder(unit: number, q = 0.5): Record<Rarity, number> {
  const mix = rarityMix(q)
  const base = mix.common
  const out = {} as Record<Rarity, number>
  RARITIES.forEach((r, i) => {
    const scarcity = base / Math.max(1e-6, mix[r])
    out[r] = unit * Math.pow(STEP, i) * Math.pow(scarcity, PRICE_ALPHA)
  })
  return out
}

// ---------------------------------------------------------------------------
const f = (v: number): string => v.toFixed(1)
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const padS = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s)

export function report(q = 0.5): string {
  const L: string[] = []
  L.push('════ 등급 밴드 유도 ════')
  L.push('규칙 R1 같은 등급 폭 ≤ ×' + SPREAD + ' · R2 등급 계단 ×' + STEP + ' (폭보다 크다 → 겹치지 않는다)')
  L.push('규칙 R3 바닥 못: 부착물 일반 = 탄창에 기본탄 +1발(= +' + ANCHOR.attach + '%) · 탄 일반 = 기본탄 ' + ANCHOR.round + '발')
  L.push('')
  L.push('① 밴드')
  L.push('─'.repeat(76))
  L.push('   ' + pad('등급', 10) + padS('부착물(처리량 %)', 24) + padS('탄(기본탄 배수)', 22))
  for (const r of RARITIES) {
    const a = ATTACH_BANDS[r]
    const b = ROUND_BANDS[r]
    L.push(
      '   ' + pad(r, 10) +
        padS(f(a.lo) + ' ~ ' + f(a.hi) + '  (중앙 ' + f(a.mid) + ')', 24) +
        padS(f(b.lo) + ' ~ ' + f(b.hi) + '  (중앙 ' + f(b.mid) + ')', 22),
    )
  }
  L.push('')
  L.push('② 드롭 확률 (run.ts 의 THREAT_PAIRS × THREAT_RARITY_W, 위험도 선택 q=' + q + ')')
  L.push('─'.repeat(76))
  const tm = threatMix(q)
  L.push('   입장 위험도   1: ' + (tm[1] * 100).toFixed(1) + '%   2: ' + (tm[2] * 100).toFixed(1) + '%   3: ' + (tm[3] * 100).toFixed(1) + '%')
  const mix = rarityMix(q)
  L.push('   보상 한 장의 등급 분포')
  for (const r of RARITIES) {
    const p = mix[r]
    L.push('     ' + pad(r, 10) + padS((p * 100).toFixed(2) + '%', 8) + '   희소도 ' + padS(f(mix.common / Math.max(1e-6, p)) + '×', 8))
  }
  L.push('')
  L.push('③ 문(위험도)별 보상 한 장의 기대값 — 갈림길이 저울질인지 보는 눈금')
  L.push('─'.repeat(76))
  const er = expectedRewardValue(ATTACH_BANDS)
  for (const t of [1, 2, 3] as Threat[]) {
    L.push('   위험도 ' + t + '   기대 ' + padS(f(er[t]) + '%', 8) + '   위험도1 대비 ' + f(er[t] / er[1]) + '×')
  }
  L.push('   → 위험도 3 은 보상이 ' + f(er[3] / er[1]) + '배. 그 대가가 HP ×3.7 과 속도 +2 다.')
  L.push('')
  L.push('④ 가격 사다리 — 값/가격이 등급마다 같아야 정비소가 저울이 된다')
  L.push('─'.repeat(76))
  const pl = priceLadder(16, q)
  for (const r of RARITIES) {
    L.push('   ' + pad(r, 10) + '권장가 ' + padS(String(Math.round(pl[r])), 5) + '   (밴드중앙 ' + padS(f(ROUND_BANDS[r].mid), 6) + ' → 값/가격 ' + f(ROUND_BANDS[r].mid / pl[r] * 100) + ')')
  }
  return L.join('\n')
}

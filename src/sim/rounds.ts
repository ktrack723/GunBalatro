// ============================================================================
// 탄 가치 분석기 — "모든 선택이 저울질 가능한가" 를 수치로 답한다.
//
// 왜 소이·소이·철갑 한 줄이 정답이 되는가:
//   한 탄창의 피해는  Σ_i  dmg_i × H_i  이고,  H_i = H0 + Σ_{j<i} g_j  이다.
//   즉 탄 하나의 가치는 (자기 dmg × 그때의 온도) + (자기 온도 × 뒤에 오는 dmg 합) 이다.
//   이 페이오프 행렬은 **랭크 1** 이다 — 탄의 성질(dmg 큼 / 온도 큼)과 자리(앞/뒤)가
//   곱으로만 엮인다. 랭크 1 행렬의 최적해는 언제나 '정렬' 하나뿐이라, 상태가 달라져도
//   최선의 순서가 바뀌지 않는다. 그래서 선택이 사라진다.
//
//   고치는 방향은 계수 조정이 아니라 **행렬의 랭크를 올리는 것**이다:
//   상태(온도·용량·거리·동승 탄)에 따라 argmax 가 바뀌는 탄을 넣어야 한다.
//
// 이 도구가 재는 것:
//   ① 슬롯 가치   — 기본탄 한 발을 이 탄으로 바꿨을 때의 순증 (2탄창 지평선)
//   ② 등급 밴드   — 슬롯 가치 / 기본탄 가치. 등급이 다를 때만 값이 달라야 한다
//   ③ 상태 커버리지 — 격자 상태들 중 이 탄이 '최고 가치' 인 비율. 0 이면 죽은 선택지다
//   ④ 시너지     — V(X,Y) − V(X) − V(Y). 특정 조합만 폭발하면 그 줄이 정답이 된다
// ============================================================================
import type { CombatState, Loadout, Round } from '../core/types'
import { BASE_HEAT } from '../core/types'
import { makeRng } from '../core/rng'
import { basicRound, cloneState, fire, makeRound, startCombat } from '../core/combat'
import { STARTER_MAGAZINE } from '../core/data/attachments'
import { SPECIALS } from '../core/data/specials'
import { ARCHETYPES } from '../core/data/enemies'

interface Ref {
  name: string
  heat0: number
  cap: number
  dist: number
}

/** 실측 페이싱(여유 배수 1.15, 전투당 1.8탄창)에서 실제로 지나가는 상태들 */
const GRID: Ref[] = [
  { name: '냉·5칸', heat0: BASE_HEAT, cap: 5, dist: 26 },
  { name: '중·5칸', heat0: 10, cap: 5, dist: 20 },
  { name: '열·5칸', heat0: 22, cap: 5, dist: 14 },
  { name: '냉·3칸', heat0: BASE_HEAT, cap: 3, dist: 26 },
  { name: '중·8칸', heat0: 10, cap: 8, dist: 20 },
  { name: '열·2칸', heat0: 22, cap: 2, dist: 10 },
]

function bareLoadout(specials: Record<string, number>): Loadout {
  return {
    barrel: null,
    handguard: null,
    optic: null,
    stock: null,
    magazine: STARTER_MAGAZINE,
    rails: [null, null],
    railSlots: 2,
    stash: [],
    specials,
    brass: 0,
  }
}

function stateFor(ref: Ref, specials: Record<string, number>): CombatState {
  const arch = ARCHETYPES[0]!
  const s = startCombat(
    bareLoadout(specials),
    {
      archetype: arch,
      passive: null,
      // 죽지 않을 만큼 크게 — 오버킬이 가치를 잘라먹으면 비교가 망가진다
      maxHp: 1e12,
      hp: 1e12,
      speed: arch.speed,
      startDist: ref.dist,
      label: '표적',
      bodyCount: 1,
      vuln: 0,
    bossId: null,
    },
    makeRng(0x51ce),
  )
  s.cap = ref.cap
  s.distance = ref.dist
  s.heatStartBase = ref.heat0
  s.heat = ref.heat0
  return s
}

/**
 * 2탄창 지평선으로 평가한다. 표식(취약)·냉각·온도 이월처럼 **다음 사격에 남는** 효과가
 * 1탄창 측정에서는 통째로 0 으로 보이기 때문이다.
 * 거리 이득(밀어냄)은 damage 로 환산한다 — 1행동 ≈ 1탄창 피해.
 */
function evaluate(ref: Ref, plan: Round[], specials: Record<string, number>, baseMag: number): number {
  const s = cloneState(stateFor(ref, specials))
  s.dryRun = true
  const d0 = s.distance
  fire(s, plan)
  fire(s, fillBasic(ref.cap))
  const spent = d0 - s.distance
  const normalSpend = 2 * s.fireCost
  const savedActions = (normalSpend - spent) / Math.max(1, s.fireCost)
  return s.totalDamage + savedActions * baseMag
}

function fillBasic(n: number): Round[] {
  const out: Round[] = []
  for (let i = 0; i < n; i += 1) out.push(basicRound())
  return out
}

/** k 발을 어느 자리에 넣을지 전부 시도해 최선을 고른다 (자리 선택이 이 게임의 결정이다) */
function bestWith(ref: Ref, id: string, k: number, baseMag: number): number {
  const stock: Record<string, number> = { [id]: k }
  let best = -Infinity
  const positions = combinations(ref.cap, k)
  for (const pos of positions) {
    const plan: Round[] = []
    for (let i = 0; i < ref.cap; i += 1) {
      plan.push(pos.includes(i) ? makeRound(id) : basicRound())
    }
    const v = evaluate(ref, plan, stock, baseMag)
    if (v > best) best = v
  }
  return best
}

function combinations(n: number, k: number): number[][] {
  const out: number[][] = []
  const rec = (start: number, cur: number[]): void => {
    if (cur.length === k) {
      out.push(cur.slice())
      return
    }
    for (let i = start; i < n; i += 1) {
      cur.push(i)
      rec(i + 1, cur)
      cur.pop()
    }
  }
  rec(0, [])
  return out
}

/** 두 탄을 함께 넣었을 때의 최선 (자리·순서 전부 시도) */
function bestPair(ref: Ref, a: string, bId: string, baseMag: number): number {
  const stock: Record<string, number> = { [a]: 1, [bId]: 1 }
  let best = -Infinity
  for (let i = 0; i < ref.cap; i += 1) {
    for (let j = 0; j < ref.cap; j += 1) {
      if (i === j) continue
      const plan: Round[] = []
      for (let x = 0; x < ref.cap; x += 1) {
        plan.push(x === i ? makeRound(a) : x === j ? makeRound(bId) : basicRound())
      }
      const v = evaluate(ref, plan, stock, baseMag)
      if (v > best) best = v
    }
  }
  return best
}

const pad = (s: string, n: number): string => {
  let out = s
  while (out.length < n) out += ' '
  return out
}
const padS = (s: string, n: number): string => {
  let out = s
  while (out.length < n) out = ' ' + out
  return out
}
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '—')

/**
 * 등급별 목표 밴드 (기본탄 한 발 = 1.0 기준의 슬롯 가치).
 * 규칙: **등급이 다를 때만** 값이 유의미하게 달라야 한다. 그래서 밴드는 서로 겹치지 않고
 * 한 단계마다 ×1.6 쯤 오른다. 같은 등급 안의 폭(±25%)은 '성격 차이' 로만 쓴다.
 */
const BANDS: Record<string, [number, number]> = {
  common: [3.0, 5.0],
  uncommon: [5.0, 8.0],
  rare: [8.0, 12.0],
  relic: [12.0, 18.0],
}

export function analyzeRounds(): string {
  const L: string[] = []
  const line = (): void => { L.push('─'.repeat(92)) }

  L.push('════ 탄 가치 분석 ════')
  L.push('슬롯 가치 = 기본탄 한 발을 이 탄으로 바꿨을 때의 순증 (2탄창 지평선, 거리 이득 환산 포함)')
  L.push('배수 = 슬롯 가치 / 기본탄 한 발의 가치. 등급이 같으면 배수도 같아야 한다.')
  L.push('')

  // 상태별 기준값
  const base: Record<string, number> = {}
  const basePerSlot: Record<string, number> = {}
  for (const ref of GRID) {
    const s0 = stateFor(ref, {})
    const mag = (() => {
      const c = cloneState(s0)
      c.dryRun = true
      fire(c, fillBasic(ref.cap))
      return c.totalDamage
    })()
    base[ref.name] = evaluate(ref, fillBasic(ref.cap), {}, mag)
    basePerSlot[ref.name] = mag / ref.cap
    L.push(
      '   ' + pad(ref.name, 10) + ' 기본탄 ' + ref.cap + '발 2탄창 = ' + padS(f1(base[ref.name]!), 10) +
        ' · 한 발 ' + padS(f1(basePerSlot[ref.name]!), 8),
    )
  }
  L.push('')

  // ① 슬롯 가치 표
  L.push('① 슬롯 가치 (1발 넣었을 때) — 상태별 배수')
  line()
  L.push('   ' + pad('탄', 12) + pad('등급', 9) + GRID.map((g) => padS(g.name, 10)).join('') + padS('평균배수', 10))
  const mult: Record<string, number> = {}
  const perState: Record<string, number[]> = {}
  for (const def of SPECIALS) {
    const row: string[] = []
    const vals: number[] = []
    for (const ref of GRID) {
      const b = base[ref.name]!
      const mag = basePerSlot[ref.name]!
      const v = (bestWith(ref, def.id, 1, b / 2) - b) / mag + 1
      vals.push(v)
      row.push(padS(f1(v), 10))
    }
    perState[def.id] = vals
    mult[def.id] = vals.reduce((a, b2) => a + b2, 0) / vals.length
    L.push('   ' + pad(def.name, 12) + pad(def.rarity, 9) + row.join('') + padS(f1(mult[def.id]!), 10))
  }
  L.push('')

  // ①-b 짝을 만났을 때의 값 — 성탄·연쇄처럼 혼자서는 값이 안 나오는 탄을 위해
  L.push('①-b 최선의 짝과 함께일 때 (중·5칸) — 단독값 + 시너지÷2. 조합형 탄은 이 값으로 판정한다')
  line()
  const refC = GRID[1]!
  const bC = base[refC.name]!
  const magC = basePerSlot[refC.name]!
  const solo: Record<string, number> = {}
  for (const def of SPECIALS) solo[def.id] = bestWith(refC, def.id, 1, bC / 2) - bC
  const combo: Record<string, number> = {}
  const partner: Record<string, string> = {}
  for (const x of SPECIALS) {
    let best = -Infinity
    let who = '—'
    for (const y of SPECIALS) {
      if (y.id === x.id) continue
      // 시너지는 **반씩** 나눠 갖는다 (2인 섀플리). 통째로 X 에 몰아주면 짝이 서로를
      // 부풀려서 전원이 '초과' 로 나온다 — 실측에서 16종 중 15종이 그랬다.
      const syn = bestPair(refC, x.id, y.id, bC / 2) - bC - solo[x.id]! - solo[y.id]!
      const v = solo[x.id]! + syn / 2
      if (v > best) {
        best = v
        who = y.name
      }
    }
    combo[x.id] = best / magC + 1
    partner[x.id] = who
  }
  const score: Record<string, number> = {}
  for (const def of SPECIALS) {
    score[def.id] = Math.max(mult[def.id]!, combo[def.id]!)
    L.push(
      '   ' + pad(def.name, 12) + '단독 ' + padS(f1(mult[def.id]!), 7) +
        '   짝(' + pad(partner[def.id]!, 8) + ') ' + padS(f1(combo[def.id]!), 7) +
        '   최선 ' + padS(f1(score[def.id]!), 7),
    )
  }
  L.push('')

  // ①-c 밴드 판정
  L.push('①-c 등급 밴드 판정 — 목표: 일반 3~5 · 희귀 5~8 · 영웅 8~12 · 유물 12~18')
  line()
  let ok = 0
  for (const def of SPECIALS) {
    const [lo, hi] = BANDS[def.rarity] ?? [0, 99]
    const v = score[def.id]!
    const mark = v < lo ? '⬇ 미달' : v > hi ? '⬆ 초과' : '✅'
    if (mark === '✅') ok += 1
    L.push(
      '   ' + pad(def.name, 12) + pad(def.rarity, 9) + padS(f1(v), 7) +
        '   목표 ' + f1(lo) + '~' + f1(hi) + '   ' + mark,
    )
  }
  L.push('   밴드 안 ' + ok + ' / ' + SPECIALS.length + '종')
  L.push('')

  // ② 등급 밴드
  L.push('② 등급 밴드 — 같은 등급 안에서는 값이 모여야 하고, 등급이 오르면 올라야 한다')
  line()
  const byRarity: Record<string, number[]> = {}
  for (const def of SPECIALS) (byRarity[def.rarity] ??= []).push(mult[def.id]!)
  for (const r of ['common', 'uncommon', 'rare', 'relic']) {
    const v = byRarity[r] ?? []
    if (v.length === 0) continue
    const lo = Math.min(...v)
    const hi = Math.max(...v)
    const avg = v.reduce((a, b) => a + b, 0) / v.length
    L.push(
      '   ' + pad(r, 10) + 'n=' + pad(String(v.length), 4) +
        '최저 ' + padS(f1(lo), 7) + '  평균 ' + padS(f1(avg), 7) + '  최고 ' + padS(f1(hi), 7) +
        '  퍼짐 ' + padS(f1(hi - lo), 7) + (hi - lo > avg * 0.6 ? '  ← 같은 등급인데 벌어졌다' : ''),
    )
  }
  L.push('')

  // ③ 상태 커버리지
  L.push('③ 상태 커버리지 — 이 탄이 그 상태에서 **최고 가치**인가 (0 이면 어떤 상황에서도 안 고른다)')
  line()
  const winner: string[] = []
  for (let i = 0; i < GRID.length; i += 1) {
    let bestId = ''
    let bestV = -Infinity
    for (const def of SPECIALS) {
      const v = perState[def.id]![i]!
      if (v > bestV) {
        bestV = v
        bestId = def.name
      }
    }
    winner.push(bestId)
  }
  for (let i = 0; i < GRID.length; i += 1) {
    L.push('   ' + pad(GRID[i]!.name, 10) + '최고: ' + winner[i]!)
  }
  const uniq = new Set(winner)
  L.push('   서로 다른 승자 ' + uniq.size + '종 / 상태 ' + GRID.length + '개' +
    (uniq.size <= 2 ? '  ← 사실상 정답이 하나다' : ''))
  L.push('')

  // ④ 시너지 (소이 × 나머지)
  L.push('④ 시너지 V(X,Y) − V(X) − V(Y) — 특정 조합만 폭발하면 그 줄이 정답이 된다 (중·5칸 기준)')
  line()
  const ref = GRID[1]!
  const b = base[ref.name]!
  const mag = basePerSlot[ref.name]!
  const pairs: Array<[string, string, number]> = []
  for (let i = 0; i < SPECIALS.length; i += 1) {
    for (let j = i + 1; j < SPECIALS.length; j += 1) {
      const a = SPECIALS[i]!
      const c = SPECIALS[j]!
      const va = bestWith(ref, a.id, 1, b / 2) - b
      const vc = bestWith(ref, c.id, 1, b / 2) - b
      const vac = bestPair(ref, a.id, c.id, b / 2) - b
      pairs.push([a.name, c.name, (vac - va - vc) / mag])
    }
  }
  pairs.sort((x, y) => y[2] - x[2])
  for (const [x, y, v] of pairs.slice(0, 8)) {
    L.push('   ' + pad(x + ' + ' + y, 26) + padS(f1(v), 10) + ' 슬롯')
  }
  L.push('')

  // ⑤ 반복 감쇠가 실제로 무는가
  L.push('⑤ 같은 탄 겹치기 — 1발 대비 2발/3발의 발당 가치 (중·5칸)')
  line()
  for (const def of SPECIALS) {
    const v1 = (bestWith(ref, def.id, 1, b / 2) - b) / mag
    const v2 = (bestWith(ref, def.id, 2, b / 2) - b) / (2 * mag)
    const v3 = ref.cap >= 3 ? (bestWith(ref, def.id, 3, b / 2) - b) / (3 * mag) : NaN
    L.push(
      '   ' + pad(def.name, 12) + '1발 ' + padS(f1(v1), 8) + '   2발 ' + padS(f1(v2), 8) +
        '   3발 ' + padS(f1(v3), 8) + (v2 > v1 * 0.95 ? '  ← 겹쳐도 안 준다' : ''),
    )
  }

  return L.join('\n')
}

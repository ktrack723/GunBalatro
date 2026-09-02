// ============================================================================
// 자동 플레이 봇 (v2)
//   덱이 사라졌으므로 전투 중 결정은 둘뿐이다:
//     ① 이번 탄창에 어떤 특수탄을 몇 발 넣을까
//     ② 그 탄들을 어떤 순서로 넣을까 (온도가 누적되므로 순서가 곧 데미지다)
// ============================================================================
import type { CombatState, Round } from '../core/types'
import { basicRound, fire, makeRound, previewDamage } from '../core/combat'
import { SPECIAL_BY_ID } from '../core/data/specials'

export type BotSkill = 'greedy' | 'optimal'
export const MAX_ACTIONS = 40

function heatOf(r: Round): number {
  return r.special === null ? 0.55 : (SPECIAL_BY_ID[r.special]?.heat ?? 0)
}
function dmgOf(r: Round): number {
  return r.special === null ? 12 : (SPECIAL_BY_ID[r.special]?.dmg ?? 0)
}

/** 사용 가능한 특수탄을 발 단위로 펼친다 (용량 상한까지) */
function availableSpecials(s: CombatState): Round[] {
  const out: Round[] = []
  for (const [id, n] of Object.entries(s.specials)) {
    for (let i = 0; i < Math.min(n, s.cap); i += 1) out.push(makeRound(id))
  }
  return out
}

/** 온도 오름차순 → 데미지 오름차순: "예열 먼저, 큰 것 나중" */
function heuristicOrder(rounds: Round[]): Round[] {
  return rounds.slice().sort((a, b) => {
    const ha = heatOf(a) - dmgOf(a) / 60
    const hb = heatOf(b) - dmgOf(b) / 60
    return hb - ha
  })
}

function fillBasics(plan: Round[], cap: number): Round[] {
  const out = plan.slice()
  while (out.length < cap) out.push(basicRound())
  return out
}

/** 후보 배열 몇 가지를 만들어 previewDamage 로 최선을 고른다 */
function candidates(s: CombatState, skill: BotSkill): Round[][] {
  const sp = availableSpecials(s)
  const cap = s.cap
  const out: Round[][] = []

  // ① 전부 기본탄 — 특수탄을 아끼는 선택
  out.push(fillBasics([], cap))

  if (sp.length > 0) {
    // ② 휴리스틱: 예열용(온도 높은) 앞, 피니셔(데미지 높은) 뒤
    const byHeat = heuristicOrder(sp).slice(0, cap)
    out.push(fillBasics(byHeat, cap))

    // ③ 특수탄을 뒤로 몰기 (기본탄으로 예열 후 마무리)
    const tail = byHeat.slice(0, Math.max(1, Math.min(cap - 1, byHeat.length)))
    const lead = fillBasics([], cap - tail.length)
    out.push([...lead, ...tail])

    // ④ 데미지 최고 1발만 마지막에
    const best = sp.slice().sort((a, b) => dmgOf(b) - dmgOf(a))[0]
    out.push([...fillBasics([], cap - 1), best])

    if (skill === 'optimal') {
      // 상위 후보의 인접 스왑 지역 탐색
      const base = out[1]
      for (let i = 0; i + 1 < base.length; i += 1) {
        const swapped = base.slice()
        const t = swapped[i]
        swapped[i] = swapped[i + 1]
        swapped[i + 1] = t
        out.push(swapped)
      }
    }
  }
  return out
}

export function chooseAction(s: CombatState, skill: BotSkill): { kind: 'fire'; plan: Round[] } {
  let best: Round[] = fillBasics([], s.cap)
  let bestV = -1
  for (const plan of candidates(s, skill)) {
    const v = previewDamage(s, plan).expected
    // 적을 죽일 수 있으면 특수탄을 덜 쓰는 쪽을 선호한다
    const specials = plan.filter((r) => r.special !== null).length
    const score = v >= s.enemy.hp ? 1e9 - specials * 1000 : v
    if (score > bestV) {
      bestV = score
      best = plan
    }
  }
  return { kind: 'fire', plan: best }
}

export function estimateMagDamage(s: CombatState, skill: BotSkill): number {
  let best = 0
  for (const plan of candidates(s, skill)) {
    const v = previewDamage(s, plan).expected
    if (v > best) best = v
  }
  return best
}

export function playCombat(
  s: CombatState,
  skill: BotSkill,
): { win: boolean; magsUsed: number; peakHeat: number; distanceLeft: number } {
  let guard = 0
  while (guard < MAX_ACTIONS) {
    guard += 1
    if (s.enemy.hp <= 0) break
    if (s.distance <= 0) break
    const act = chooseAction(s, skill)
    fire(s, act.plan)
  }
  return {
    win: s.enemy.hp <= 0,
    magsUsed: s.magsFired,
    peakHeat: s.peakHeat,
    distanceLeft: Math.max(0, s.distance),
  }
}

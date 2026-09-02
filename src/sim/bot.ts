// ============================================================================
// 자동 플레이 봇 (v2)
//   덱이 사라졌으므로 전투 중 결정은 둘뿐이다:
//     ① 이번 탄창에 어떤 특수탄을 몇 발 넣을까
//     ② 그 탄들을 어떤 순서로 넣을까 (온도가 누적되므로 순서가 곧 데미지다)
// ============================================================================
import type { CombatState, FireEvent, Round } from '../core/types'
import { basicRound, fire, makeRound, previewDamage } from '../core/combat'
import { SPECIAL_BY_ID } from '../core/data/specials'

/**
 * 봇의 숙련도.
 *   'novice'  — 미리보기를 전혀 쓰지 않는다. 특수탄이 있으면 있는 대로 넣고 쏜다.
 *               "처음 하는 사람" 의 대역이다.
 *   'greedy'  — 후보 몇 개를 previewDamage 로 비교해 최선을 고른다.
 *   'optimal' — 용량이 작으면 순열을 전수 탐색한다.
 *
 * 예전에는 greedy/optimal 둘뿐이었는데, greedy 도 이미 미리보기로 배열을 고르므로
 * 사실상 둘 다 숙련자였다. 그래서 "배울 것이 있는가" 지표(격차)가 항상 0 이 나왔다 —
 * 게임에 배울 게 없어서가 아니라 **못하는 쪽을 측정한 적이 없어서**였다.
 */
export type BotSkill = 'novice' | 'greedy' | 'optimal'
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

/** 순열 전수 (원소 5개 == 120가지. 그 이상은 하지 않는다) */
function permute(a: Round[]): Round[][] {
  if (a.length <= 1) return [a]
  const out: Round[][] = []
  for (let i = 0; i < a.length; i += 1) {
    for (const rest of permute(a.slice(0, i).concat(a.slice(i + 1)))) out.push([a[i], ...rest])
  }
  return out
}

/**
 * 초보의 장전 — 미리보기를 쓰지 않는다.
 * 갖고 있는 특수탄을 눈에 띄는 순서(id 순)대로 앞에서부터 채우고 나머지는 기본탄.
 * "예열 먼저, 큰 것 나중" 이라는 이 게임의 핵심을 **모르는** 상태다.
 */
function novicePlan(s: CombatState): Round[] {
  const out: Round[] = []
  for (const id of Object.keys(s.specials).sort()) {
    const have = s.specials[id] ?? 0
    for (let i = 0; i < have && out.length < s.cap; i += 1) out.push(makeRound(id))
  }
  return fillBasics(out, s.cap)
}

/** 후보 배열 몇 가지를 만들어 previewDamage 로 최선을 고른다 */
function candidates(s: CombatState, skill: BotSkill): Round[][] {
  const sp = availableSpecials(s)
  const cap = s.cap
  const out: Round[][] = []

  // ① 전부 기본탄 — 특수탄을 아끼는 선택
  out.push(fillBasics([], cap))

  // ①-b **부분 장전.** 봇은 지금까지 언제나 cap 을 꽉 채웠다 — 즉 UI 가 매번 묻는
  //   'N/용량 발' 이라는 축을 한 번도 평가한 적이 없다. 그래서 장전 수를 읽는
  //   부착물(두 발의 계율)은 어떤 수치를 줘도 채택률이 0 이었다.
  for (const n of [2, 3]) {
    if (n < cap) out.push(fillBasics([], n))
  }

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

    // ⑤ **고DMG 특수탄을 1번 자리에.** heuristicOrder 는 철갑탄을 늘 마지막에 두는데,
    //   그 자리가 '볼터의 원형'(기본탄이 특수탄 최고 DMG 를 물려받는다)의 값을 정확히
    //   0 으로 만든다. 이 후보가 없으면 그 유물은 영원히 0점으로 측정된다.
    out.push([best, ...fillBasics([], cap - 1)])
    if (cap >= 3 && sp.length >= 2) {
      const second = sp.slice().sort((a, b) => dmgOf(b) - dmgOf(a))[1]
      out.push([best, ...fillBasics([], cap - 2), second])
    }

    // ⑥ 부분 장전 + 특수탄 (두 발의 계율 × 특수탄)
    if (cap > 2) out.push([basicRound(), best])

    if (skill === 'optimal') {
      const base = out[1]
      if (base.length <= 5) {
        // 용량 5 이하면 순열을 전부 본다 — 배열이 곧 데미지인 게임이므로
        // "가능한 최선" 을 실제로 찾아야 숙련 격차가 정직하게 측정된다.
        for (const p of permute(base)) out.push(p)
      } else {
        for (let i = 0; i + 1 < base.length; i += 1) {
          const swapped = base.slice()
          const t = swapped[i]
          swapped[i] = swapped[i + 1]
          swapped[i + 1] = t
          out.push(swapped)
        }
      }
    }
  }
  return out
}

export function chooseAction(s: CombatState, skill: BotSkill): { kind: 'fire'; plan: Round[] } {
  // 초보는 비교하지 않는다 — 그게 초보다.
  if (skill === 'novice') return { kind: 'fire', plan: novicePlan(s) }

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
  // 화력 프로브는 항상 greedy 기준으로 잰다 — 상점/보상 오라클이
  // 봇 숙련도에 따라 흔들리면 부착물 가치 측정이 무너진다.
  let best = 0
  for (const plan of candidates(s, skill === 'novice' ? 'greedy' : skill)) {
    const v = previewDamage(s, plan).expected
    if (v > best) best = v
  }
  return best
}

export function playCombat(
  s: CombatState,
  skill: BotSkill,
  /** 플레이스루 리포트용 — 사격 이벤트를 그대로 넘겨받는다 (없으면 버린다) */
  onEvents?: (ev: readonly FireEvent[]) => void,
): { win: boolean; magsUsed: number; peakHeat: number; distanceLeft: number } {
  let guard = 0
  while (guard < MAX_ACTIONS) {
    guard += 1
    if (s.enemy.hp <= 0) break
    if (s.distance <= 0) break
    const act = chooseAction(s, skill)
    const ev = fire(s, act.plan)
    if (onEvents !== undefined) onEvents(ev)
  }
  return {
    win: s.enemy.hp <= 0,
    magsUsed: s.magsFired,
    peakHeat: s.peakHeat,
    distanceLeft: Math.max(0, s.distance),
  }
}

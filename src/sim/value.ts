// ============================================================================
// 가치 엔진 — 플레이스루를 돌리지 않고 **조합을 열거해서** 값을 잰다.
//
// 왜 플레이스루가 아닌가:
//   판을 돌려 얻는 것은 '이 빌드가 이겼다' 는 결과이고, 거기서 개별 아이템의 값을
//   되짚으려면 채택률·승률 리프트 같은 **상관** 지표를 봐야 한다. 상관은 표본이
//   커도 인과가 아니다 — 강한 카드와 같이 뽑히는 카드가 같이 올라간다.
//   여기서는 다른 것을 다 고정한 채 그 아이템만 넣고 빼서 **차이**를 잰다.
//
// 무엇을 열거하는가:
//   ① 동반 부착물 조합 — 재려는 칸을 뺀 나머지 네 칸을 각 4후보로 전개 (4⁴ = 256).
//      후보는 등급별 대표 + 빈칸이고, **드롭 확률로 가중**한다.
//   ② 탄창 구성 — 대표 구성 여러 개를 돌려 최선을 취한다 (플레이어는 그 부착물이
//      제 값을 하는 탄창을 짠다).
//   ③ 상태(온도·거리) — 격자를 손으로 두지 않는다. 그 빌드가 실제로 지나가는
//      궤적을 굴려서 얻는다: 거리는 시작거리/사격비용이 정하고, 온도는 이월
//      점화식 H(k+1) = ρ(H(k) + G) 가 정한다.
//
// 단위:
//   부착물 = 처리량 증가율(%) — 처리량은 (탄창당 피해 × 그 전투에서 쓸 수 있는 사격 수).
//   탄     = 기본탄 배수 — 기본탄 한 발을 이 탄으로 바꿨을 때 그 자리가 몇 배가 되는가.
//   두 단위 모두 sim/bands.ts 의 유도된 밴드와 같은 눈금이다.
// ============================================================================
import type { Attachment, CombatState, Loadout, Rarity, Round } from '../core/types'
import { BASE_HEAT } from '../core/types'
import { makeRng } from '../core/rng'
import { basicRound, cloneState, fire, makeRound, startCombat } from '../core/combat'
import { ATT_BY_ID, STARTER_MAGAZINE } from '../core/data/attachments'
import { SPECIALS } from '../core/data/specials'
import { ARCHETYPES, PASSIVE_BY_ID } from '../core/data/enemies'
import { ROUND_BANDS, priceLadder, rarityMix } from './bands'

// ---------------------------------------------------------------------------
// ① 동반 조합 — 재려는 칸을 뺀 나머지를 전개한다
// ---------------------------------------------------------------------------
/**
 * 칸마다의 후보. 빈칸 + 등급별 대표 하나씩.
 *   대표는 그 부위의 **조건 축**이 서로 다르게 고른다. 한 축으로만 채우면
 *   그 축의 조건부(특수탄 전용·저온 전용…)가 통째로 안 켜져 0 으로 측정된다.
 */
const SLOT_CANDIDATES: Record<string, (string | null)[]> = {
  barrel: [null, 'br_long', 'br_catalyst', 'br_volatile'],
  handguard: [null, 'hg_fin', 'hg_relay', 'hg_martyr'],
  optic: [null, 'op_holywater', 'op_pact', 'op_soulmark'],
  stock: [null, 'st_fixed', 'st_buffer', 'st_stride'],
  // 탄창 칸은 비울 수 없다 (용량이 0 이 된다). 용량은 이 게임에서 가장 큰 지렛대라
  // 대표를 용량으로 벌린다: 3 / 5 / 6 / 8.
  magazine: ['mg_precision', 'mg_standard', 'mg_coolant', 'mg_drum'],
}

/**
 * 후보의 가중치.
 *   빈칸 확률은 '런 중반에 그 칸이 비어 있을 확률' 이다. 보상방 10회 × 3택에서
 *   플레이어가 7칸을 채워 가는 과정의 중간값으로 0.30 을 쓴다.
 *   나머지 0.70 은 드롭 확률(일반 45.0% · 희귀 37.8% · 영웅 15.5%)로 나눈다.
 */
const EMPTY_W = 0.3
function candidateWeights(slot: string): number[] {
  const mix = rarityMix()
  const s = mix.common + mix.uncommon + mix.rare
  const tiers = [mix.common / s, mix.uncommon / s, mix.rare / s]
  if (slot === 'magazine') {
    // 빈칸이 없으므로 표준(일반)이 빈칸 몫을 가져간다
    return [tiers[1]! * 0.5, EMPTY_W + tiers[0]!, tiers[2]!, tiers[1]! * 0.5].map(norm4)
  }
  return [EMPTY_W, tiers[0]! * 0.7, tiers[1]! * 0.7, tiers[2]! * 0.7]
}
function norm4(v: number): number {
  return v
}

export interface Ctx {
  loadout: Loadout
  weight: number
  seed: number
}

const SLOTS = ['barrel', 'handguard', 'optic', 'stock', 'magazine'] as const
type SlotName = (typeof SLOTS)[number]

/** 재려는 칸(hole)을 비우고 나머지를 전개한다. 반환은 (조합, 확률) 목록 */
export function enumerateLoadouts(hole: SlotName | null, stock: Record<string, number>): Ctx[] {
  const varying = SLOTS.filter((s) => s !== hole)
  const out: Ctx[] = []
  const rec = (i: number, picked: Record<string, string | null>, w: number): void => {
    if (i === varying.length) {
      out.push({ loadout: buildLoadout(picked, stock), weight: w, seed: out.length + 1 })
      return
    }
    const slot = varying[i]!
    const cands = SLOT_CANDIDATES[slot]!
    const ws = candidateWeights(slot)
    const tot = ws.reduce((a, b) => a + b, 0)
    for (let k = 0; k < cands.length; k += 1) {
      picked[slot] = cands[k]!
      rec(i + 1, picked, w * (ws[k]! / tot))
    }
    delete picked[slot]
  }
  rec(0, {}, 1)
  return out
}

function buildLoadout(picked: Record<string, string | null>, stock: Record<string, number>): Loadout {
  const l: Loadout = {
    barrel: null,
    handguard: null,
    optic: null,
    stock: null,
    magazine: STARTER_MAGAZINE,
    rails: [null, null],
    railSlots: 2,
    stash: [],
    specials: { ...stock },
    brass: 0,
  }
  for (const [slot, id] of Object.entries(picked)) {
    if (id === null) {
      if (slot === 'magazine') l.magazine = STARTER_MAGAZINE
      continue
    }
    const a = ATT_BY_ID[id]
    if (a === undefined) continue
    ;(l as unknown as Record<string, Attachment>)[slot] = a
  }
  return l
}

/** 조합에 재려는 부착물을 꽂은 사본 */
function withItem(l: Loadout, a: Attachment | null): Loadout {
  const c: Loadout = { ...l, rails: l.rails.slice(), specials: { ...l.specials }, stash: [] }
  if (a !== null) (c as unknown as Record<string, Attachment>)[a.slot === 'rail' ? 'optic' : a.slot] = a
  return c
}

// ---------------------------------------------------------------------------
// ③ 상태 — 격자가 아니라 그 빌드의 궤적
// ---------------------------------------------------------------------------
/** 적 패시브가 붙어 있을 확률 (run.ts: 위험도3 은 100%, 위험도2 는 30%) */
const P_PASSIVE = 0.25 * 1.0 + 0.5 * 0.3

function stateFor(l: Loadout, seed: number, passive: boolean): CombatState {
  const arch = ARCHETYPES[0]!
  const s = startCombat(
    l,
    {
      archetype: arch,
      passive: passive ? (PASSIVE_BY_ID['plated'] ?? null) : null,
      // 죽지 않을 만큼 크게 — 오버킬이 값을 잘라먹으면 비교가 망가진다
      maxHp: 1e12,
      hp: 1e12,
      speed: arch.speed,
      startDist: arch.startDist,
      label: '표적',
      bodyCount: 1,
      vuln: 0,
    },
    makeRng(seed),
  )
  s.heat = BASE_HEAT
  s.heatStartBase = BASE_HEAT
  return s
}

/**
 * 이 빌드가 한 전투에서 실제로 쓸 수 있는 사격 횟수.
 *   거리 / 사격 비용. 밀어냄·감속은 사격 안에서 일어나므로 궤적을 굴리며 반영된다.
 */
function actionBudget(s: CombatState): number {
  return Math.max(1, Math.min(6, Math.floor(s.distance / Math.max(1, s.fireCost)) + 1))
}

/**
 * 처리량 = 궤적을 따라 실제로 낸 피해 + 자원 환산.
 *   탄창 K개를 이어서 쏜다 (K = 행동 예산). 온도 이월·취약·감속처럼 **다음 사격에
 *   남는** 효과가 여기서 저절로 값이 된다 — 1탄창 측정에서는 전부 0 으로 보인다.
 *   탄피와 아낀 특수탄은 곧 다음 탄창의 피해이므로 소액으로 환산한다.
 */
/** 한 번의 측정 결과 — 피해와 탄약 소모를 **따로** 들고 나온다 */
export interface Tp {
  /** 처리량 (탄창당 피해 × 그 전투의 사격 수) + 탄피 환산 */
  value: number
  /** 이 전투에서 소모한 특수탄 수 */
  consumed: number
  /** 기본탄 한 발의 값 — 재고를 피해 단위로 옮기는 환율 */
  perShot: number
}

function throughput(l: Loadout, make: PlanFn, seed: number, passive: boolean): Tp {
  const s = cloneState(stateFor(l, seed, passive))
  const d0 = s.distance
  const brass0 = s.loadout.brass
  let had = 0
  for (const v of Object.values(s.specials)) had += v

  const K = actionBudget(s)
  let mags = 0
  let specialShots = 0
  for (let k = 0; k < K; k += 1) {
    if (s.distance <= 0) break
    // **매 탄창 용량을 다시 읽어 계획을 짠다.** 고정 배열을 slice 하면 전투 중에
    // 용량이 자라는 탄창(증축)의 성장분이 통째로 안 보인다 — 실측에서 증축 탄창이
    // 발동 7% · 값 −9.5% 로 나온 원인이 이것이었다.
    const p = make(s.cap).slice(0, s.cap)
    const evs = fire(s, p.length > 0 ? p : [basicRound()])
    for (const e of evs) if (e.t === 'shot' && e.round.special !== null) specialShots += 1
    mags += 1
  }
  if (mags === 0) return { value: 0, consumed: 0, perShot: 0 }

  const perMag = s.totalDamage / mags
  const spent = Math.max(0.5, (d0 - s.distance) / mags)
  const actions = d0 / spent
  const brassGain = s.loadout.brass - brass0
  s.loadout.brass = brass0
  let left = 0
  for (const v of Object.values(s.specials)) left += v
  // 탄약은 **처리량에 섞지 않는다.**
  //   비용으로 빼면 특수탄을 쓰는 구성이 언제나 손해가 되어, 최선 구성이 늘
  //   '기본탄만' 으로 수렴한다 (실측: 그 순간 탐식의 성궤가 −25.1% 로 죽었다).
  //   이득으로 더하면 재발사 카드가 두 번 계산된다 (실측 367.6%).
  //   그래서 소모량을 따로 들고 나가, 값을 낼 때 **없을 때와의 차분**으로만 쓴다.
  //   재발사로 늘어난 피해는 perMag 에, 덜 쓴 재고는 차분에 — 서로 겹치지 않는다.
  const consumed = had - left
  const perShot = perMag / Math.max(1, s.cap)
  void specialShots
  return {
    value: perMag * actions + brassGain * BRASS_IN_SHOTS * perShot,
    consumed,
    perShot,
  }
}

/** 용량을 받아 그 용량에 맞는 탄창 구성을 만든다 */
type PlanFn = (cap: number) => Round[]

// ---------------------------------------------------------------------------
// ② 탄창 구성 — 그 아이템이 제 값을 하는 구성을 플레이어가 짠다
// ---------------------------------------------------------------------------
/**
 * 환율 — 손으로 고른 계수가 아니라 **밴드에서 유도한다**.
 *   탄피 1 = (일반 특수탄의 값 ÷ 그 가격) 만큼의 기본탄. 일반 특수탄은 밴드상
 *   기본탄 ROUND_BANDS.common.mid 발어치이고 값은 priceLadder 가 정한다.
 *   예전에는 0.004 라는 눈대중 계수였다 — 실측에서 황동 부적이 +3.7% 로 나와
 *   커먼 밴드의 1/5 였는데, 그건 카드가 약한 게 아니라 환율이 12배 틀린 것이었다.
 */
const BRASS_IN_SHOTS = ROUND_BANDS.common.mid / priceLadder(16).common
/** 아낀 특수탄 1발 = 평균 등급(희귀) 한 발의 값 */
const SAVED_IN_SHOTS = ROUND_BANDS.uncommon.mid

const PROBE_STOCK: Record<string, number> = {
  sp_incendiary: 3,
  sp_ap: 3,
  sp_breach: 2,
  sp_solitary: 2,
  sp_marker: 2,
}

function basics(n: number): Round[] {
  const out: Round[] = []
  for (let i = 0; i < n; i += 1) out.push(basicRound())
  return out
}

/**
 * 대표 구성. 조건부 부착물의 조건을 하나도 빠짐없이 켜는 것이 목적이다.
 * 용량의 **함수**로 둔다 — 전투 중에 용량이 자라도 계획이 따라간다.
 */
const PLANS: PlanFn[] = [
  (cap) => basics(cap), // 기본탄만 — 청빈·중총열이 켜진다
  (cap) => (cap < 2 ? basics(cap) : [makeRound('sp_incendiary'), ...basics(cap - 2), makeRound('sp_ap')]), // 예열 → 타격
  (cap) => (cap < 2 ? basics(cap) : [...basics(cap - 1), makeRound('sp_breach')]), // 큰 것 마지막
  (cap) => (cap < 2 ? basics(cap) : [makeRound('sp_solitary'), ...basics(cap - 1)]), // 단독 종결
  (cap) => (cap < 2 ? basics(cap) : [...basics(cap - 2), makeRound('sp_ap'), basicRound()]), // 기본탄 마무리
  () => basics(2), // 일부러 적게 — 두 발의 계율
  (cap) =>
    cap < 3
      ? basics(cap)
      : [makeRound('sp_incendiary'), makeRound('sp_marker'), ...basics(cap - 3), makeRound('sp_breach')],
  (cap) =>
    cap < 3
      ? basics(cap)
      : [makeRound('sp_incendiary'), makeRound('sp_incendiary'), makeRound('sp_ap'), ...basics(cap - 3)],
]

/** 최선 구성 — **피해 기준**으로 고른다. 탄약 수지는 고른 뒤에 따로 센다 */
function bestThroughput(l: Loadout, seed: number, passive: boolean): Tp {
  let best: Tp = { value: 0, consumed: 0, perShot: 0 }
  for (const make of PLANS) {
    const v = throughput(l, make, seed, passive)
    if (v.value > best.value) best = v
  }
  return best
}

// ---------------------------------------------------------------------------
// 부착물 값
// ---------------------------------------------------------------------------
export interface ItemValue {
  id: string
  name: string
  rarity: Rarity
  slot: string
  value: number
  /** 조건이 한 번이라도 켜진 조합의 비율 — 0 이면 어떤 조합에서도 죽어 있다 */
  live: number
}

/**
 * 값 = (그 부착물을 꽂았을 때의 처리량 − 그 칸이 빈 채로 둔 처리량) / 빈 채 × 100.
 *   기준선을 '기준 빌드' 로 두면 그 기준이 무엇이냐에 값이 통째로 휘둘린다
 *   (실측: 총검 거치대가 연장 총열 기준에서 −42.9% 로 나왔다 — 값이 음수라는 뜻이
 *   아니라 '연장 총열보다 못하다' 는 뜻이었다). **그 칸만 비운** 것이 유일하게
 *   중립적인 기준이다.
 */
export function valueOfAttachment(a: Attachment, ctxs?: Ctx[]): ItemValue {
  const slot = (a.slot === 'rail' ? 'optic' : a.slot) as SlotName
  const list = ctxs ?? enumerateLoadouts(slot, PROBE_STOCK)
  let num = 0
  let den = 0
  let live = 0
  for (const c of list) {
    for (const passive of [false, true]) {
      const pw = c.weight * (passive ? P_PASSIVE : 1 - P_PASSIVE)
      const base = bestThroughput(withItem(c.loadout, null), c.seed, passive)
      const withA = bestThroughput(withItem(c.loadout, a), c.seed, passive)
      if (base.value <= 0) continue
      // ① 피해 증가율
      const dmgLift = (withA.value - base.value) / base.value
      // ② 아낀 특수탄 — 없을 때보다 덜 썼으면 그만큼 다음 전투의 화력이다
      const ammoLift = ((base.consumed - withA.consumed) * SAVED_IN_SHOTS * base.perShot) / base.value
      num += pw * (dmgLift + ammoLift) * 100
      den += pw
      if (dmgLift + ammoLift > 0.0005) live += pw
    }
  }
  return {
    id: a.id,
    name: a.name,
    rarity: a.rarity,
    slot: a.slot,
    value: den > 0 ? num / den : 0,
    live: den > 0 ? live / den : 0,
  }
}

// ---------------------------------------------------------------------------
// 탄 값
// ---------------------------------------------------------------------------
/**
 * 값 = 기본탄 한 발을 이 탄으로 바꿨을 때 **그 자리**가 몇 배가 되는가.
 *   자리는 전부 시도해 최선을 취한다 — 어디에 넣을지가 이 게임의 결정이므로,
 *   최선의 자리를 주지 않으면 탄이 아니라 플레이어의 실수를 재게 된다.
 */
function magDamage(l: Loadout, plan: Round[], seed: number, passive: boolean): number {
  const s = cloneState(stateFor(l, seed, passive))
  const d0 = s.distance
  const K = Math.min(2, actionBudget(s))
  let mags = 0
  for (let k = 0; k < K; k += 1) {
    // 2탄창 지평선: 첫 탄창에 재려는 탄을 넣고, 다음 탄창은 기본탄으로 채운다.
    // 표식(취약)·냉각(감속)·온도 이월처럼 **다음 사격에 남는** 효과가 여기서 값이 된다.
    fire(s, k === 0 ? plan.slice(0, s.cap) : basics(s.cap))
    mags += 1
  }
  // 거리 이득(밀어냄·감속)은 곧 사격 한 번이다. 같은 단위로 환산해 더한다.
  const spent = d0 - s.distance
  const normal = mags * s.fireCost
  const savedActions = (normal - spent) / Math.max(1, s.fireCost)
  return s.totalDamage + savedActions * (s.totalDamage / Math.max(1, mags))
}

export function valueOfRound(id: string, ctxs?: Ctx[]): ItemValue {
  const def = SPECIALS.find((d) => d.id === id)!
  const list = ctxs ?? enumerateLoadouts(null, { [id]: 3 })
  let num = 0
  let den = 0
  let live = 0
  for (const c of list) {
    for (const passive of [false, true]) {
      const pw = c.weight * (passive ? P_PASSIVE : 1 - P_PASSIVE)
      const l: Loadout = { ...c.loadout, specials: { [id]: 3 }, rails: c.loadout.rails.slice(), stash: [] }
      const cap = stateFor(l, c.seed, passive).cap
      const base = magDamage(l, basics(cap), c.seed, passive)
      if (base <= 0) continue
      const per = base / cap // 기본탄 한 발의 값
      let best = base
      for (let pos = 0; pos < cap; pos += 1) {
        const plan = basics(cap)
        plan[pos] = makeRound(id)
        const v = magDamage(l, plan, c.seed, passive)
        if (v > best) best = v
      }
      // 그 자리가 몇 배가 되었는가: (순증 / 기본탄 한 발) + 1
      num += pw * ((best - base) / per + 1)
      den += pw
      if (best > base * 1.0005) live += pw
    }
  }
  return {
    id: def.id,
    name: def.name,
    rarity: def.rarity,
    slot: 'round',
    value: den > 0 ? num / den : 0,
    live: den > 0 ? live / den : 0,
  }
}

// ---------------------------------------------------------------------------
// 선택이 진짜 저울질인가 — 두 가지 눈금
// ---------------------------------------------------------------------------
/**
 * ⑤ 상태 커버리지.
 *   조합마다 '지금 넣을 최선의 한 발' 을 뽑아, **서로 다른 승자가 몇 종인지** 센다.
 *   1종이면 정답이 하나라는 뜻이다 — 탄이 16종이어도 결정은 없다.
 *   이 게임의 페이오프는 (탄의 성질 × 자리) 라는 랭크 1 곱이라 가만 두면 반드시
 *   한 종으로 수렴한다. 그것을 깨는 것이 조건부 탄(유일·초탄·냉동·방열)의 존재 이유다.
 */
export function coverage(ids: string[], ctxs: Ctx[]): { winner: Record<string, number>; distinct: number } {
  const winner: Record<string, number> = {}
  for (const c of ctxs) {
    const l: Loadout = { ...c.loadout, rails: c.loadout.rails.slice(), stash: [] }
    const cap = stateFor(l, c.seed, false).cap
    let bestId = ''
    let bestV = -Infinity
    for (const id of ids) {
      const li: Loadout = { ...l, specials: { [id]: 3 } }
      const base = magDamage(li, basics(cap), c.seed, false)
      let v = base
      for (let pos = 0; pos < cap; pos += 1) {
        const plan = basics(cap)
        plan[pos] = makeRound(id)
        const d = magDamage(li, plan, c.seed, false)
        if (d > v) v = d
      }
      if (v - base > bestV) {
        bestV = v - base
        bestId = id
      }
    }
    winner[bestId] = (winner[bestId] ?? 0) + c.weight
  }
  return { winner, distinct: Object.keys(winner).length }
}

/**
 * ⑥ 순서 민감도 — 같은 탄 묶음의 최선/최악 배열 비.
 *   1.0 이면 어떻게 넣든 같다는 뜻이고, 그러면 이 게임의 유일한 결정이 사라진다.
 *   첫 탄창(차가운 총)과 이월된 탄창(더운 총)을 **따로** 잰다 — 온도가 높을수록
 *   배열 격차가 줄어드는 것이 이월 메커닉의 대가이고, 안 재면 그 대가가 안 보인다.
 */
export function orderSensitivity(ids: string[], l: Loadout, startHeat: number): number {
  const s = cloneState(stateFor(l, 99, false))
  s.enemy.hp = 1e12
  s.enemy.maxHp = 1e12
  s.heat = startHeat
  s.heatStartBase = startHeat
  const cap = Math.min(s.cap, 5)
  const plan: Round[] = ids.map((id) => makeRound(id))
  while (plan.length < cap) plan.push(basicRound())
  const use = plan.slice(0, cap)
  let best = -Infinity
  let worst = Infinity
  for (const p of permute(use)) {
    const c = cloneState(s)
    c.dryRun = true
    let total = 0
    for (const ev of fire(c, p)) if (ev.t === 'shot') total += ev.damage
    if (total > best) best = total
    if (total < worst) worst = total
  }
  return worst > 0 ? best / worst : 1
}

function permute<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a]
  const out: T[][] = []
  for (let i = 0; i < a.length; i += 1) {
    for (const p of permute(a.slice(0, i).concat(a.slice(i + 1)))) out.push([a[i]!, ...p])
  }
  return out
}

/**
 * 이월 정상상태 온도 — H* = BASE_HEAT + ρ(H* + Σg). 몇 탄창 굴려 수렴시킨다.
 * 상수를 박아 두면 탄이 약해졌을 때 낡은 값으로 재게 되어 잘못된 신호가 나온다.
 */
export function steadyHeat(ids: string[], l: Loadout): number {
  const stock: Record<string, number> = {}
  for (const id of ids) stock[id] = (stock[id] ?? 0) + 1
  const li: Loadout = { ...l, specials: { ...stock }, rails: l.rails.slice(), stash: [] }
  const s = cloneState(stateFor(li, 77, false))
  s.enemy.hp = 1e12
  s.enemy.maxHp = 1e12
  const cap = Math.min(s.cap, 5)
  for (let i = 0; i < 8; i += 1) {
    const plan: Round[] = ids.map((id) => makeRound(id))
    while (plan.length < cap) plan.push(basicRound())
    s.specials = { ...stock }
    fire(s, plan.slice(0, cap))
  }
  return s.heatStartBase
}

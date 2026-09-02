// ============================================================================
// 부착물 가치 분석기 — 탄과 같은 잣대를 부착물 55종에 댄다.
//
//   값 = (이 부착물을 달았을 때의 처리량 − 안 달았을 때) / 안 달았을 때  → 증가율(%)
//   처리량은 2탄창 지평선(다음 사격에 남는 효과를 놓치지 않으려고)이고,
//   거리 이득(사격 비용·시작 거리·밀어냄)은 damage 로 환산해 같은 단위로 만든다.
//
//   부착물마다 '제 값을 하는 탄창' 이 다르다(특수탄 전용·기본탄 전용·마지막 칸 전용…).
//   그래서 대표 탄창 몇 개를 돌려 **최선**을 취한다 — 탄을 잴 때 최선의 자리를 준 것과 같다.
//
//   밴드: 등급이 다를 때만 값이 유의미하게 달라야 한다 (한 단계 ×1.7).
// ============================================================================
import type { Attachment, CombatState, Loadout, Round } from '../core/types'
import { BASE_HEAT } from '../core/types'
import { makeRng } from '../core/rng'
import { basicRound, cloneState, fire, makeRound, startCombat } from '../core/combat'
import { ATTACHMENTS, ATT_BY_ID, STARTER_MAGAZINE } from '../core/data/attachments'
import { ARCHETYPES, PASSIVE_BY_ID } from '../core/data/enemies'

interface Ref {
  name: string
  heat0: number
  dist: number
  /** 적이 패시브를 지녔는가 — '패시브 상대' 조건부(이단 감식경)를 켠다 */
  passive?: boolean
}

const GRID: Ref[] = [
  { name: '냉', heat0: BASE_HEAT, dist: 26 },
  { name: '중', heat0: 8, dist: 20 },
  { name: '열', heat0: 18, dist: 12 },
  // 근접 상태가 없으면 '거리 10m 이하' 조건부(총검 거치대 등)가 전부 0.0 으로 죽는다
  { name: '근', heat0: 12, dist: 8 },
  // 패시브 없는 적만 재면 '적이 패시브를 지녔으면' 조건부가 통째로 0.0 이 된다
  { name: '패시브', heat0: 8, dist: 20, passive: true },
]

/** 등급별 목표 증가율(%) — 겹치지 않고 한 단계마다 ×1.7 */
/**
 * 사다리의 **모양**(한 단계 ×1.7, 겹치지 않음)이 설계 규칙이고, 절대 눈금은 실측에서 온다.
 * 처음에 4~11/11~20/… 로 잡았다가 중앙값이 30% 대로 나와 전원 '초과' 가 됐다 —
 * 그건 카탈로그가 틀린 게 아니라 자가 잡힌 것이었다.
 */
const BANDS: Record<string, [number, number]> = {
  common: [12, 24],
  uncommon: [24, 41],
  rare: [41, 70],
  relic: [70, 119],
}

/**
 * 기준 빌드 — 각 부위에 **일반 등급 하나씩**. 플레이어가 실제로 마주하는 결정은
 * "빈 총에 뭘 달까" 가 아니라 "지금 달린 것보다 나은가" 다. 맨총 대비로 재면
 * 아무 데미지 부착물이나 +300% 로 나와 밴드가 의미를 잃는다 (실측 볼터의 원형 367%).
 */
const REFERENCE: Record<string, string> = {
  barrel: 'br_long',
  handguard: 'hg_relay',
  optic: 'op_holywater',
  stock: 'st_fixed',
  magazine: 'mg_standard',
}

const STOCK: Record<string, number> = {
  sp_incendiary: 2,
  sp_ap: 2,
  sp_breach: 1,
  sp_solitary: 1,
}

function loadoutWith(a: Attachment | null, emptySlot?: string): Loadout {
  const l: Loadout = {
    barrel: null,
    handguard: null,
    optic: null,
    stock: null,
    magazine: STARTER_MAGAZINE,
    rails: [null, null],
    railSlots: 2,
    stash: [],
    specials: { ...STOCK },
    brass: 0,
  }
  for (const [slot, id] of Object.entries(REFERENCE)) {
    if (slot === emptySlot) continue
    const ref = ATT_BY_ID[id]
    if (ref !== undefined) (l as unknown as Record<string, Attachment>)[slot] = ref
  }
  // 탄창 칸은 비울 수 없다 (용량이 0 이 된다) — 기본 탄창으로 되돌린다
  if (emptySlot === 'magazine') l.magazine = STARTER_MAGAZINE
  if (a !== null && a.slot !== 'rail') {
    ;(l as unknown as Record<string, Attachment>)[a.slot] = a
  }
  return l
}

function stateFor(ref: Ref, a: Attachment | null, emptySlot?: string): CombatState {
  const arch = ARCHETYPES[0]!
  const s = startCombat(
    loadoutWith(a, emptySlot),
    {
      archetype: arch,
      passive: ref.passive === true ? (PASSIVE_BY_ID['plated'] ?? null) : null,
      maxHp: 1e12,
      hp: 1e12,
      speed: arch.speed,
      startDist: ref.dist,
      label: '표적',
      bodyCount: 1,
      vuln: 0,
    },
    makeRng(0x4a11),
  )
  // s.distance 는 **덮지 않는다.** 덮으면 고정 개머리판·완충기 같은 시작 거리 보정이
  // 통째로 지워져 전부 0.0 으로 측정된다 (실측: 개머리판 7종이 전원 0.0 이었다).
  s.heatStartBase = ref.heat0
  s.heat = ref.heat0
  return s
}

/** 대표 탄창들 — 부착물마다 제 값을 하는 구성이 다르다 */
function plansFor(cap: number): Round[][] {
  const basics = (n: number): Round[] => {
    const out: Round[] = []
    for (let i = 0; i < n; i += 1) out.push(basicRound())
    return out
  }
  const out: Round[][] = []
  out.push(basics(cap)) // 기본탄만 (실측 탄창의 40% 가 이렇다)
  if (cap >= 3) {
    out.push([makeRound('sp_incendiary'), ...basics(cap - 2), makeRound('sp_ap')]) // 예열 → 타격
    out.push([...basics(cap - 1), makeRound('sp_breach')]) // 큰 것 하나 마지막
    out.push([makeRound('sp_solitary'), ...basics(cap - 1)]) // 단독 종결
    // 특수탄 다수 — '탄창에 특수탄 2발/3발 이상' 조건부(열화상·삼위일체·이단 감식경)를 켠다
    out.push([makeRound('sp_incendiary'), makeRound('sp_ap'), ...basics(Math.max(0, cap - 3)), makeRound('sp_breach')])
    out.push([makeRound('sp_incendiary'), makeRound('sp_incendiary'), makeRound('sp_ap'), ...basics(Math.max(0, cap - 3))])
    // 마지막 칸이 기본탄 / 특수탄 — '마지막 탄' 조건부(성수 앰플·죽음의 성사·유예)를 가른다
    out.push([...basics(Math.max(0, cap - 2)), makeRound('sp_ap'), basicRound()])
    // 일부러 적게 장전 — '용량보다 적게 정확히 2발' 같은 조건을 켠다
    out.push(basics(2))
  } else {
    out.push([makeRound('sp_ap'), ...basics(cap - 1)])
  }
  return out
}

/**
 * 처리량 = 탄창당 피해 × 그 전투에서 쓸 수 있는 사격 횟수.
 *   행동 수 = 시작 거리 / 탄창당 실제 소모 거리. 이 한 식에 시작 거리·사격 비용·
 *   적 속도·밀어냄이 전부 들어온다 (예전처럼 따로 더하면 이중 계산이 난다).
 *   탄피는 곧 다음 부착물이므로 소액으로 환산한다 (harness.firepower 와 같은 잣대).
 */
function throughput(ref: Ref, a: Attachment | null, plan: Round[], emptySlot?: string): number {
  const s = cloneState(stateFor(ref, a, emptySlot))
  // dryRun 을 끈다 — 탄피 훅(황동 부적)이 dryRun 가드에 막혀 0 으로 측정된다.
  // 이 상태는 복제본이라 실제 런에 영향이 없다.
  const d0 = s.distance
  const brass0 = s.loadout.brass
  const p = plan.slice(0, s.cap)
  fire(s, p)
  const follow: Round[] = []
  for (let i = 0; i < s.cap; i += 1) follow.push(basicRound())
  fire(s, follow)
  const perMag = s.totalDamage / 2
  const spentPerMag = Math.max(0.5, (d0 - s.distance) / 2)
  const actions = d0 / spentPerMag
  const brassGain = s.loadout.brass - brass0
  s.loadout.brass = brass0
  // 아낀/보급받은 특수탄은 곧 다음 탄창의 피해다. 이걸 안 세면 병참 렌즈·탄띠 걸이가
  // 2탄창 창 안에서 값이 0 으로 보인다 (실측 둘 다 0.0 이었다).
  let left = 0
  for (const v of Object.values(s.specials)) left += v
  let had = 0
  for (const v of Object.values(STOCK)) had += v
  const spentSpecials = had - left
  const planned = p.filter((r) => r.special !== null).length + 0
  const saved = planned - spentSpecials
  return perMag * actions + brassGain * perMag * 0.004 + saved * perMag * 0.12
}

function bestOver(ref: Ref, a: Attachment | null, emptySlot?: string): number {
  const probe = stateFor(ref, a, emptySlot)
  let best = -Infinity
  for (const plan of plansFor(probe.cap)) {
    const v = throughput(ref, a, plan, emptySlot)
    if (v > best) best = v
  }
  return best
}

const pad = (s: string, n: number): string => {
  let o = s
  while (o.length < n) o += ' '
  return o
}
const padS = (s: string, n: number): string => {
  let o = s
  while (o.length < n) o = ' ' + o
  return o
}
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '—')

export function analyzeAttachments(): string {
  const L: string[] = []
  const line = (): void => {
    L.push('─'.repeat(88))
  }

  L.push('════ 부착물 가치 분석 ════')
  L.push('값 = 처리량 증가율(%). 2탄창 지평선 · 거리 이득 환산 · 대표 탄창 4종 중 최선.')
  L.push('밴드: 일반 4~11 · 희귀 11~20 · 영웅 20~34 · 유물 34~58 (한 단계 ×1.7)')
  L.push('')

  // 기준선은 **그 칸만 비운** 기준 빌드다. 다른 부착물로 채워 두고 재면 그 부착물의
  // 값까지 빼게 되어(자기 자신을 교체하면 0.0) 밴드가 기준 선택에 휘둘린다 —
  // 실측에서 총검 거치대가 −42.9% 로 나왔는데, 이는 '연장 총열보다 못하다' 는 뜻이지
  // '값이 음수다' 가 아니었다.
  const baseline: Record<string, number> = {}
  for (const ref of GRID) {
    for (const slot of Object.keys(REFERENCE)) {
      baseline[ref.name + '/' + slot] = bestOver(ref, null, slot)
    }
  }

  const rows: Array<{ a: Attachment; vals: number[]; avg: number }> = []
  for (const a of ATTACHMENTS) {
    const slot = a.slot === 'rail' ? 'optic' : a.slot
    const vals = GRID.map((ref) => {
      const b = baseline[ref.name + '/' + slot]!
      return ((bestOver(ref, a, slot) - b) / b) * 100
    })
    rows.push({ a, vals, avg: vals.reduce((x, y) => x + y, 0) / vals.length })
  }

  // ① 부위·등급별 표
  L.push('① 증가율 (%) — 상태별')
  line()
  L.push('   ' + pad('이름', 16) + pad('부위', 11) + pad('등급', 10) + GRID.map((g) => padS(g.name, 8)).join('') + padS('평균', 9))
  const order = ['barrel', 'handguard', 'optic', 'stock', 'magazine'] as const
  for (const slot of order) {
    for (const r of rows.filter((x) => x.a.slot === slot).sort((x, y) => y.avg - x.avg)) {
      L.push(
        '   ' + pad(r.a.name, 16) + pad(r.a.slot, 11) + pad(r.a.rarity, 10) +
          r.vals.map((v) => padS(f1(v), 8)).join('') + padS(f1(r.avg), 9),
      )
    }
  }
  L.push('')

  // ② 밴드 판정
  L.push('② 밴드 판정 — 등급이 값을 예측하는가')
  line()
  let ok = 0
  const bad: string[] = []
  for (const r of rows.sort((x, y) => y.avg - x.avg)) {
    const [lo, hi] = BANDS[r.a.rarity] ?? [0, 999]
    const mark = r.avg < lo ? '⬇ 미달' : r.avg > hi ? '⬆ 초과' : '✅'
    if (mark === '✅') ok += 1
    else bad.push(pad(r.a.name, 16) + pad(r.a.rarity, 10) + padS(f1(r.avg), 8) + '   목표 ' + lo + '~' + hi + '  ' + mark)
  }
  for (const b of bad) L.push('   ' + b)
  L.push('   밴드 안 ' + ok + ' / ' + rows.length + '종')
  L.push('')

  // ③ 등급별 통계
  L.push('③ 등급별 — 평균이 단조 증가하고 퍼짐이 작아야 한다')
  line()
  for (const rar of ['common', 'uncommon', 'rare', 'relic']) {
    const v = rows.filter((x) => x.a.rarity === rar).map((x) => x.avg)
    if (v.length === 0) continue
    const avg = v.reduce((x, y) => x + y, 0) / v.length
    L.push(
      '   ' + pad(rar, 10) + 'n=' + pad(String(v.length), 4) +
        '최저 ' + padS(f1(Math.min(...v)), 8) + '  평균 ' + padS(f1(avg), 8) +
        '  최고 ' + padS(f1(Math.max(...v)), 8),
    )
  }
  L.push('')

  // ④ 죽은 부착물
  L.push('④ 효과가 거의 없는 부착물 (증가율 1% 미만) — 있으면 그 칸이 낭비다')
  line()
  const dead = rows.filter((x) => x.avg < 1)
  for (const r of dead) L.push('   ' + pad(r.a.name, 16) + pad(r.a.slot, 11) + pad(r.a.rarity, 10) + padS(f1(r.avg), 8))
  if (dead.length === 0) L.push('   없음')

  return L.join('\n')
}

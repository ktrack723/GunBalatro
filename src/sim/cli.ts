// `npm run sim` 진입점 — 봇으로 런을 대량 시뮬레이션하고 밸런스 표를 콘솔에 찍는다.
// 인자: --runs=N --skill=greedy|optimal|both --stake=N --seed=N --order-analysis=on|off
//       (기본 200 / both / 1 / 1 / on).
// 게임 로직은 전혀 만들지 않는다. 읽고, 세고, 표로 정렬해서 보여주기만 한다.
//
// 표 구성 — 앞의 다섯은 밸런스 진단, 뒤의 넷은 JUSTIFICATION.md §5 성공 기준 계측이다.
//   ①성적 ②생존율 ③사망분포 ④부착물 채택 ⑤아키타입
//   ⑥탄창 채택 ⑦부위별 채택 ⑧순서 민감도 ⑨갈림길 선택 ⑩성공 기준 자동 판정

import { FINAL_SECTOR } from '../core/run'
import { ATTACHMENTS, ATT_BY_ID } from '../core/data/attachments'
import { MAGAZINES, MAG_BY_ID } from '../core/data/magazines'
import { deathDistribution, simulateMany, summarize, survivalCurve } from './harness'
import type { DoorChoice, OrderSample, RunResult, Summary } from './harness'
import type { BotSkill } from './bot'
import type { SlotKind } from '../core/types'

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

interface Options {
  runs: number
  skills: BotSkill[]
  stake: number
  seed: number
  /** 순열 분석(⑧)을 돌릴지. 기본 켜짐 — 표본 수는 하네스가 스트라이드로 묶는다 */
  orderAnalysis: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const opt: Options = {
    runs: 200,
    skills: ['greedy', 'optimal'],
    stake: 1,
    seed: 1,
    orderAnalysis: true,
  }

  for (const raw of argv) {
    // 값 없는 플래그(--order-analysis / --no-order-analysis)도 받는다.
    if (raw === '--order-analysis') {
      opt.orderAnalysis = true
      continue
    }
    if (raw === '--no-order-analysis') {
      opt.orderAnalysis = false
      continue
    }

    const m = /^--([a-zA-Z-]+)=(.*)$/.exec(raw)
    if (m === null) continue
    const key = m[1]
    const value = m[2]

    if (key === 'runs') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n) && n > 0) opt.runs = n
    } else if (key === 'stake') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n) && n >= 1) opt.stake = Math.min(8, n)
    } else if (key === 'seed') {
      const n = Number.parseInt(value, 10)
      if (Number.isFinite(n)) opt.seed = n
    } else if (key === 'skill') {
      if (value === 'greedy') opt.skills = ['greedy']
      else if (value === 'optimal') opt.skills = ['optimal']
      else opt.skills = ['greedy', 'optimal']
    } else if (key === 'order-analysis') {
      opt.orderAnalysis = value !== 'off' && value !== 'false' && value !== '0'
    }
  }
  return opt
}

// ---------------------------------------------------------------------------
// 출력 유틸 — 한글은 터미널에서 2칸을 먹으므로 표시폭으로 맞춘다
// ---------------------------------------------------------------------------

function width(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    // 한글·한자·전각 기호 구간만 2칸으로 센다 (그 외는 1칸).
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    w += wide ? 2 : 1
  }
  return w
}

function padEndW(s: string, n: number): string {
  const gap = n - width(s)
  return gap > 0 ? s + ' '.repeat(gap) : s
}

function padStartW(s: string, n: number): string {
  const gap = n - width(s)
  return gap > 0 ? ' '.repeat(gap) + s : s
}

const out: string[] = []
function line(s = ''): void {
  out.push(s)
}
function flush(): void {
  process.stdout.write(out.join('\n') + '\n')
  out.length = 0
}

function pct(x: number): string {
  return Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—'
}

/** 0~1 값을 20칸 막대로 */
function bar(x: number, cells = 20): string {
  const n = Math.max(0, Math.min(cells, Math.round(x * cells)))
  return '█'.repeat(n) + '·'.repeat(cells - n)
}

/** 정렬된 표본에서 분위수 (선형 보간 없이 가장 가까운 순위) */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[i]
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

const SKILL_NAME: Record<BotSkill, string> = { greedy: '보통(greedy)', optimal: '숙련(optimal)' }

// ---------------------------------------------------------------------------
// 표 1 — 스킬별 승률 / 도달 섹터
// ---------------------------------------------------------------------------

function tableOverview(runs: Map<BotSkill, { results: RunResult[]; summary: Summary }>): void {
  line('① 스킬별 성적')
  line('─'.repeat(72))
  line(
    padEndW('스킬', 16) +
      padStartW('런', 6) +
      padStartW('승률', 8) +
      padStartW('중앙 섹터', 12) +
      padStartW('평균 섹터', 12) +
      padStartW('최고 온도(중앙)', 18),
  )

  for (const [skill, data] of runs) {
    const s = data.summary
    const avg =
      data.results.reduce((acc, r) => acc + r.reachedSector, 0) / Math.max(1, data.results.length)
    const heats = data.results.map((r) => r.peakHeat).sort((a, b) => a - b)
    const medHeat = heats.length === 0 ? 0 : heats[Math.floor(heats.length / 2)]
    line(
      padEndW(SKILL_NAME[skill], 16) +
        padStartW(String(s.runs), 6) +
        padStartW(pct(s.winRate), 8) +
        padStartW(s.medianSector.toFixed(1), 12) +
        padStartW(avg.toFixed(2), 12) +
        padStartW(medHeat.toFixed(1), 18),
    )
  }
  line()

  line('   도달 섹터 히스토그램 (런이 "끝난" 섹터)')
  for (const [skill, data] of runs) {
    const h = data.summary.sectorHistogram
    const total = Math.max(1, data.summary.runs)
    const cells: string[] = []
    for (let s = 1; s <= FINAL_SECTOR; s += 1) {
      cells.push(padStartW(String(h[s]), 5))
    }
    line('   ' + padEndW(SKILL_NAME[skill], 16) + cells.join('') + '   (n=' + total + ')')
  }
  const header: string[] = []
  for (let s = 1; s <= FINAL_SECTOR; s += 1) header.push(padStartW('S' + s, 5))
  line('   ' + padEndW('', 16) + header.join(''))
  line()
}

// ---------------------------------------------------------------------------
// 표 2 — 섹터별 생존율 곡선 (숙련도가 벌어주는 여유)
// ---------------------------------------------------------------------------

function tableSurvival(runs: Map<BotSkill, { results: RunResult[]; summary: Summary }>): void {
  line('② 섹터별 생존율 — 이 격차가 "숙련도가 벌어주는 여유"다')
  line('─'.repeat(72))

  const curves = new Map<BotSkill, number[]>()
  for (const [skill, data] of runs) curves.set(skill, survivalCurve(data.results))

  const greedy = curves.get('greedy')
  const optimal = curves.get('optimal')

  line(
    padEndW('섹터', 6) +
      padStartW('보통', 8) +
      padStartW('숙련', 8) +
      padStartW('격차', 8) +
      '  ' +
      padEndW('보통', 22) +
      padEndW('숙련', 22),
  )

  for (let s = 1; s <= FINAL_SECTOR; s += 1) {
    const g = greedy ? greedy[s] : Number.NaN
    const o = optimal ? optimal[s] : Number.NaN
    const gap = Number.isFinite(g) && Number.isFinite(o) ? o - g : Number.NaN
    line(
      padEndW('S' + s, 6) +
        padStartW(Number.isFinite(g) ? pct(g) : '—', 8) +
        padStartW(Number.isFinite(o) ? pct(o) : '—', 8) +
        padStartW(Number.isFinite(gap) ? (gap >= 0 ? '+' : '') + pct(gap) : '—', 8) +
        '  ' +
        padEndW(Number.isFinite(g) ? bar(g) : '', 22) +
        padEndW(Number.isFinite(o) ? bar(o) : '', 22),
    )
  }
  line()
}

// ---------------------------------------------------------------------------
// 표 3 — 사망 노드 분포
// ---------------------------------------------------------------------------

function tableDeaths(runs: Map<BotSkill, { results: RunResult[]; summary: Summary }>): void {
  line('③ 사망 노드 분포 (어느 섹터 · 어느 노드에서 죽는가)')
  line('─'.repeat(72))

  const all: RunResult[] = []
  for (const [, data] of runs) all.push(...data.results)

  const dist = deathDistribution(all)
  const rows = Object.keys(dist)
    .map((k) => ({ node: k, n: dist[k] }))
    .sort((a, b) => b.n - a.n)

  const deaths = rows.reduce((acc, r) => acc + r.n, 0)
  if (deaths === 0) {
    line('   사망 없음.')
    line()
    return
  }

  line(padEndW('노드', 16) + padStartW('사망', 8) + padStartW('비중', 8) + '  분포')
  for (const r of rows.slice(0, 14)) {
    line(
      padEndW(r.node, 16) +
        padStartW(String(r.n), 8) +
        padStartW(pct(r.n / deaths), 8) +
        '  ' +
        bar(r.n / deaths, 24),
    )
  }

  // 노드 종류별 요약 — "보스에서 벽을 만나는가, 일반 전투에서 마모되는가"
  let boss = 0
  let combat = 0
  for (const r of rows) {
    if (r.node.endsWith(':boss')) boss += r.n
    else combat += r.n
  }
  line()
  line(
    '   보스 노드 사망 ' +
      pct(boss / deaths) +
      ' · 일반 전투 사망 ' +
      pct(combat / deaths) +
      ' (총 ' +
      deaths +
      '회)',
  )
  line()
}

// ---------------------------------------------------------------------------
// 표 4 — 부착물 채택 빈도 (상위 15 / 하위 15)
// ---------------------------------------------------------------------------

function tableAdoption(all: readonly RunResult[]): void {
  line('④ 부착물 채택 빈도 — 최종 빌드에 남아 있던 비율')
  line('─'.repeat(72))

  const freq = summarize(all).buildFrequency
  const rows = ATTACHMENTS.map((a) => ({
    id: a.id,
    name: a.name,
    rarity: a.rarity,
    slot: a.slot,
    n: freq[a.id] ?? 0,
  })).sort((x, y) => y.n - x.n || (x.id < y.id ? -1 : 1))

  const total = Math.max(1, all.length)
  const show = (label: string, list: typeof rows): void => {
    line('   ' + label)
    line(
      '   ' +
        padEndW('부착물', 22) +
        padEndW('부위', 12) +
        padEndW('레어도', 10) +
        padStartW('채택', 6) +
        padStartW('비율', 8),
    )
    for (const r of list) {
      line(
        '   ' +
          padEndW(r.name, 22) +
          padEndW(r.slot, 12) +
          padEndW(r.rarity, 10) +
          padStartW(String(r.n), 6) +
          padStartW(pct(r.n / total), 8),
      )
    }
    line()
  }

  show('상위 15', rows.slice(0, 15))
  show('하위 15 (최종 빌드까지 살아남지 못한 부착물)', rows.slice(-15).reverse())

  const dead = rows.filter((r) => r.n === 0)
  line('   채택 0회: ' + dead.length + '종 / ' + ATTACHMENTS.length + '종')
  if (dead.length > 0) line('   → ' + dead.map((r) => r.name).join(', '))
  line()

  // 일반(common)은 "섹터 4에서 낡도록" 설계됐다(ATTACHMENTS.md §1). 0회여도 정상이다.
  // 진짜 신호는 일반이 아닌데도 아무도 안 쓰는 부착물이다.
  const suspects = rows.filter((r) => r.rarity !== 'common' && r.n === 0)
  line('   ※ 일반 등급은 후반에 교체되도록 설계된 층이라 0회가 정상이다.')
  line(
    '   ※ 점검 대상(일반 아닌데 채택 0회): ' +
      (suspects.length === 0 ? '없음' : suspects.map((r) => r.name + '(' + r.rarity + ')').join(', ')),
  )
  line()
}


// ---------------------------------------------------------------------------
// 표 5 — 클리어 런의 빌드 아키타입 추정 (ATTACHMENTS.md §8)
//
//   분류 규칙 (예전의 "키를 하나라도 가지면 그 아키타입"은 과대 분류였다):
//     ① **탄창 앵커** — 그 아키타입이 구조적으로 요구하는 탄창을 껴야 인정한다.
//        (예: 폭 빌드는 cap≥7 탄창 — 8발을 얕게 굴리는 것이 정의이므로 5연발로는 성립 불가)
//     ② **핵심 부착물 2개 이상** — 1개는 우연이다. 2개부터가 "그 빌드를 하고 있다"는 뜻.
//        (도박만 예외로 1개 — 탄창 자체가 유일무이한 엔진이라 부품이 2개뿐이다)
//   둘 중 하나라도 못 넘기면 **기타(잡탕)** 다. 기타가 많다는 것은 나쁜 신호가 아니라
//   "설계가 의도한 착지점에 안 내렸다"는 정직한 신호다.
// ---------------------------------------------------------------------------

interface ArchetypeDef {
  name: string
  /** 앵커: 이 탄창들 중 하나를 껴야 인정 */
  mags: string[]
  /** 앵커를 한 줄로 (표에 그대로 찍는다) */
  magNote: string
  /** 핵심 부착물 id */
  core: string[]
  /** 인정에 필요한 최소 핵심 부착물 수 */
  min: number
}

const BUILD_ARCHETYPES: ArchetypeDef[] = [
  {
    name: '1. 예열-피니셔',
    mags: ['m1', 'm6', 'm7', 'm8', 'm10'],
    magNote: 'cap 4~6',
    // 연쇄 점화(소이탄 → 남은 탄 온도 2배)는 §8 표에 폭 빌드로 적혀 있지만
    // 기계적으로는 "소이로 예열한다" 그 자체다 — 두 아키타입이 공유하는 부품으로 둔다.
    core: [
      'hg_incendiary_catalyst',
      'hg_chain_ignition',
      'rl_death_rite',
      'br_heavy_barrel',
      'rl_holy_water',
      'hg_heat_fin',
    ],
    min: 2,
  },
  {
    name: '2. 폭(Width)',
    mags: ['m2', 'm5'],
    magNote: 'cap ≥ 7',
    core: ['br_judgment', 'hg_chain_ignition', 'hg_gas_tube', 'hg_martyr_forge', 'st_spare_mag'],
    min: 2,
  },
  {
    name: '3. 깊이(Depth)',
    mags: ['m4', 'm9'],
    magNote: 'cap ≤ 3 (도박 제외)',
    core: ['rl_unstable_core', 'op_soul_mark', 'hg_furnace_heart', 'st_chain_of_penance'],
    min: 2,
  },
  {
    name: '4. 도박',
    mags: ['m3'],
    magNote: '탐식의 성궤',
    core: ['rl_gambler_litany'],
    min: 1,
  },
  {
    name: '5. 축성 콤보',
    mags: ['m6'],
    magNote: '성궤 탄창',
    core: ['op_sanctify_lens', 'br_purity_catalyst', 'rl_trinity_sigil', 'br_name_of_god'],
    min: 2,
  },
  {
    name: '6. 자원',
    // 자원 빌드는 탄창에 요구하는 것이 "방해하지 말 것" 뿐이다 —
    // 거리 비용을 깎거나(m8·m9) 규칙을 바꾸지 않는(m1·m7) 탄창을 앵커로 잡는다.
    mags: ['m1', 'm7', 'm8', 'm9'],
    magNote: '거리비용 중립·감소',
    core: [
      'st_infinite_magazine',
      'st_giant_stride',
      'op_rangefinder',
      'st_buffer',
      'op_ballistic_computer',
    ],
    min: 2,
  },
  {
    name: '7. 등급 배열',
    mags: ['m1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8', 'm10'],
    magNote: 'cap ≥ 3',
    core: [
      'rl_descend_litany',
      'rl_ascend_litany',
      'hg_backflow_valve',
      'hg_ascension_valve',
      'br_rifling',
      'op_crusader_eye',
      'op_thermal_scope',
    ],
    min: 2,
  },
]

const MISC = '기타 (잡탕 빌드)'

/** 최종 빌드에서 탄창 id 를 뽑아낸다 (없으면 null) */
function magazineOf(build: readonly string[]): string | null {
  for (const id of build) {
    if (id.startsWith('mag:')) return id.slice(4)
  }
  return null
}

interface Classified {
  name: string
  /** 앵커는 통과했지만 핵심 부착물이 모자라 탈락했는가 (분류기 건강 진단용) */
  nearMiss: boolean
}

function classify(build: readonly string[]): Classified {
  const owned = new Set(build)
  const mag = magazineOf(build)

  let best: ArchetypeDef | null = null
  let bestHits = 0
  let nearMiss = false

  for (const arch of BUILD_ARCHETYPES) {
    if (mag === null || !arch.mags.includes(mag)) continue // ① 앵커 불충족
    let hits = 0
    for (const k of arch.core) {
      if (owned.has(k)) hits += 1
    }
    if (hits < arch.min) {
      if (hits > 0) nearMiss = true
      continue // ② 핵심 부착물 부족
    }
    // 동점이면 앵커가 좁은 쪽(= 더 구체적인 아키타입)을 택한다.
    const better =
      best === null || hits > bestHits || (hits === bestHits && arch.mags.length < best.mags.length)
    if (better) {
      best = arch
      bestHits = hits
    }
  }

  if (best === null) return { name: MISC, nearMiss }
  return { name: best.name, nearMiss: false }
}

interface BuildStats {
  /** 표본이 클리어 런인가 (false 면 섹터 6+ 대체 표본) */
  fromWins: boolean
  total: number
  rows: { name: string; n: number }[]
  /** 기타를 뺀 최다 아키타입 비중 */
  topNamedShare: number
  topNamedName: string
  miscShare: number
  nearMiss: number
}

function buildStats(all: readonly RunResult[]): BuildStats | null {
  const wins = all.filter((r) => r.won)
  const sample = wins.length > 0 ? wins : all.filter((r) => r.reachedSector >= 6)
  if (sample.length === 0) return null

  const counts: Record<string, number> = {}
  let nearMiss = 0
  for (const r of sample) {
    const c = classify(r.finalBuild)
    counts[c.name] = (counts[c.name] ?? 0) + 1
    if (c.nearMiss) nearMiss += 1
  }

  const rows = Object.keys(counts)
    .map((k) => ({ name: k, n: counts[k] }))
    .sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1))

  const named = rows.filter((r) => r.name !== MISC)
  return {
    fromWins: wins.length > 0,
    total: sample.length,
    rows,
    topNamedShare: named.length === 0 ? 0 : named[0].n / sample.length,
    topNamedName: named.length === 0 ? '—' : named[0].name,
    miscShare: (counts[MISC] ?? 0) / sample.length,
    nearMiss,
  }
}

function tableBuilds(stats: BuildStats | null): void {
  line('⑤ 클리어 런의 빌드 아키타입 분포 (ATTACHMENTS.md §8 대조)')
  line('─'.repeat(76))
  line('   판정: 탄창 앵커 통과 + 핵심 부착물 min개 이상. 못 넘기면 기타(잡탕).')
  line()

  if (stats === null) {
    line('   클리어 런도 섹터 6 도달 런도 없다. 표본이 부족하거나 난이도가 과하다.')
    line()
    return
  }
  if (!stats.fromWins) line('   ※ 클리어 런이 없어 섹터 6 이상 도달 런으로 대체 집계했다.')

  line(padEndW('아키타입', 24) + padStartW('런', 6) + padStartW('비중', 8) + '  분포')
  for (const r of stats.rows) {
    line(
      padEndW(r.name, 24) +
        padStartW(String(r.n), 6) +
        padStartW(pct(r.n / stats.total), 8) +
        '  ' +
        bar(r.n / stats.total, 24),
    )
  }
  line()
  line(
    '   최다 명명 아키타입 ' +
      stats.topNamedName +
      ' ' +
      pct(stats.topNamedShare) +
      ' · 기타 ' +
      pct(stats.miscShare) +
      ' · 앵커는 맞았으나 부품 부족 ' +
      stats.nearMiss +
      '런',
  )
  line()
  line('   아키타입 정의 (앵커 / 핵심 부착물 수)')
  for (const a of BUILD_ARCHETYPES) {
    line(
      '   ' +
        padEndW(a.name, 18) +
        padEndW('앵커 ' + a.magNote, 26) +
        padEndW('핵심 ' + a.core.length + '종 중 ' + a.min + '개 필요', 24) +
        a.mags.map((m) => MAG_BY_ID[m]?.name ?? m).join(', '),
    )
  }
  line()
}

// ---------------------------------------------------------------------------
// 표 6 — 탄창 채택 분포 (한 줄짜리 나열을 정식 표로)
// ---------------------------------------------------------------------------

interface MagRow {
  id: string
  name: string
  cap: number
  all: number
  wins: number
}

function magazineRows(all: readonly RunResult[]): MagRow[] {
  const total: Record<string, number> = {}
  const won: Record<string, number> = {}
  for (const r of all) {
    const m = magazineOf(r.finalBuild)
    if (m === null) continue
    total[m] = (total[m] ?? 0) + 1
    if (r.won) won[m] = (won[m] ?? 0) + 1
  }
  return MAGAZINES.map((m) => ({
    id: m.id,
    name: m.name,
    cap: m.cap,
    all: total[m.id] ?? 0,
    wins: won[m.id] ?? 0,
  })).sort((a, b) => b.all - a.all || (a.id < b.id ? -1 : 1))
}

function tableMagazines(all: readonly RunResult[]): void {
  line('⑥ 탄창 채택 분포 — 런이 끝났을 때 물고 있던 탄창 (10종 전부)')
  line('─'.repeat(76))

  const rows = magazineRows(all)
  const total = Math.max(1, all.length)
  const winTotal = all.filter((r) => r.won).length

  line(
    padEndW('탄창', 18) +
      padStartW('CAP', 5) +
      padStartW('전체', 7) +
      padStartW('비중', 8) +
      padStartW('클리어', 8) +
      padStartW('클리어중', 10) +
      padStartW('승률', 8) +
      '  분포',
  )
  for (const r of rows) {
    line(
      padEndW(r.name, 18) +
        padStartW(String(r.cap), 5) +
        padStartW(String(r.all), 7) +
        padStartW(pct(r.all / total), 8) +
        padStartW(String(r.wins), 8) +
        padStartW(winTotal > 0 ? pct(r.wins / winTotal) : '—', 10) +
        padStartW(r.all > 0 ? pct(r.wins / r.all) : '—', 8) +
        '  ' +
        bar(r.all / total, 16),
    )
  }
  line()

  const dead = rows.filter((r) => r.all === 0)
  const starter = rows.find((r) => r.id === 'm1')
  line(
    '   채택 0회: ' +
      (dead.length === 0 ? '없음' : dead.map((r) => r.name).join(', ')) +
      ' (' +
      dead.length +
      '/' +
      MAGAZINES.length +
      '종)',
  )
  line(
    '   ※ 표준 5연발은 시작 탄창이라 "교체하지 않았다"가 곧 채택으로 잡힌다 — 현재 ' +
      pct((starter?.all ?? 0) / total) +
      '.',
  )
  line('   ※ 봇은 상점에서 탄창을 사지 않는다(빌드 방향 전환 판단 불가). 여기 수치는 보상·이벤트 경로만 반영한다.')
  line()
}

// ---------------------------------------------------------------------------
// 표 7 — 부위(slot)별 채택 분포. 어느 부위가 획일적인가를 드러낸다
// ---------------------------------------------------------------------------

const SLOTS: SlotKind[] = ['barrel', 'handguard', 'optic', 'stock', 'rail']
const SLOT_NAME: Record<SlotKind, string> = {
  barrel: '총열',
  handguard: '덮개',
  optic: '광학',
  stock: '개머리판',
  rail: '레일',
}

interface SlotStat {
  slot: SlotKind
  /** 이 부위의 부착물이 최종 빌드에 실린 총 횟수 */
  fills: number
  /** 부위가 비어 있지 않았던 런 비율 (레일은 1칸 이상 채운 비율) */
  filledRuns: number
  top: { name: string; n: number; rarity: string }[]
  bottom: { name: string; n: number; rarity: string }[]
  /** 그 부위 안에서 상위 1종이 차지하는 비율 = 획일성 지표 */
  top1Share: number
  top3Share: number
  /** 채택 0회 종 수 */
  zero: number
  kinds: number
}

function slotStats(all: readonly RunResult[]): SlotStat[] {
  const freq = summarize(all).buildFrequency
  const runsWithSlot: Record<string, number> = {}
  for (const r of all) {
    const seen = new Set<SlotKind>()
    for (const id of r.finalBuild) {
      const a = ATT_BY_ID[id]
      if (a) seen.add(a.slot)
    }
    for (const s of seen) runsWithSlot[s] = (runsWithSlot[s] ?? 0) + 1
  }

  return SLOTS.map((slot) => {
    const rows = ATTACHMENTS.filter((a) => a.slot === slot)
      .map((a) => ({ name: a.name, n: freq[a.id] ?? 0, rarity: a.rarity }))
      .sort((x, y) => y.n - x.n || (x.name < y.name ? -1 : 1))
    const fills = rows.reduce((acc, r) => acc + r.n, 0)
    const d = Math.max(1, fills)
    return {
      slot,
      fills,
      filledRuns: (runsWithSlot[slot] ?? 0) / Math.max(1, all.length),
      top: rows.slice(0, 3),
      bottom: rows.slice(-3).reverse(),
      top1Share: rows.length > 0 ? rows[0].n / d : 0,
      top3Share: rows.slice(0, 3).reduce((acc, r) => acc + r.n, 0) / d,
      zero: rows.filter((r) => r.n === 0).length,
      kinds: rows.length,
    }
  })
}

function tableSlots(all: readonly RunResult[]): void {
  line('⑦ 부위(slot)별 채택 분포 — 어느 부위가 획일적인가')
  line('─'.repeat(76))

  const stats = slotStats(all)

  line(
    padEndW('부위', 10) +
      padStartW('종수', 6) +
      padStartW('장착률', 9) +
      padStartW('1위점유', 9) +
      padStartW('3위까지', 9) +
      padStartW('0회', 6) +
      '  획일성',
  )
  for (const s of stats) {
    line(
      padEndW(SLOT_NAME[s.slot], 10) +
        padStartW(String(s.kinds), 6) +
        padStartW(pct(s.filledRuns), 9) +
        padStartW(pct(s.top1Share), 9) +
        padStartW(pct(s.top3Share), 9) +
        padStartW(String(s.zero), 6) +
        '  ' +
        bar(s.top3Share, 20),
    )
  }
  line()
  line('   1위점유 = 그 부위 채택 중 최다 1종이 먹는 비율. 높을수록 "이 부위는 사실상 정답이 하나".')
  line()

  const total = Math.max(1, all.length)
  for (const s of stats) {
    line('   [' + SLOT_NAME[s.slot] + '] ' + s.kinds + '종 · 장착률 ' + pct(s.filledRuns))
    const show = (label: string, list: SlotStat['top']): void => {
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i]
        line(
          '     ' +
            padEndW(i === 0 ? label : '', 8) +
            padEndW(r.name, 20) +
            padEndW(r.rarity, 10) +
            padStartW(String(r.n), 6) +
            padStartW(pct(r.n / total), 8),
        )
      }
    }
    show('상위 3', s.top)
    show('하위 3', s.bottom)
    line()
  }
}

// ---------------------------------------------------------------------------
// 표 8 — 순서 민감도 (JUSTIFICATION §5 "순서가 정말 중요한가")
// ---------------------------------------------------------------------------

interface OrderRow {
  n: number
  median: number
  mean: number
  p10: number
  p90: number
  over25: number
  /** greedy 봇 배열이 최선 배열의 몇 %를 건졌는가 (봇 묶음에만 존재) */
  greedyShare: number
}

/** 비율 통계에 쓸 수 있는 표본인가 — 순서 결정이 존재하고 값이 유한해야 한다 */
function usable(s: OrderSample): boolean {
  return s.k >= 2 && s.worst > 0 && Number.isFinite(s.best) && Number.isFinite(s.worst)
}

function orderRow(samples: readonly OrderSample[]): OrderRow {
  const ratios = samples.map((s) => s.best / s.worst).sort((a, b) => a - b)
  const shares: number[] = []
  for (const s of samples) {
    if (s.greedy !== null && s.best > 0) shares.push(s.greedy / s.best)
  }
  return {
    n: samples.length,
    median: quantile(ratios, 0.5),
    mean: mean(ratios),
    p10: quantile(ratios, 0.1),
    p90: quantile(ratios, 0.9),
    over25: samples.length === 0 ? Number.NaN : ratios.filter((r) => r >= 2.5).length / ratios.length,
    greedyShare: mean(shares),
  }
}

function ratioStr(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) + 'x' : '—'
}

function orderBlock(title: string, samples: readonly OrderSample[]): OrderRow {
  line('   ' + title)
  line(
    '   ' +
      padEndW('섹터', 8) +
      padStartW('표본', 6) +
      padStartW('중앙비', 9) +
      padStartW('평균비', 9) +
      padStartW('p10', 8) +
      padStartW('p90', 8) +
      padStartW('≥2.5배', 9) +
      padStartW('greedy달성', 12),
  )

  for (let sec = 1; sec <= FINAL_SECTOR; sec += 1) {
    const rows = samples.filter((s) => s.sector === sec)
    if (rows.length === 0) continue
    const r = orderRow(rows)
    line(
      '   ' +
        padEndW('S' + sec, 8) +
        padStartW(String(r.n), 6) +
        padStartW(ratioStr(r.median), 9) +
        padStartW(ratioStr(r.mean), 9) +
        padStartW(ratioStr(r.p10), 8) +
        padStartW(ratioStr(r.p90), 8) +
        padStartW(pct(r.over25), 9) +
        padStartW(Number.isFinite(r.greedyShare) ? pct(r.greedyShare) : '—', 12),
    )
  }

  const total = orderRow(samples)
  line(
    '   ' +
      padEndW('전체', 8) +
      padStartW(String(total.n), 6) +
      padStartW(ratioStr(total.median), 9) +
      padStartW(ratioStr(total.mean), 9) +
      padStartW(ratioStr(total.p10), 8) +
      padStartW(ratioStr(total.p90), 8) +
      padStartW(pct(total.over25), 9) +
      padStartW(Number.isFinite(total.greedyShare) ? pct(total.greedyShare) : '—', 12),
  )
  line()
  return total
}

const RATIO_BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: '   ~1.5x', lo: 0, hi: 1.5 },
  { label: '1.5~2.0x', lo: 1.5, hi: 2.0 },
  { label: '2.0~2.5x', lo: 2.0, hi: 2.5 },
  { label: '2.5~4.0x', lo: 2.5, hi: 4.0 },
  { label: '4.0~8.0x', lo: 4.0, hi: 8.0 },
  { label: '8.0x~   ', lo: 8.0, hi: Number.POSITIVE_INFINITY },
]

interface OrderStats {
  bot: OrderRow
  random: OrderRow
  /** 기준문이 말하는 "동일 5발" 만 따로 — k=5 표본 */
  k5: OrderRow
  /** 초반(S1~S2) 봇 묶음의 greedy 달성률 — 기준 ⑤ 프록시 */
  earlyGreedyShare: number
  /** 초반(S1~S2) 봇 묶음의 중앙 비율 — 기준 ⑤ 프록시 */
  earlyMedian: number
  enabled: boolean
}

function tableOrder(all: readonly RunResult[], enabled: boolean): OrderStats | null {
  line('⑧ 순서 민감도 — 같은 탄 묶음의 [최선 배열 / 최악 배열] 데미지 비')
  line('─'.repeat(76))

  if (!enabled) {
    line('   --no-order-analysis 로 꺼져 있다.')
    line()
    return null
  }

  const raw: OrderSample[] = []
  for (const r of all) raw.push(...r.orderSamples)
  if (raw.length === 0) {
    line('   표본 없음.')
    line()
    return null
  }

  const degenerate = raw.filter((s) => s.k < 2).length
  const zeroFloor = raw.filter((s) => s.k >= 2 && s.worst <= 0).length
  const good = raw.filter(usable)
  const approx = good.filter((s) => !s.exhaustive).length

  line('   섹터마다 첫 전투의 **첫 사격 직전**에 손패에서 묶음 하나를 집어,')
  line('   그 묶음의 모든 순열을 core.previewDamage 로 평가한다 (k! ≤ 720 전수, 그 위는 근사).')
  line()

  const bot = orderBlock('[봇이 고른 묶음] — 플레이어가 실제로 마주하는 배열 결정', good.filter((s) => s.kind === 'bot'))
  const random = orderBlock('[무작위 묶음] — 선택 편향 없는 대조군', good.filter((s) => s.kind === 'random'))

  // 비율 분포 (봇 묶음)
  const botRatios = good.filter((s) => s.kind === 'bot').map((s) => s.best / s.worst)
  line('   비율 분포 (봇 묶음, n=' + botRatios.length + ')')
  for (const b of RATIO_BUCKETS) {
    const n = botRatios.filter((r) => r >= b.lo && r < b.hi).length
    const share = botRatios.length === 0 ? 0 : n / botRatios.length
    line(
      '     ' +
        padEndW(b.label, 10) +
        padStartW(String(n), 6) +
        padStartW(pct(share), 8) +
        '  ' +
        bar(share, 24),
    )
  }
  line()

  if (degenerate > 0) {
    line(
      '   ※ k<2 표본 ' +
        degenerate +
        '건 제외 — 탄창 용량 1(처형자)에서는 배열 결정 자체가 존재하지 않는다.',
    )
  }
  if (zeroFloor > 0) {
    line('   ※ 최악 배열 피해가 0 인 표본 ' + zeroFloor + '건 제외 (비가 발산한다).')
  }
  if (approx > 0) {
    line(
      '   ※ 근사 표본 ' +
        approx +
        '건 (k>6, 앵커 4종 + 무작위 240배열). 범위를 좁히는 쪽으로만 틀리므로 비율은 과소평가된다.',
    )
  }
  const capped = good.filter((s) => s.cappedByKill).length
  line(
    '   ※ 배열 평가는 **죽지 않는 표적**에 대고 한다. 실제 전투에서는 적이 죽는 순간 남은 탄이 안 나가',
  )
  line(
    '     좋은 배열일수록 뒷 탄이 잘려 비가 과소평가되기 때문이다 (해당 표본 ' +
      capped +
      '건 · ' +
      pct(capped / Math.max(1, good.length)) +
      ').',
  )
  line()

  // 묶음 크기별 — 기준문의 "동일 5발" 이 실제로 어디에 해당하는지 보이게 한다.
  const botSamples = good.filter((s) => s.kind === 'bot')
  const ks = Array.from(new Set(botSamples.map((s) => s.k))).sort((a, b) => a - b)
  line('   묶음 크기(k)별 — 기준문의 "동일 5발" 은 k=5 행이다 (k = 그때의 탄창 용량)')
  line(
    '   ' +
      padEndW('k', 6) +
      padStartW('표본', 6) +
      padStartW('중앙비', 9) +
      padStartW('평균비', 9) +
      padStartW('p90', 8) +
      padStartW('≥2.5배', 9) +
      padStartW('전수조사', 10),
  )
  for (const k of ks) {
    const rows = botSamples.filter((s) => s.k === k)
    const r = orderRow(rows)
    const exhaustive = rows.filter((s) => s.exhaustive).length / rows.length
    line(
      '   ' +
        padEndW(String(k), 6) +
        padStartW(String(r.n), 6) +
        padStartW(ratioStr(r.median), 9) +
        padStartW(ratioStr(r.mean), 9) +
        padStartW(ratioStr(r.p90), 8) +
        padStartW(pct(r.over25), 9) +
        padStartW(pct(exhaustive), 10),
    )
  }
  line()

  line('   ※ 표본은 전투 **시작** 시점에서만 뽑는다 — 온도가 시작값이라 배열이 가장 크게 갈리는 지점이다.')
  line('     냉각 자켓/순교의 화로처럼 시작 온도를 올리는 빌드에서는 2번째 탄창부터 비가 더 낮아진다.')
  line('     즉 여기 수치는 순서 민감도의 **상한**에 가깝다.')
  line()

  const early = botSamples.filter((s) => s.sector <= 2)
  const earlyRow = orderRow(early)
  return {
    bot,
    random,
    k5: orderRow(botSamples.filter((s) => s.k === 5)),
    earlyGreedyShare: earlyRow.greedyShare,
    earlyMedian: earlyRow.median,
    enabled: true,
  }
}

// ---------------------------------------------------------------------------
// 표 9 — 갈림길 선택 (JUSTIFICATION §5 "갈림길이 진짜 선택인가")
// ---------------------------------------------------------------------------

interface PairStat {
  offered: number
  tookRisk: number
}

function pairKey(c: DoorChoice): string {
  return c.offered[0] + ',' + c.offered[1]
}

interface DoorStats {
  /** 위험도 3 이 제시된 갈림길 중 3 을 고른 비율 — 성공 기준 그 자체 */
  threat3Rate: number
  /** 전체 갈림길 중 위험도 3 문으로 들어간 비율 (분모가 다른 두 번째 읽는 법) */
  threat3Overall: number
  threat3Offered: number
  /** (1,2) 에서 2 를 고른 비율 */
  threat2Rate: number
  /** 위험한 쪽을 고른 전체 비율 */
  riskRate: number
  total: number
}

function doorStats(choices: readonly DoorChoice[]): DoorStats {
  let o3 = 0
  let t3 = 0
  let o2 = 0
  let t2 = 0
  let risk = 0
  for (const c of choices) {
    if (c.tookRisk) risk += 1
    if (c.offered[1] === 3) {
      o3 += 1
      if (c.chosen === 3) t3 += 1
    } else {
      o2 += 1
      if (c.chosen === 2) t2 += 1
    }
  }
  return {
    threat3Rate: o3 === 0 ? Number.NaN : t3 / o3,
    threat3Overall: choices.length === 0 ? Number.NaN : t3 / choices.length,
    threat3Offered: o3,
    threat2Rate: o2 === 0 ? Number.NaN : t2 / o2,
    riskRate: choices.length === 0 ? Number.NaN : risk / choices.length,
    total: choices.length,
  }
}

function tableDoors(runs: Map<BotSkill, { results: RunResult[]; summary: Summary }>): DoorStats {
  line('⑨ 갈림길 선택 — 봇이 위험을 사는가 (문 쌍은 언제나 (1,2) 또는 (2,3))')
  line('─'.repeat(76))
  line('   봇의 규칙: "감당 가능한 문 중 가장 위험한 쪽". 감당 판정 = 화력 ≥ 요구화력 × 안전계수.')
  line('   어느 쪽도 감당 못 하면 가장 안전한 문으로 도망친다.')
  line()

  const all: DoorChoice[] = []
  for (const [, data] of runs) {
    for (const r of data.results) all.push(...r.doorChoices)
  }

  line(
    padEndW('섹터', 8) +
      padStartW('갈림길', 8) +
      padStartW('(1,2)', 8) +
      padStartW('위험2', 8) +
      padStartW('(2,3)', 8) +
      padStartW('위험3', 8) +
      padStartW('위험쪽', 8) +
      '  위험3 선택률',
  )

  for (let sec = 1; sec <= FINAL_SECTOR; sec += 1) {
    const rows = all.filter((c) => c.sector === sec)
    if (rows.length === 0) continue
    const st = doorStats(rows)
    const pairs: Record<string, PairStat> = {}
    for (const c of rows) {
      const k = pairKey(c)
      const cur = pairs[k] ?? { offered: 0, tookRisk: 0 }
      cur.offered += 1
      if (c.tookRisk) cur.tookRisk += 1
      pairs[k] = cur
    }
    line(
      padEndW('S' + sec, 8) +
        padStartW(String(rows.length), 8) +
        padStartW(String(pairs['1,2']?.offered ?? 0), 8) +
        padStartW(pct(st.threat2Rate), 8) +
        padStartW(String(pairs['2,3']?.offered ?? 0), 8) +
        padStartW(pct(st.threat3Rate), 8) +
        padStartW(pct(st.riskRate), 8) +
        '  ' +
        (Number.isFinite(st.threat3Rate) ? bar(st.threat3Rate, 20) : ''),
    )
  }

  const total = doorStats(all)
  line('─'.repeat(76))
  line(
    padEndW('전체', 8) +
      padStartW(String(total.total), 8) +
      padStartW(String(total.total - total.threat3Offered), 8) +
      padStartW(pct(total.threat2Rate), 8) +
      padStartW(String(total.threat3Offered), 8) +
      padStartW(pct(total.threat3Rate), 8) +
      padStartW(pct(total.riskRate), 8) +
      '  ' +
      (Number.isFinite(total.threat3Rate) ? bar(total.threat3Rate, 20) : ''),
  )
  line()

  // 스킬별 — 숙련 봇이 더 위험을 사는가
  for (const [skill, data] of runs) {
    const cs: DoorChoice[] = []
    for (const r of data.results) cs.push(...r.doorChoices)
    const st = doorStats(cs)
    line(
      '   ' +
        padEndW(SKILL_NAME[skill], 16) +
        '위험3 선택률 ' +
        padStartW(pct(st.threat3Rate), 8) +
        ' · 위험쪽 전체 ' +
        padStartW(pct(st.riskRate), 8) +
        ' (갈림길 ' +
        st.total +
        '회)',
    )
  }
  line()

  // 진단 — 봇이 문턱에서 얼마나 떨어져 있나. 문턱 근처면 선택이 "아슬아슬"하다는 뜻.
  const margins = all
    .filter((c) => c.demand[1] > 0)
    .map((c) => c.power[1] / c.demand[1])
    .sort((a, b) => a - b)
  line(
    '   진단: 위험한 쪽 문의 요구화력 대비 봇 화력 비 — 중앙 ' +
      ratioStr(quantile(margins, 0.5)) +
      ' · p10 ' +
      ratioStr(quantile(margins, 0.1)) +
      ' · p90 ' +
      ratioStr(quantile(margins, 0.9)),
  )
  line('   (이 비가 안전계수보다 크면 봇은 위험을 산다. 분포가 문턱을 걸쳐야 선택이 갈린다.)')
  line()
  return total
}

// ---------------------------------------------------------------------------
// 표 10 — 성공 기준 6개 자동 판정 (JUSTIFICATION.md §5). 회귀 테스트 대시보드.
// ---------------------------------------------------------------------------

type Mark = 'pass' | 'fail' | 'na'

interface Verdict {
  q: string
  target: string
  measured: string
  mark: Mark
  note: string
}

function markStr(m: Mark): string {
  if (m === 'pass') return '✅'
  if (m === 'fail') return '❌'
  return '⚪'
}

function tableVerdict(
  runs: Map<BotSkill, { results: RunResult[]; summary: Summary }>,
  order: OrderStats | null,
  doors: DoorStats,
  builds: BuildStats | null,
): void {
  line('⑩ 성공 기준 6개 자동 판정 (JUSTIFICATION.md §5) — 회귀 테스트 대시보드')
  line('═'.repeat(76))

  const verdicts: Verdict[] = []

  // ① 순서가 정말 중요한가
  if (order === null) {
    verdicts.push({
      q: '순서가 정말 중요한가',
      target: '최선/최악 평균 ≥ 2.5배',
      measured: '측정 안 함',
      mark: 'na',
      note: '--order-analysis 를 켜야 잰다',
    })
  } else {
    verdicts.push({
      q: '순서가 정말 중요한가',
      target: '최선/최악 평균 ≥ 2.5배',
      measured: '평균 ' + ratioStr(order.bot.mean) + ' · 중앙 ' + ratioStr(order.bot.median),
      mark: order.bot.mean >= 2.5 ? 'pass' : 'fail',
      note:
        '봇 묶음 n=' +
        order.bot.n +
        ' · k=5 만 보면 평균 ' +
        ratioStr(order.k5.mean) +
        ' (n=' +
        order.k5.n +
        ') · 대조군(무작위) 평균 ' +
        ratioStr(order.random.mean),
    })
  }

  // ② 갈림길이 진짜 선택인가
  const t3 = doors.threat3Rate
  verdicts.push({
    q: '갈림길이 진짜 선택인가',
    target: '위험도 3 선택률 35~65%',
    measured: pct(t3),
    mark: Number.isFinite(t3) ? (t3 >= 0.35 && t3 <= 0.65 ? 'pass' : 'fail') : 'na',
    note:
      '(2,3) 갈림길 ' +
      doors.threat3Offered +
      '회 기준 · 전체 갈림길 대비로 읽으면 ' +
      pct(doors.threat3Overall) +
      ' (위험도 3 은 갈림길의 절반에만 나온다)',
  })

  // ③ 빌드가 갈리는가
  if (builds === null) {
    verdicts.push({
      q: '빌드가 갈리는가',
      target: '최다 아키타입 < 35%',
      measured: '표본 없음',
      mark: 'na',
      note: '클리어 런도 섹터 6+ 런도 없다',
    })
  } else {
    // 기타가 절반을 넘으면 "최다 아키타입 비중"은 더 이상 정보가 아니다 —
    // 빌드가 갈린 것인지 분류기가 못 알아본 것인지 구별되지 않으므로 판정을 보류한다.
    const healthy = builds.miscShare <= 0.5
    verdicts.push({
      q: '빌드가 갈리는가',
      target: '최다 아키타입 < 35%',
      measured:
        builds.topNamedName +
        ' ' +
        pct(builds.topNamedShare) +
        ' · 기타 ' +
        pct(builds.miscShare),
      mark: !healthy ? 'na' : builds.topNamedShare < 0.35 ? 'pass' : 'fail',
      note: healthy
        ? '표본 ' + builds.total + (builds.fromWins ? '클리어 런' : '섹터6+ 런')
        : '기타가 절반을 넘어 판정 보류 — 봇이 탄창을 능동적으로 고르지 않아 앵커가 안 맞는다',
    })
  }

  // ④ 배울 것이 있는가 — 숙련도 격차가 섹터가 오를수록 벌어지는가
  const g = runs.get('greedy')
  const o = runs.get('optimal')
  if (g === undefined || o === undefined) {
    verdicts.push({
      q: '배울 것이 있는가',
      target: '숙련도 격차가 섹터마다 벌어짐',
      measured: '한쪽 스킬만 돌렸다',
      mark: 'na',
      note: '--skill=both 로 다시 재라',
    })
  } else {
    const gc = survivalCurve(g.results)
    const oc = survivalCurve(o.results)
    const gaps: number[] = []
    for (let s = 1; s <= FINAL_SECTOR; s += 1) gaps.push(oc[s] - gc[s])
    let up = 0
    let down = 0
    for (let i = 2; i < gaps.length; i += 1) {
      if (gaps[i] > gaps[i - 1] + 1e-9) up += 1
      else if (gaps[i] < gaps[i - 1] - 1e-9) down += 1
    }
    const grew = gaps[gaps.length - 1] - gaps[1]
    verdicts.push({
      q: '배울 것이 있는가',
      target: '숙련도 격차가 섹터마다 벌어짐',
      measured:
        'S2 ' +
        pct(gaps[1]) +
        ' → S' +
        FINAL_SECTOR +
        ' ' +
        pct(gaps[gaps.length - 1]) +
        ' (증가 ' +
        up +
        '/감소 ' +
        down +
        ')',
      mark: grew > 0 && up >= down ? 'pass' : 'fail',
      note: '격차 = 숙련 생존율 − 보통 생존율',
    })
  }

  // ⑤ 파라미터가 과하지 않은가 — 사람 대상 기준이라 프록시로 잰다
  if (order === null) {
    verdicts.push({
      q: '파라미터가 과하지 않은가',
      target: '초반 3전투에 "예열 후 피니셔" 자력 발견',
      measured: '측정 안 함',
      mark: 'na',
      note: '프록시: 초반 greedy 달성률 ≥ 85% 이면서 최선/최악 중앙비 ≥ 1.5배',
    })
  } else {
    const share = order.earlyGreedyShare
    const med = order.earlyMedian
    const ok = share >= 0.85 && med >= 1.5
    verdicts.push({
      q: '파라미터가 과하지 않은가',
      target: '초반 3전투에 "예열 후 피니셔" 자력 발견',
      measured: 'S1~S2 greedy 달성률 ' + pct(share) + ' · 중앙비 ' + ratioStr(med),
      mark: ok ? 'pass' : 'fail',
      note: '프록시 — greedy 봇은 "온도 먼저·데미지 나중" 직관만 쓴다. 그것만으로 최선에 근접하면 발견 가능하다는 뜻',
    })
  }

  // ⑥ 모바일 — 시뮬레이터 범위 밖
  verdicts.push({
    q: '모바일에서 굴러가는가',
    target: 'iPhone 12 세로 60fps · 한 손 완주',
    measured: '헤드리스 시뮬레이터로는 측정 불가',
    mark: 'na',
    note: '실기 계측이 필요하다 (view3d/Renderer 프레임 예산)',
  })

  for (let i = 0; i < verdicts.length; i += 1) {
    const v = verdicts[i]
    line(markStr(v.mark) + ' ' + (i + 1) + '. ' + v.q)
    line('     목표  ' + v.target)
    line('     실측  ' + v.measured)
    line('     비고  ' + v.note)
  }

  const pass = verdicts.filter((v) => v.mark === 'pass').length
  const fail = verdicts.filter((v) => v.mark === 'fail').length
  const na = verdicts.filter((v) => v.mark === 'na').length
  line('═'.repeat(76))
  line('   통과 ' + pass + ' · 실패 ' + fail + ' · 판정 불가 ' + na + ' / 6')
  line()
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const opt = parseArgs(process.argv.slice(2))

  line()
  line('════ GunBalatro 밸런스 시뮬레이션 ════')
  line(
    '런 ' +
      opt.runs +
      ' · 스킬 ' +
      opt.skills.join('+') +
      ' · 성전 등급 ' +
      opt.stake +
      ' · 시드 ' +
      opt.seed +
      '~' +
      (opt.seed + opt.runs - 1) +
      ' · 순열 분석 ' +
      (opt.orderAnalysis ? 'on' : 'off'),
  )
  line()

  // Date.now 는 이 저장소의 금지 목록이다 — 벽시계는 hrtime 으로 잰다 (게임 상태와 무관).
  const started = process.hrtime.bigint()
  const runs = new Map<BotSkill, { results: RunResult[]; summary: Summary }>()
  for (const skill of opt.skills) {
    runs.set(skill, simulateMany(opt.runs, skill, opt.stake, opt.seed, opt.orderAnalysis))
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9

  const all: RunResult[] = []
  for (const [, data] of runs) all.push(...data.results)

  tableOverview(runs)
  tableSurvival(runs)
  tableDeaths(runs)
  tableAdoption(all)

  const builds = buildStats(all)
  tableBuilds(builds)
  tableMagazines(all)
  tableSlots(all)
  const order = tableOrder(all, opt.orderAnalysis)
  const doors = tableDoors(runs)
  tableVerdict(runs, order, doors, builds)

  line('총 ' + all.length + '런 / ' + elapsed.toFixed(1) + '초')
  line(
    '부착물 카탈로그 ' +
      ATTACHMENTS.length +
      '종 · 탄창 ' +
      MAGAZINES.length +
      '종 · 참조 확인 ' +
      (ATT_BY_ID['br_long_barrel'] ? 'ok' : 'FAIL'),
  )
  line()
  flush()
}

try {
  main()
} catch (err) {
  // 시뮬레이터는 개발 도구다 — 실패해도 파이프라인을 막지 않는다.
  process.stdout.write('[sim] 실행 중 오류: ' + String(err) + '\n')
  if (err instanceof Error && err.stack) process.stdout.write(err.stack + '\n')
}
process.exitCode = 0

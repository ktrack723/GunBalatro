// `npm run sim` 진입점 — 봇으로 런을 대량 시뮬레이션하고 밸런스 표를 콘솔에 찍는다.
// 인자: --runs=N --skill=greedy|optimal|both --stake=N --seed=N (기본 200 / both / 1 / 1).
// 게임 로직은 전혀 만들지 않는다. 읽고, 세고, 표로 정렬해서 보여주기만 한다.

import { FINAL_SECTOR } from '../core/run'
import { ATTACHMENTS, ATT_BY_ID } from '../core/data/attachments'
import { MAG_BY_ID } from '../core/data/magazines'
import { deathDistribution, simulateMany, summarize, survivalCurve } from './harness'
import type { RunResult, Summary } from './harness'
import type { BotSkill } from './bot'

// ---------------------------------------------------------------------------
// 인자
// ---------------------------------------------------------------------------

interface Options {
  runs: number
  skills: BotSkill[]
  stake: number
  seed: number
}

function parseArgs(argv: readonly string[]): Options {
  const opt: Options = { runs: 200, skills: ['greedy', 'optimal'], stake: 1, seed: 1 }

  for (const raw of argv) {
    const m = /^--([a-zA-Z]+)=(.*)$/.exec(raw)
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
  return (x * 100).toFixed(1) + '%'
}

/** 0~1 값을 20칸 막대로 */
function bar(x: number, cells = 20): string {
  const n = Math.max(0, Math.min(cells, Math.round(x * cells)))
  return '█'.repeat(n) + '·'.repeat(cells - n)
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
// ---------------------------------------------------------------------------

interface ArchetypeDef {
  name: string
  keys: string[]
}

const BUILD_ARCHETYPES: ArchetypeDef[] = [
  {
    name: '1. 예열-피니셔',
    keys: ['hg_incendiary_catalyst', 'rl_death_rite', 'br_heavy_barrel', 'rl_holy_water'],
  },
  { name: '2. 폭(Width)', keys: ['mag:m2', 'br_judgment', 'hg_chain_ignition', 'mag:m5'] },
  {
    name: '3. 깊이(Depth)',
    keys: ['mag:m9', 'rl_unstable_core', 'op_soul_mark', 'mag:m4', 'hg_furnace_heart'],
  },
  { name: '4. 도박', keys: ['mag:m3', 'rl_gambler_litany'] },
  {
    name: '5. 축성 콤보',
    keys: ['mag:m6', 'op_sanctify_lens', 'rl_trinity_sigil', 'br_purity_catalyst'],
  },
  {
    name: '6. 자원',
    keys: ['st_infinite_magazine', 'st_giant_stride', 'op_rangefinder', 'mag:m8', 'st_buffer'],
  },
  {
    name: '7. 등급 배열',
    keys: ['rl_descend_litany', 'rl_ascend_litany', 'hg_backflow_valve', 'hg_ascension_valve'],
  },
]

function classify(build: readonly string[]): string {
  const owned = new Set(build)
  let best = '기타 (잡탕 빌드)'
  let bestScore = 0
  for (const arch of BUILD_ARCHETYPES) {
    let score = 0
    for (const k of arch.keys) {
      if (owned.has(k)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = arch.name
    }
  }
  return best
}

function tableBuilds(all: readonly RunResult[]): void {
  line('⑤ 클리어 런의 빌드 아키타입 분포 (ATTACHMENTS.md §8 대조)')
  line('─'.repeat(72))

  const wins = all.filter((r) => r.won)
  if (wins.length === 0) {
    line('   클리어 런이 없다. 표본이 부족하거나 난이도가 과하다.')
    line('   참고: 섹터 6 이상 도달 런으로 대체 집계한다.')
  }
  const sample = wins.length > 0 ? wins : all.filter((r) => r.reachedSector >= 6)
  if (sample.length === 0) {
    line('   섹터 6 도달 런도 없다.')
    line()
    return
  }

  const counts: Record<string, number> = {}
  for (const r of sample) {
    const k = classify(r.finalBuild)
    counts[k] = (counts[k] ?? 0) + 1
  }

  const rows = Object.keys(counts)
    .map((k) => ({ name: k, n: counts[k] }))
    .sort((a, b) => b.n - a.n)

  line(padEndW('아키타입', 24) + padStartW('런', 6) + padStartW('비중', 8) + '  분포')
  for (const r of rows) {
    line(
      padEndW(r.name, 24) +
        padStartW(String(r.n), 6) +
        padStartW(pct(r.n / sample.length), 8) +
        '  ' +
        bar(r.n / sample.length, 24),
    )
  }
  line()

  // 클리어 런이 실제로 뭘 물고 있었는지 — 탄창 분포
  const mags: Record<string, number> = {}
  for (const r of sample) {
    for (const id of r.finalBuild) {
      if (!id.startsWith('mag:')) continue
      const mag = MAG_BY_ID[id.slice(4)]
      const name = mag ? mag.name : id
      mags[name] = (mags[name] ?? 0) + 1
    }
  }
  const magRows = Object.keys(mags)
    .map((k) => ({ name: k, n: mags[k] }))
    .sort((a, b) => b.n - a.n)
  line('   탄창 분포: ' + magRows.map((m) => m.name + ' ' + m.n).join(' · '))
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
      (opt.seed + opt.runs - 1),
  )
  line()

  const started = Date.now()
  const runs = new Map<BotSkill, { results: RunResult[]; summary: Summary }>()
  for (const skill of opt.skills) {
    runs.set(skill, simulateMany(opt.runs, skill, opt.stake, opt.seed))
  }
  const elapsed = Date.now() - started

  const all: RunResult[] = []
  for (const [, data] of runs) all.push(...data.results)

  tableOverview(runs)
  tableSurvival(runs)
  tableDeaths(runs)
  tableAdoption(all)
  tableBuilds(all)

  line('총 ' + all.length + '런 / ' + (elapsed / 1000).toFixed(1) + '초')
  line(
    '부착물 카탈로그 ' +
      ATTACHMENTS.length +
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

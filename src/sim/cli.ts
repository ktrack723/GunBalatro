// ============================================================================
// 밸런스 시뮬레이터 CLI — `npm run sim`
//   출력은 회귀 대시보드다. 목표를 실측 쪽으로 내리지 않는다.
// ============================================================================
import type { Round, RunState } from '../core/types'
import { analyzeRounds } from './rounds'
import { analyzeAttachments } from './attach'
import { newRun } from '../core/run'
import { startCombat, basicRound, fire, makeRound, previewDamage } from '../core/combat'
import { makeEnemy } from '../core/data/enemies'
import { makeRng } from '../core/rng'
import { ATT_BY_ID } from '../core/data/attachments'
import { SPECIAL_BY_ID } from '../core/data/specials'
import { deathDistribution, emptyTelemetry, simulateMany, simulateRun, survivalCurve } from './harness'
import type { TraceLine } from './harness'
import { renderPlaythrough, renderTelemetry } from './playthrough'
import type { BotSkill, } from './bot'

const out = (s = ''): void => {
  process.stdout.write(s + '\n')
}
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const padS = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s)
const pct = (v: number): string => (v * 100).toFixed(1) + '%'
const bar = (v: number, n = 20): string => '█'.repeat(Math.round(v * n)) + '·'.repeat(n - Math.round(v * n))

function arg(name: string, def: string): string {
  for (const a of process.argv.slice(2)) {
    const m = new RegExp('^--' + name + '=(.*)$').exec(a)
    if (m !== null) return m[1]
  }
  return def
}

const RUNS = Math.max(1, parseInt(arg('runs', '200'), 10) || 200)
/** --play=N : 판 N개를 통째로 읽을 수 있게 풀어 쓴다 (리비전마다 5판) */
const PLAY = Math.max(0, parseInt(arg('play', '0'), 10) || 0)
const SEED0 = Math.max(1, parseInt(arg('seed', '1'), 10) || 1)
const STAKE = Math.max(1, parseInt(arg('stake', '1'), 10) || 1)
const SKILL = arg('skill', 'both')

// ---------------------------------------------------------------------------
// 순서 민감도 — 같은 탄 묶음의 최선/최악 배열 비
// ---------------------------------------------------------------------------
function perms<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a]
  const res: T[][] = []
  for (let i = 0; i < a.length; i += 1) {
    for (const p of perms(a.slice(0, i).concat(a.slice(i + 1)))) res.push([a[i], ...p])
  }
  return res
}

/**
 * 순서 민감도. **첫 탄창(온도 1.00)과 이월된 탄창을 따로 잰다.**
 * 온도가 사격 사이 이월되므로 두 번째 탄창부터는 시작 온도가 높고,
 * BALANCE §7.5 법칙 1 에 따라 배열 격차가 줄어든다 — 그 감소폭이 바로
 * "이월 50%" 가 핵심 메커닉에서 가져가는 대가다. 안 재면 안 보인다.
 */
/**
 * 번들은 **여러 개**를 본다. 예전에는 소이+철갑+점착 한 묶음만 쟀는데, 그 셋이 바로
 * 지배 조합이었다 — 그 줄을 의도적으로 평평하게 만들면 이 지표도 같이 떨어져서
 * "배열이 안 중요해졌다" 는 잘못된 신호를 준다. 실제로 카탈로그가 다양해진 지금은
 * 대표 묶음들의 평균이 이 게임에서 배열이 얼마나 중요한지를 더 정직하게 말해 준다.
 * (구 묶음도 계속 따로 찍어서 회귀를 놓치지 않는다.)
 */
const BUNDLES: Array<{ name: string; ids: string[] }> = [
  { name: '구 지배조합(소이·철갑·점착)', ids: ['sp_incendiary', 'sp_ap', 'sp_adhesive'] },
  { name: '예열·관통·표식', ids: ['sp_thermite', 'sp_breach', 'sp_marker'] },
  { name: '냉동·유일·충격', ids: ['sp_cryo', 'sp_solitary', 'sp_shock'] },
  { name: '성탄·철갑·소이', ids: ['sp_sanctified', 'sp_ap', 'sp_incendiary'] },
]

/**
 * 이월 정상상태 온도를 **계산해서** 쓴다. 예전에는 9.0 을 박아 뒀는데, 그 값은 소이탄이
 * 온도 +5.0 이던 시절의 고정점이었다. 탄이 약해지면 정상상태도 같이 내려가므로,
 * 낡은 상수로 재면 "배열이 안 중요해졌다" 는 잘못된 신호가 나온다.
 *   H* = BASE_HEAT + carry × (H* + Σg)  →  탄창을 몇 번 돌려 수렴시킨다.
 */
function steadyHeat(ids: string[]): number {
  const run: RunState = newRun(4242, 1)
  const stock: Record<string, number> = {}
  for (const id of ids) stock[id] = (stock[id] ?? 0) + 1
  run.loadout.specials = stock
  const e = makeEnemy({ archetypeId: 'shambler', passiveId: null, sector: 4, nodeMul: 1.63, threat: 1 })
  const s = startCombat(run.loadout, e, makeRng(11))
  s.enemy.hp = 1e12
  s.enemy.maxHp = 1e12
  const cap = Math.min(s.cap, 5)
  for (let i = 0; i < 6; i += 1) {
    const plan: Round[] = ids.map((id) => makeRound(id))
    while (plan.length < cap) plan.push(basicRound())
    // 재고를 계속 채워 같은 탄창을 반복 사격한다 (정상상태를 찾는 것이 목적이다)
    s.specials = { ...stock }
    fire(s, plan)
  }
  return s.heatStartBase
}

function bundleSensitivity(startHeat: number, ids: string[]): number {
  const all: number[] = []
  for (let sector = 1; sector <= 8; sector += 1) {
    for (let seed = 1; seed <= 12; seed += 1) {
      const run: RunState = newRun(seed * 31 + sector, 1)
      const stock: Record<string, number> = {}
      for (const id of ids) stock[id] = (stock[id] ?? 0) + 1
      run.loadout.specials = stock
      const e = makeEnemy({ archetypeId: 'shambler', passiveId: null, sector, nodeMul: 1.63, threat: 1 })
      const s = startCombat(run.loadout, e, makeRng(7 + seed))
      s.enemy.hp = 1e12
      s.enemy.maxHp = 1e12
      s.heatStartBase = startHeat
      s.heat = startHeat
      const cap = Math.min(s.cap, 5)
      const plan: Round[] = ids.map((id) => makeRound(id))
      while (plan.length < cap) plan.push(basicRound())
      let best = -1
      let worst = Infinity
      for (const p of perms(plan.slice(0, Math.min(cap, 5)))) {
        const v = previewDamage(s, p).expected
        if (v > best) best = v
        if (v < worst) worst = v
      }
      if (worst > 0) all.push(best / worst)
    }
  }
  return all.length === 0 ? 1 : all.reduce((a, b) => a + b, 0) / all.length
}

/** startHeat 이 null 이면 그 묶음의 이월 정상상태 온도를 계산해서 쓴다 */
function orderSensitivity(startHeat: number | null): { bySector: number[]; overall: number } {
  const per = BUNDLES.map((b) => bundleSensitivity(startHeat ?? steadyHeat(b.ids), b.ids))
  return { bySector: per, overall: per.reduce((a, b) => a + b, 0) / per.length }
}

// ---------------------------------------------------------------------------
function playthroughReport(): void {
  out('════ GunBalatro 플레이스루 리포트 ════')
  out(`${PLAY}판 · 성전 ${STAKE} · 봇 ${SKILL === 'both' ? 'greedy' : SKILL}`)
  const skill: BotSkill = SKILL === 'both' ? 'greedy' : (SKILL as BotSkill)
  const tel = emptyTelemetry()
  for (let i = 0; i < PLAY; i += 1) {
    const trace: TraceLine[] = []
    const res = simulateRun(SEED0 + i, skill, STAKE, trace, tel)
    out(renderPlaythrough(trace, res, i + 1))
  }
  out(renderTelemetry(tel, PLAY))
}

function main(): void {
  if (PLAY > 0) {
    playthroughReport()
    return
  }
  out('════ GunBalatro v2 밸런스 시뮬레이션 ════')
  out('런 ' + RUNS + ' · 성전 등급 ' + STAKE)
  out()

  const skills: BotSkill[] = SKILL === 'both' ? ['novice', 'greedy', 'optimal'] : [SKILL as BotSkill]
  const packs = skills.map((sk) => ({ sk, ...simulateMany(RUNS, sk, STAKE) }))

  out('① 스킬별 성적')
  out('─'.repeat(70))
  out(pad('스킬', 18) + padS('런', 6) + padS('승률', 8) + padS('중앙섹터', 10) + padS('최고온도', 10))
  for (const p of packs) {
    out(
      pad(
        p.sk === 'novice' ? '초보(novice)' : p.sk === 'greedy' ? '보통(greedy)' : '숙련(optimal)',
        18,
      ) +
        padS(String(p.summary.runs), 6) +
        padS(pct(p.summary.winRate), 8) +
        padS(p.summary.medianSector.toFixed(1), 10) +
        padS(p.summary.medianPeakHeat.toFixed(1), 10),
    )
  }
  out()

  out('② 섹터별 생존율')
  out('─'.repeat(70))
  const curves = packs.map((p) => survivalCurve(p.results))
  for (let s = 0; s < 8; s += 1) {
    let line = 'S' + (s + 1) + '  '
    for (let i = 0; i < packs.length; i += 1) line += padS(pct(curves[i][s]), 8) + ' ' + bar(curves[i][s], 14) + '  '
    out(line)
  }
  out()

  out('③ 사망 노드 상위')
  out('─'.repeat(70))
  const deaths = deathDistribution(packs[0].results)
  const dl = Object.entries(deaths).sort((a, b) => b[1] - a[1]).slice(0, 8)
  for (const [k, v] of dl) out('   ' + pad(k, 20) + padS(String(v), 5))
  out()

  out('④ 부착물 채택 (최종 빌드 기준, 상위 12)')
  out('─'.repeat(70))
  const adopt: Record<string, number> = {}
  let builds = 0
  for (const p of packs) {
    for (const r of p.results) {
      builds += 1
      for (const id of r.finalBuild) adopt[id] = (adopt[id] ?? 0) + 1
    }
  }
  // 승률 리프트: 이 부착물이 최종 빌드에 있던 런의 승률 − 같은 스킬 팩의 전체 승률.
  // 채택률이 높은데 리프트도 크면 '밸류가 미친' 후보다. (n<8 은 표본 부족으로 뺀다)
  const liftNum: Record<string, number> = {}
  const liftDen: Record<string, number> = {}
  for (const p of packs) {
    const base = p.summary.winRate
    for (const r of p.results) {
      for (const id of r.finalBuild) {
        liftNum[id] = (liftNum[id] ?? 0) + ((r.won ? 1 : 0) - base)
        liftDen[id] = (liftDen[id] ?? 0) + 1
      }
    }
  }
  const liftOf = (id: string): number => ((liftDen[id] ?? 0) > 0 ? (liftNum[id] ?? 0) / (liftDen[id] ?? 1) : 0)
  const al = Object.entries(adopt).sort((a, b) => b[1] - a[1])
  out('   ' + pad('이름', 18) + pad('부위', 11) + pad('등급', 10) + padS('채택', 8) + padS('승률리프트', 12))
  for (const [id, n] of al.slice(0, 12)) {
    const a = ATT_BY_ID[id]
    const lf = liftOf(id)
    out('   ' + pad(a?.name ?? id, 18) + pad(a?.slot ?? '', 11) + pad(a?.rarity ?? '', 10) + padS(pct(n / builds), 8) + padS((lf >= 0 ? '+' : '') + pct(lf), 12))
  }
  out('   [승률 리프트 상위 — 밸류 과다 후보 (n≥8)]')
  const lifts = Object.keys(adopt).filter((id) => (liftDen[id] ?? 0) >= 8).sort((x, y) => liftOf(y) - liftOf(x))
  for (const id of lifts.slice(0, 8)) {
    const a = ATT_BY_ID[id]
    out('   ' + pad(a?.name ?? id, 18) + pad(a?.slot ?? '', 11) + pad(a?.rarity ?? '', 10) + padS('n=' + (liftDen[id] ?? 0), 8) + padS('+' + pct(liftOf(id)), 12))
  }
  const never = Object.keys(ATT_BY_ID).filter((id) => (adopt[id] ?? 0) === 0)
  out('   채택 0회: ' + never.length + '종' + (never.length > 0 ? ' — ' + never.map((i) => ATT_BY_ID[i].name).join(', ') : ''))
  out()

  out('⑤ 순서 민감도 — 같은 탄 묶음의 최선/최악 배열 비')
  out('─'.repeat(70))
  const os = orderSensitivity(1)
  const osCarry = orderSensitivity(null)
  out('   [첫 탄창 · 온도 1.00]')
  for (let i = 0; i < BUNDLES.length; i += 1) {
    out('   ' + pad(BUNDLES[i]!.name, 26) + padS(os.bySector[i]!.toFixed(2) + 'x', 8) + '  ' + bar(Math.min(1, os.bySector[i]! / 6), 16))
  }
  out('   평균 ' + os.overall.toFixed(2) + 'x')
  out('   [이월된 탄창 · 정상상태 온도 계산값]  ← 이월 50% 의 대가')
  for (let i = 0; i < BUNDLES.length; i += 1) {
    out('   ' + pad(BUNDLES[i]!.name, 26) + padS(osCarry.bySector[i]!.toFixed(2) + 'x', 8) + '  ' + bar(Math.min(1, osCarry.bySector[i]! / 6), 16))
  }
  out('   평균 ' + osCarry.overall.toFixed(2) + 'x')
  out()

  out('⑥ 갈림길 — 더 위험한 문을 고른 비율')
  out('─'.repeat(70))
  let risky = 0
  let pairs23 = 0
  let took3 = 0
  let total = 0
  for (const p of packs) {
    for (const r of p.results) {
      for (const c of r.doorChoices) {
        total += 1
        if (c.tookRiskier) risky += 1
        if (c.offered.includes(3)) {
          pairs23 += 1
          if (c.chosen === 3) took3 += 1
        }
      }
    }
  }
  const t3 = pairs23 === 0 ? 0 : took3 / pairs23
  out('   전체 갈림길 ' + total + ' · 더 위험한 쪽 ' + pct(total === 0 ? 0 : risky / total))
  out('   (2,3) 쌍 ' + pairs23 + ' · 위험도 3 선택률 ' + pct(t3))
  out()

  out('⑦ 특수탄 소비')
  out('─'.repeat(70))
  const leftAvg = packs[0].results.reduce((a, r) => a + r.specialsLeft, 0) / Math.max(1, packs[0].results.length)
  out('   런 종료 시 남은 특수탄 평균 ' + leftAvg.toFixed(1) + '발')
  out('   특수탄 카탈로그 ' + Object.keys(SPECIAL_BY_ID).length + '종')
  out()

  out('⑧ 성공 기준 판정')
  out('═'.repeat(70))
  const g = packs.find((p) => p.sk === 'greedy') ?? packs[0]
  // 숙련 격차는 **초보 대비 숙련**으로 잰다. greedy 는 이미 미리보기로 배열을
  // 고르는 숙련자라, greedy↔optimal 격차는 "게임에 배울 게 없다"가 아니라
  // "못하는 쪽을 측정하지 않았다" 를 뜻한다.
  const nv = packs.find((p) => p.sk === 'novice')
  const o = packs.find((p) => p.sk === 'optimal')
  const gap: number[] = []
  if (o !== undefined && nv !== undefined) {
    const cn = survivalCurve(nv.results)
    const co = survivalCurve(o.results)
    for (let i = 0; i < 8; i += 1) gap.push(co[i] - cn[i])
  }
  let rising = 0
  for (let i = 2; i < gap.length; i += 1) if (gap[i] >= gap[i - 1]) rising += 1

  const verdict = (ok: boolean): string => (ok ? '✅' : '❌')
  out(
    verdict(osCarry.overall >= 2.5) +
      ' 1. 순서가 중요한가 — 목표 ≥2.5x · 첫탄창 ' + os.overall.toFixed(2) +
      'x · 이월탄창 ' + osCarry.overall.toFixed(2) + 'x (판정은 이월 기준, 묶음 평균)',
  )
  for (let i = 0; i < BUNDLES.length; i += 1) {
    out('      · ' + pad(BUNDLES[i]!.name, 26) + osCarry.bySector[i]!.toFixed(2) + 'x')
  }
  out(verdict(t3 >= 0.35 && t3 <= 0.65) + ' 2. 갈림길이 선택인가 — 목표 35~65% · 실측 ' + pct(t3))
  out(verdict(never.length === 0) + ' 3. 사장된 부착물 없음 — 채택 0회 ' + never.length + '종')
  out(
    verdict(rising >= 4) +
      ' 4. 배울 것이 있는가 — 초보→숙련 생존율 격차 증가 구간 ' + rising + '/6' +
      (gap.length === 8 ? '  (S8 격차 ' + pct(gap[7]) + ')' : ''),
  )
  out(
    verdict(g.summary.winRate >= 0.14 && g.summary.winRate <= 0.26) +
      ' 5. 승률 밴드 — 목표 14~26% (난이도 상향 후) · 실측 ' + pct(g.summary.winRate),
  )
  out('═'.repeat(70))
  process.exitCode = 0
}

main()

// --- 탄 가치 분석 (--rounds) -------------------------------------------------
if (process.argv.slice(2).some((a) => a === '--rounds')) {
  // eslint-disable-next-line no-console
  console.log(analyzeRounds())
}

// --- 부착물 가치 분석 (--attach) --------------------------------------------
if (process.argv.slice(2).some((a) => a === '--attach')) {
  // eslint-disable-next-line no-console
  console.log(analyzeAttachments())
}

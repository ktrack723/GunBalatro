// ============================================================================
// 밸런스 시뮬레이터 CLI — `npm run sim`
//   출력은 회귀 대시보드다. 목표를 실측 쪽으로 내리지 않는다.
// ============================================================================
import type { Round, RunState } from '../core/types'
import { newRun } from '../core/run'
import { startCombat, basicRound, makeRound, previewDamage } from '../core/combat'
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
function orderSensitivity(startHeat: number): { bySector: number[]; overall: number } {
  const bySector: number[] = []
  const all: number[] = []
  for (let sector = 1; sector <= 8; sector += 1) {
    const ratios: number[] = []
    for (let seed = 1; seed <= 24; seed += 1) {
      const run: RunState = newRun(seed * 31 + sector, 1)
      // 섹터에 맞춰 특수탄을 조금 쥐여 준다 (실제 런의 중간 상태 모사)
      run.loadout.specials = { sp_incendiary: 2, sp_ap: 1, sp_adhesive: 1 }
      const e = makeEnemy({
        archetypeId: 'shambler',
        passiveId: null,
        sector,
        nodeMul: 1.63,
        threat: 1,
      })
      const s = startCombat(run.loadout, e, makeRng(7 + seed))
      s.enemy.hp = 1e12
      s.enemy.maxHp = 1e12
      s.heatStartBase = startHeat
      s.heat = startHeat
      const cap = Math.min(s.cap, 5)
      const plan: Round[] = [
        makeRound('sp_incendiary'),
        makeRound('sp_ap'),
        makeRound('sp_adhesive'),
      ]
      while (plan.length < cap) plan.push(basicRound())
      let best = -1
      let worst = Infinity
      for (const p of perms(plan.slice(0, Math.min(cap, 5)))) {
        const v = previewDamage(s, p).expected
        if (v > best) best = v
        if (v < worst) worst = v
      }
      if (worst > 0) {
        ratios.push(best / worst)
        all.push(best / worst)
      }
    }
    bySector.push(ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length))
  }
  return { bySector, overall: all.reduce((a, b) => a + b, 0) / Math.max(1, all.length) }
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
  const al = Object.entries(adopt).sort((a, b) => b[1] - a[1])
  for (const [id, n] of al.slice(0, 12)) {
    const a = ATT_BY_ID[id]
    out('   ' + pad(a?.name ?? id, 18) + pad(a?.slot ?? '', 11) + pad(a?.rarity ?? '', 10) + padS(pct(n / builds), 8))
  }
  const never = Object.keys(ATT_BY_ID).filter((id) => (adopt[id] ?? 0) === 0)
  out('   채택 0회: ' + never.length + '종' + (never.length > 0 ? ' — ' + never.map((i) => ATT_BY_ID[i].name).join(', ') : ''))
  out()

  out('⑤ 순서 민감도 — 같은 탄 묶음의 최선/최악 배열 비')
  out('─'.repeat(70))
  const os = orderSensitivity(1)
  const osCarry = orderSensitivity(9)
  out('   [첫 탄창 · 온도 1.00]')
  for (let s = 0; s < 8; s += 1) out('   S' + (s + 1) + '  ' + os.bySector[s].toFixed(2) + 'x  ' + bar(Math.min(1, os.bySector[s] / 6), 16))
  out('   평균 ' + os.overall.toFixed(2) + 'x')
  out('   [이월된 탄창 · 온도 9.00]  ← 이월 50% 의 대가')
  for (let s = 0; s < 8; s += 1) out('   S' + (s + 1) + '  ' + osCarry.bySector[s].toFixed(2) + 'x  ' + bar(Math.min(1, osCarry.bySector[s] / 6), 16))
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
      'x · 이월탄창 ' + osCarry.overall.toFixed(2) + 'x (판정은 이월 기준)',
  )
  out(verdict(t3 >= 0.35 && t3 <= 0.65) + ' 2. 갈림길이 선택인가 — 목표 35~65% · 실측 ' + pct(t3))
  out(verdict(never.length === 0) + ' 3. 사장된 부착물 없음 — 채택 0회 ' + never.length + '종')
  out(
    verdict(rising >= 4) +
      ' 4. 배울 것이 있는가 — 초보→숙련 생존율 격차 증가 구간 ' + rising + '/6' +
      (gap.length === 8 ? '  (S8 격차 ' + pct(gap[7]) + ')' : ''),
  )
  out(
    verdict(g.summary.winRate >= 0.28 && g.summary.winRate <= 0.42) +
      ' 5. 승률 밴드 — 목표 28~42% · 실측 ' + pct(g.summary.winRate),
  )
  out('═'.repeat(70))
  process.exitCode = 0
}

main()

// ============================================================================
// 플레이스루 리포트
//   집계 통계는 "무엇이 잘못됐나"를 알려주지만 **왜**는 알려주지 않는다.
//   그래서 리비전마다 몇 판을 통째로 읽는다 — 문 선택, 적, 탄창별 사격, 보상,
//   그리고 죽은 지점까지. 여기서 나온 관찰이 다음 수정의 근거가 된다.
// ============================================================================
import type { RunResult, TraceLine, Telemetry } from './harness'
import { ATTACHMENTS, ATT_BY_ID } from '../core/data/attachments'
import { SPECIALS, SPECIAL_BY_ID } from '../core/data/specials'

const n = (v: number): string => Math.round(v).toLocaleString('en-US')
const f2 = (v: number): string => v.toFixed(2)
const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const padS = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

/** 한 판을 통째로 읽을 수 있게 풀어 쓴다 */
export function renderPlaythrough(trace: readonly TraceLine[], res: RunResult, idx: number): string {
  const L: string[] = []
  L.push('')
  L.push('═'.repeat(74))
  L.push(
    `플레이스루 #${idx}  seed ${res.seed} · 성전 ${res.stake} · 봇 ${res.skill}` +
      `  →  ${res.won ? '완주' : '섹터 ' + res.reachedSector + ' 사망'}`,
  )
  L.push('═'.repeat(74))

  for (const t of trace) {
    switch (t.k) {
      case 'node':
        L.push('')
        L.push(`── S${t.sector}N${t.nodeIndex}  ${t.kind}`)
        break
      case 'doors':
        L.push(
          `   갈림길 [${t.offered.join(',')}] → 위험도 ${t.chosen}` +
            `   (화력 ${n(t.power)} / 필요 ${n(t.need)})`,
        )
        break
      case 'enemy':
        L.push(
          `   ${t.label}${t.passive !== null ? ' <' + t.passive + '>' : ''}` +
            `  HP ${n(t.hp)}  속도 ${t.speed}  거리 ${t.dist}m` +
            `  용량 ${t.cap}  사격당 ${t.fireCost}m  → 최대 ${t.actions}회`,
        )
        break
      case 'mag': {
        L.push(
          `   ${t.index}탄창  온도 ${f2(t.heatFrom)}→${f2(t.heatTo)} (이월 ${f2(t.carried)})` +
            `  피해 ${n(t.damage)}  적 HP ${n(t.hpAfter)}  거리 ${t.distAfter}m`,
        )
        for (const s of t.shots) {
          const trig = s.trig.length === 0
            ? ''
            : '  [' + s.trig.map((id) => ATT_BY_ID[id]?.name ?? SPECIAL_BY_ID[id]?.name ?? id).join(' ') + ']'
          L.push(
            `      ${pad(s.name, 8)} ${padS(n(s.dmg), 6)} × ${padS(f2(s.heat), 6)}` +
              ` = ${padS(n(s.damage), 8)}${trig}`,
          )
        }
        break
      }
      case 'win':
        L.push(`   ★ 승리 — ${t.magsUsed}탄창, 거리 ${t.distLeft}m 남음`)
        break
      case 'reward':
        L.push(`   보상: ${t.label}`)
        break
      case 'skip':
        L.push(`   보상 건너뜀 (탄피 +${t.gain})`)
        break
      case 'buy':
        L.push(`   구매: ${t.label}  −${t.price}  (잔액 ${t.brassLeft})`)
        break
      case 'derelict':
        L.push(`   폐허 «${t.name}» → ${t.result}`)
        break
      case 'death':
        L.push(`   ✝ 사망 ${t.where} — 적 HP ${n(t.hpLeft)} (${(t.hpFrac * 100).toFixed(0)}%) 남기고`)
        break
      case 'end':
        L.push('')
        L.push(`   최종 빌드: ${res.finalBuild.map((id) => ATT_BY_ID[id]?.name ?? id).join(' · ') || '(없음)'}`)
        L.push(`   남은 특수탄 ${res.specialsLeft}발 · 최고 온도 ${f2(res.peakHeat)}`)
        break
    }
  }
  return L.join('\n')
}

/**
 * 계측 요약 — **사장 판정의 진짜 증거**.
 * "최종 빌드에 있었나"(채택률)와 "실제로 발동했나"(발동률)는 다르다.
 * 장착됐는데 한 번도 발동하지 않은 부착물은 조건이 죽은 것이다.
 */
export function renderTelemetry(tel: Telemetry, runs: number): string {
  const L: string[] = []
  const line = (): void => { L.push('─'.repeat(74)) }

  L.push('')
  L.push('▣ 계측 — 장착 대비 발동')
  line()
  interface Row { name: string; tag: string; eq: number; tr: number; hooked: boolean }
  const rows: Row[] = ATTACHMENTS.map((a) => ({
    name: a.name,
    tag: a.slot + '/' + a.rarity,
    eq: tel.equipped[a.id] ?? 0,
    tr: tel.trigger[a.id] ?? 0,
    // 발동(triggered)을 실을 수 있는 훅은 onFire/onAfterShot 뿐이다.
    // mods 전용(거리·용량)이나 onCombatStart 전용은 '발동' 개념 자체가 없다.
    hooked: a.hooks?.onFire !== undefined || a.hooks?.onAfterShot !== undefined,
  }))

  const total = tel.magsPerCombat.length
  const neverEquipped = rows.filter((r) => r.eq === 0)
  const deadCondition = rows.filter((r) => r.hooked && r.eq > 0 && r.tr === 0)

  L.push(`   전투 ${total}회 · 런 ${runs}판`)
  L.push('')
  L.push(`   ❌ 한 번도 장착되지 않음 (${neverEquipped.length}/${rows.length}종)`)
  for (const r of neverEquipped) L.push(`      ${pad(r.name, 18)} ${r.tag}`)
  L.push('')
  L.push(`   ⚠ 훅이 있는데 한 번도 발동하지 않음 (${deadCondition.length}종) — 조건이 죽었다`)
  for (const r of deadCondition) L.push(`      ${pad(r.name, 18)} ${pad(r.tag, 20)} 장착 ${r.eq}회`)
  L.push('')
  L.push('   ▸ 장착률 상위 — 한쪽으로 쏠려 있으면 그게 지배 부착물이다')
  for (const r of rows.slice().sort((x, y) => y.eq - x.eq).slice(0, 12)) {
    const share = total === 0 ? 0 : r.eq / total
    L.push(
      `      ${pad(r.name, 18)} ${pad(r.tag, 20)} 장착 ${padS(String(r.eq), 5)}` +
        ` (${padS((share * 100).toFixed(0) + '%', 5)})  발동 ${padS(String(r.tr), 6)}`,
    )
  }

  L.push('')
  L.push('▣ 특수탄 실사용')
  line()
  const spRows = SPECIALS.map((s) => [s.name, s.rarity, tel.specialShots[s.id] ?? 0] as const)
  for (const r of spRows.slice().sort((a, b) => b[2] - a[2])) {
    L.push(`   ${pad(r[0], 14)} ${pad(r[1], 10)} ${padS(String(r[2]), 6)}발`)
  }
  const unusedSp = spRows.filter((r) => r[2] === 0)
  if (unusedSp.length > 0) L.push(`   ❌ 한 발도 안 쏜 특수탄: ${unusedSp.map((r) => r[0]).join(', ')}`)

  L.push('')
  L.push('▣ 전투 형태')
  line()
  const avg = (a: number[]): number => (a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length)
  const hist: Record<number, number> = {}
  for (const m of tel.magsPerCombat) hist[Math.min(9, m)] = (hist[Math.min(9, m)] ?? 0) + 1
  L.push(`   전투당 평균 ${avg(tel.magsPerCombat).toFixed(2)}탄창`)
  L.push(
    '   탄창 수 분포  ' +
      Object.keys(hist)
        .map(Number)
        .sort((a, b) => a - b)
        .map((k) => `${k}장:${hist[k]}`)
        .join('  '),
  )
  L.push(`   사격 종료 시 온도 평균 ${avg(tel.heatAtMagEnd).toFixed(2)} (이 값의 50%가 다음 사격으로 이월된다)`)
  const wf = tel.winDistFrac
  L.push(
    `   승리 시 남은 거리 비율 평균 ${(avg(wf) * 100).toFixed(0)}%` +
      `  (0% 에 가까울수록 아슬아슬한 전투)`,
  )
  return L.join('\n')
}

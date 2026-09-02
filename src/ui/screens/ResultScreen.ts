// 결과 화면 — 승/패, 도달 섹터, 사인, 통계, 최종 빌드.
//
// ★ 즉사는 완충이 없으므로 "무엇 때문에 죽었는가"의 인과를 반드시 문장으로 남긴다
//   (PRESENTATION §2.5). cause 는 호출부가 만들어 넘기고, deathCause() 로 문장을 만들 수 있다.
//
// 이 화면이 메타 기록(recordResult)과 저장 삭제(clearRun)를 함께 수행한다.
// 호출부에서 또 부르지 마라 — 시도 횟수가 두 번 오른다.

import type { RunState } from '../../core/types'
import { FINAL_SECTOR } from '../../core/run'
import { add, fmtInt, on } from '../dom'
import { clearRun, loadMeta, recordResult } from '../save'
import {
  specialsList,
  button,
  buttonRow,
  header,
  loadoutStrip,
  openScreen,
  section,
  statRow,
} from './LoadoutSheet'

/** 보유 특수탄 총 발수 — v2 에서 '가방'을 대신하는 지표 */
function specialCount(l: { specials: Record<string, number> }): number {
  let n = 0
  for (const v of Object.values(l.specials)) n += v
  return n
}


/**
 * 즉사 사인 문장. PRESENTATION §2.5 의 요구 표기를 그대로 만든다.
 *   deathCause(3, 5) → "마지막 사격에서 −5m, 거리 3m 남음 → 접촉"
 *   deathCause(0)    → "마지막 사격 후 남은 거리 0m → 접촉"
 */
export function deathCause(distanceLeft: number, moveCost?: number): string {
  const d = Number.isFinite(distanceLeft) ? Math.max(0, Math.round(distanceLeft * 10) / 10) : 0
  if (moveCost !== undefined && Number.isFinite(moveCost) && moveCost > 0) {
    return '마지막 사격에서 −' + moveCost + 'm, 거리 ' + d + 'm 남음 → 접촉'
  }
  return '마지막 사격 후 남은 거리 ' + d + 'm → 접촉'
}

/** 사인 문장이 "접촉"으로 끝나도록 보정한다 (인과 표기는 타협 불가) */
function normalizeCause(cause: string): string {
  const t = cause.trim()
  if (t === '') return '적과 접촉했다.'
  if (t.includes('접촉')) return t
  return t + ' → 접촉'
}

export function showResult(
  host: HTMLElement,
  run: RunState,
  won: boolean,
  cause: string,
): Promise<'restart' | 'title'> {
  const sc = openScreen(host, won ? '완주' : '전멸')
  const { root, bin } = sc

  // 런은 여기서 끝난다 — 저장을 지우고 메타에 남긴다
  const meta0 = loadMeta()
  const meta = recordResult(run, won)
  clearRun()

  header(
    root,
    won ? '정화 완료' : '접촉',
    won
      ? '섹터 ' + FINAL_SECTOR + ' 를 넘어섰다.'
      : '섹터 ' + run.sector + ' · 노드 ' + (run.nodeIndex + 1) + '/5 에서 멈췄다.',
  )

  // --- 사인 (즉사 인과) ---
  const causeBox = add(root, 'div', 'pick')
  causeBox.style.borderColor = won ? 'var(--brass-dim)' : '#7d2229'
  causeBox.style.background = won ? '#151109' : '#160d0f'
  const cb = add(causeBox, 'div', 'pick-body')
  add(cb, 'div', 'pick-name', won ? '결과' : '사인')
  const causeText = add(
    cb,
    'div',
    'pick-text',
    won ? '성역에 도달했다. 총열은 아직 뜨겁다.' : normalizeCause(cause),
  )
  causeText.style.fontSize = '13px'
  causeText.style.color = 'var(--text)'

  // --- 통계 ---
  section(root, '이번 런')
  const st = add(root, 'div')
  statRow(st, '도달', '섹터 ' + run.sector + ' · 노드 ' + (run.nodeIndex + 1))
  statRow(st, '정화한 적', fmtInt(run.stats.combatsWon) + '체')
  statRow(st, '발사한 탄', fmtInt(run.stats.shotsFired) + '발')
  statRow(st, '누적 피해', fmtInt(run.stats.totalDamage))
  statRow(st, '최고 온도', run.stats.peakHeat.toFixed(2))
  statRow(st, '번 탄피', fmtInt(run.stats.brassEarned))
  statRow(st, '남은 탄피', fmtInt(run.loadout.brass))
  statRow(st, '성전 등급', String(run.stake))
  statRow(st, '시드', String(run.seed))

  // --- 최종 빌드 ---
  section(root, '최종 빌드')
  root.appendChild(loadoutStrip(run.loadout, bin))
  const mag = run.loadout.magazine
  const magLine = add(root, 'p', undefined, mag === null ? '탄창 없음' : mag.name + ' — ' + mag.text)
  magLine.style.fontSize = '11px'

  // --- 메타 ---
  section(root, '기록')
  const mt = add(root, 'div')
  statRow(mt, '최고 도달 섹터', '섹터 ' + meta.bestSector)
  statRow(mt, '완주', fmtInt(meta.wins) + '회')
  statRow(mt, '시도', fmtInt(meta.runs) + '회')
  if (meta.unlockedStake > meta0.unlockedStake) {
    const unlock = add(root, 'p', undefined, '성전 등급 ' + meta.unlockedStake + ' 이(가) 열렸다.')
    unlock.style.color = 'var(--brass)'
  }

  add(root, 'div', 'spacer')
  const row = buttonRow(root)
  const titleBtn = button(row, '타이틀', { kind: 'ghost', grow: 1 })
  const againBtn = button(row, '다시 시작', { kind: 'primary', grow: 1.4, sub: '새 시드' })

  let settled = false
  return new Promise<'restart' | 'title'>((resolve) => {
    const finish = (r: 'restart' | 'title'): void => {
      if (settled) return
      settled = true
      sc.close()
      resolve(r)
    }
    bin.add(on(titleBtn, 'click', () => finish('title')))
    bin.add(on(againBtn, 'click', () => finish('restart')))
  })
}

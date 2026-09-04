// ============================================================================
// 부착물 (Attachments) — v2 에서는 이것이 빌드의 전부다
//
//   탄종·등급이 사라졌으므로 조건절은 다음으로만 구성된다:
//     항상 / 첫 탄 / 마지막 탄 / N번째 / 기본탄 / 특수탄 / 직전이 특수탄
//     / 온도 T 이상 / 거리 D 이하·이상 / 이번 탄창 특수탄 K발 이상
//
//   BALANCE §7.5 법칙:
//     R6 — 시작 온도(startHeat)를 올리는 것은 탄창 부위와 유물만 허용한다.
//     R7 — 희귀 이상 등급의 온도 부착물은 조건부여야 한다.
// ============================================================================
import type { Attachment, CombatState, FireCtx, Rarity, Rng, SlotKind } from '../types'
import { computeCap } from '../pipeline'
import { TA, n, pc, sg } from './tuning'

function proc(c: FireCtx): void {
  c.triggered.push(c.self)
}

function getVar(s: CombatState, key: string): number {
  const v = s.vars[key]
  return typeof v === 'number' ? v : 0
}

/** 런 스코프 카운터 — 전투가 끝나도 살아남아 런 내내 자란다 (스케일링 조커) */
function getRunVar(s: CombatState, key: string): number {
  const v = s.runVars[key]
  return typeof v === 'number' ? v : 0
}

function addRunVar(s: CombatState, key: string, delta: number): void {
  if (s.dryRun) return
  s.runVars[key] = getRunVar(s, key) + delta
}

/** 무작위 특수탄 보급 (탄띠 걸이) */
function supply(s: CombatState, n: number): void {
  if (s.dryRun) return
  const ids = Object.keys(s.specials)
  const pool = ids.length > 0 ? ids : ['sp_incendiary']
  for (let i = 0; i < n; i += 1) {
    const id = pool[s.rng.int(pool.length)]
    s.specials[id] = (s.specials[id] ?? 0) + 1
  }
}

const isSpecial = (c: FireCtx): boolean => c.round.special !== null
const isBasic = (c: FireCtx): boolean => c.round.special === null
const prevWasSpecial = (c: FireCtx): boolean => c.prev !== null && c.prev.special !== null
const specialsInMag = (c: FireCtx): number =>
  c.s.magPlan.reduce((n, r) => n + (r.special !== null ? 1 : 0), 0)

export const ATTACHMENTS: Attachment[] = [
  // =========================================================================
  // 총열 (Barrel) — 데미지 축. 곱해질 값을 키운다.
  // =========================================================================
  {
    id: 'br_long',
    name: '연장 총열',
    slot: 'barrel',
    rarity: 'common',
    text: '모든 탄 DMG ' + sg(TA.br_long.dmg),
    hooks: { onFire: (c) => { c.dmg += TA.br_long.dmg; proc(c) } },
  },
  {
    id: 'br_heavy',
    name: '중(重)총열',
    slot: 'barrel',
    rarity: 'common',
    text: '기본탄 DMG ' + sg(TA.br_heavy.dmg),
    hooks: { onFire: (c) => { if (isBasic(c)) { c.dmg += TA.br_heavy.dmg; proc(c) } } },
  },
  {
    id: 'br_compensator',
    name: '소염기',
    slot: 'barrel',
    rarity: 'uncommon',
    // 첫 '두' 탄. 첫 탄만이면 cap9 에서 1/9 만 맞아 커먼 중총열에 지배당한다.
    text: '탄창의 첫 ' + n(TA.br_compensator.upto + 1) + '탄 DMG ' + sg(TA.br_compensator.dmg),
    hooks: { onFire: (c) => { if (c.index <= TA.br_compensator.upto) { c.dmg += TA.br_compensator.dmg; proc(c) } } },
  },
  {
    id: 'br_bayonet',
    name: '총검 거치대',
    slot: 'barrel',
    rarity: 'uncommon',
    // 실측 42,587발 중 거리 ≤10 인 발사는 15.9%. 기대치 60×0.19=11.6 은
    // 커먼 연장 총열의 무조건 +14 보다 낮았다 — 조건부가 무조건보다 약하면 안 된다.
    // 실측 거리 ≤10 발사는 8.8% 뿐 — +120 의 기대치는 무조건 발동 커먼보다 낮았다.
    // 시작 거리가 26m 로 좁아진 뒤 조건 성립률이 크게 올랐다 (채택 416/600, 리프트 +7.4%).
    text: '거리 ' + n(TA.br_bayonet.thr) + 'm 이하면 모든 탄 DMG ' + sg(TA.br_bayonet.dmg),
    hooks: { onFire: (c) => { if (c.s.distance <= TA.br_bayonet.thr) { c.dmg += TA.br_bayonet.dmg; proc(c) } } },
  },
  {
    id: 'br_catalyst',
    name: '촉매 총열',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '특수탄 DMG ' + sg(TA.br_catalyst.dmg),
    hooks: { onFire: (c) => { if (isSpecial(c)) { c.dmg += TA.br_catalyst.dmg; proc(c) } } },
  },
  {
    id: 'br_judgment',
    name: '심판의 총열',
    slot: 'barrel',
    rarity: 'rare',
    // 비율 보정은 옵틱 3중첩과 만나면 되먹임이 된다 — 상한을 박는다.
    text: '마지막 탄에 이번 탄창 누적 피해의 ' + pc(TA.br_judgment.pct) + '% 추가 (최대 ' + sg(TA.br_judgment.max) + ')',
    hooks: {
      onFire: (c) => {
        if (!c.isLast) return
        // 상한 180 은 누적 3,600 부터 상시 구속돼 '마지막 탄 +180 고정' 이 됐다.
        // 400/8% 는 리프트 +14.7% (레어 상단) — 320/7% 로.
        const add = Math.min(TA.br_judgment.max, Math.round(c.s.magDamage * TA.br_judgment.pct))
        if (add <= 0) return
        c.dmg += add
        proc(c)
      },
    },
  },
  {
    id: 'br_volatile',
    name: '폭발 볼트 총열',
    slot: 'barrel',
    rarity: 'rare',
    // 무상한 누적은 런 후반에 ×15 까지 갔다 (실측 특수탄 56발/런).
    // 덧셈 게임에 몰래 들어온 지수 성장이라 상한을 건다.
    // +30/+40 은 리프트 +19%(n=75). 런 후반 상시 +70 평탄은 레어 밴드 밖이다. +25/+30.
    text: '모든 탄 DMG ' + sg(TA.br_volatile.dmg) + '. 특수탄을 쏠 때마다 ' + sg(TA.br_volatile.step) + ' 누적 (최대 ' + sg(TA.br_volatile.max) + ')',
    hooks: {
      onFire: (c) => {
        c.dmg += TA.br_volatile.dmg + Math.min(TA.br_volatile.max, getRunVar(c.s, c.self))
        proc(c)
      },
      onAfterShot: (c) => {
        if (isSpecial(c)) addRunVar(c.s, c.self, TA.br_volatile.step)
      },
    },
  },
  {
    id: 'br_archetype',
    name: '볼터의 원형',
    slot: 'barrel',
    rarity: 'relic',
    // 총열은 순회 최선두라 대입값 위에 광학·개머리판 보너스가 다시 얹힌다
    // (실측 AP 230 → 기본탄 350). 툴팁이 그 사실을 숨기고 있었다.
    // 탄창 스코프는 채택 0회였다 — 같은 탄창에 특수탄을 넣어야 켜지니 기본탄 전용
    // 탄창에서 죽었다. **전투 스코프**로 넓힌다: 관통탄 한 발이 그 전투의 기본탄 전부를
    // 150 짜리로 만든다. 유물답게 '한 발이 전투를 바꾼다'.
    text: '기본탄의 기본 DMG 가 이번 전투에서 쏜 특수탄 최고 DMG 의 ' + pc(TA.br_archetype.pct) + '% 로 대체된다',
    hooks: {
      onCombatStart: (c) => { c.s.vars[c.self] = 0 },
      onFire: (c) => {
        if (!isBasic(c)) return
        // 100% 대체는 유물 밴드의 4배였다 (실측 +259%). 60% 로도 기본탄이 특수탄급이 된다.
        const best = getVar(c.s, c.self) * TA.br_archetype.pct
        if (best > c.dmg) { c.dmg = best; proc(c) }
      },
      // **기본탄의 값은 기록하지 않는다.** 기록하면 자기가 올려준 값을 다시 최고값으로
      // 삼는 양의 되먹임이 되어 탄창마다 계단식으로 자란다 (실측 42 → 462, 11배).
      onAfterShot: (c) => {
        if (isBasic(c)) return
        if (c.dmg > getVar(c.s, c.self)) c.s.vars[c.self] = c.dmg
      },
    },
  },

  // =========================================================================
  // 총열덮개 (Handguard) — 온도 축. 유일한 곱셈 축이라 조건이 가장 까다롭다.
  // =========================================================================
  {
    id: 'hg_fin',
    name: '방열 핀',
    slot: 'handguard',
    rarity: 'common',
    text: '모든 탄 HEAT ' + sg(TA.hg_fin.heat),
    hooks: { onFire: (c) => { c.heatGain += TA.hg_fin.heat; proc(c) } },
  },
  {
    id: 'hg_catalyst',
    name: '소이 촉매',
    slot: 'handguard',
    rarity: 'common',
    text: '특수탄 HEAT ' + sg(TA.hg_catalyst.heat),
    hooks: { onFire: (c) => { if (isSpecial(c)) { c.heatGain += TA.hg_catalyst.heat; proc(c) } } },
  },
  {
    id: 'hg_gas',
    name: '압축 가스관',
    slot: 'handguard',
    rarity: 'common',
    // 대용량 탄창 전용 커먼. cap3 에서는 방열 핀에 지고 cap8+ 에서 이긴다.
    text: '탄창의 ' + n(TA.hg_gas.from + 1) + '번째 탄부터 HEAT ' + sg(TA.hg_gas.heat),
    hooks: { onFire: (c) => { if (c.index >= TA.hg_gas.from) { c.heatGain += TA.hg_gas.heat; proc(c) } } },
  },
  {
    id: 'hg_relay',
    name: '계전 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    // +2.4 는 커먼 소이 촉매(+45%)와 거의 동률이라 언커먼 계단이 없었다.
    text: '직전이 특수탄이었으면 HEAT ' + sg(TA.hg_relay.heat),
    hooks: { onFire: (c) => { if (prevWasSpecial(c)) { c.heatGain += TA.hg_relay.heat; proc(c) } } },
  },
  {
    id: 'hg_chain',
    name: '연쇄 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    // 계수 1.1 은 탄창당 +11.0 로 레어(순교 +0.5)를 크게 넘었다 — 등급 역전.
    text: '이미 쏜 탄 수 ×' + n(TA.hg_chain.step) + ' 만큼 HEAT + (상한 ' + sg(TA.hg_chain.step * TA.hg_chain.maxIndex) + ')',
    hooks: {
      onFire: (c) => {
        const v = Math.min(c.index, TA.hg_chain.maxIndex) * TA.hg_chain.step
        if (v <= 0) return
        c.heatGain += v
        proc(c)
      },
    },
  },
  {
    id: 'hg_furnace',
    name: '용광로 심장',
    slot: 'handguard',
    rarity: 'rare',
    // 이 부위에서 가장 까다로운 조건이다. 켜졌을 때 확실히 레어값을 해야 한다.
    text: '발사 전 온도 ' + n(TA.hg_furnace.thr) + ' 이상이면 HEAT ' + sg(TA.hg_furnace.heat),
    hooks: { onFire: (c) => { if (c.heatBefore >= TA.hg_furnace.thr) { c.heatGain += TA.hg_furnace.heat; proc(c) } } },
  },
  {
    id: 'hg_martyr',
    name: '순교의 화로',
    slot: 'handguard',
    rarity: 'rare',
    // 무상한 누적은 34탄창 만에 +249%(H1)까지 갔다. 상한 +0.7.
    text: '모든 탄 HEAT ' + sg(TA.hg_martyr.heat) + '. 사격을 마칠 때마다 ' + sg(TA.hg_martyr.step) + ' 누적 (최대 ' + sg(TA.hg_martyr.max) + ')',
    hooks: {
      onFire: (c) => { c.heatGain += TA.hg_martyr.heat + Math.min(TA.hg_martyr.max, getRunVar(c.s, c.self)); proc(c) },
      onMagEnd: (c) => { addRunVar(c.s, c.self, TA.hg_martyr.step) },
    },
  },
  {
    id: 'hg_inquisition',
    name: '이단심문관의 화염',
    slot: 'handguard',
    rarity: 'relic',
    // '남은 탄 2배' 뿐이면 특수탄이 마지막일 때 완전히 죽고, 기본탄만 있는
    // 탄창(실측 40.7%)에서도 0 이다. 유물이 커먼보다 약했다 — 바닥을 깔아준다.
    text: '특수탄 HEAT ' + sg(TA.hg_inquisition.heat) + '. 특수탄을 쏘면 이번 탄창의 남은 탄 온도 획득 2배',
    hooks: {
      onFire: (c) => { if (isSpecial(c)) { c.heatGain += TA.hg_inquisition.heat; proc(c) } },
      onAfterShot: (c) => {
        if (!isSpecial(c)) return
        c.s.heatDoublePending = true
        proc(c)
      },
    },
  },

  {
    id: 'hg_twoshot',
    name: '두 발의 계율',
    slot: 'handguard',
    rarity: 'rare',
    // UI 는 매 사격마다 'N/용량 발' 을 묻는데 답이 언제나 '용량까지' 였다 —
    // magPlan.length 를 읽는 부착물이 카탈로그에 하나도 없었기 때문이다.
    // ★ cap<=2 가드는 필수다. 없으면 탐식의 성궤(용량 2)에서 조건이 무조건 성립해
    //   실측 처리량이 6.39배로 터진다.
    text: '용량보다 적게, 정확히 ' + n(TA.hg_twoshot.load) + '발만 장전하면 모든 탄 HEAT ' + sg(TA.hg_twoshot.heat),
    hooks: {
      onFire: (c) => {
        if (c.s.cap <= TA.hg_twoshot.load || c.s.magPlan.length !== TA.hg_twoshot.load) return
        c.heatGain += TA.hg_twoshot.heat
        proc(c)
      },
    },
  },
  {
    id: 'hg_pyre',
    name: '분신의 배기구',
    slot: 'handguard',
    rarity: 'uncommon',
    // 거리는 이 게임의 목숨이자 행동 수인데, 그 자원을 **자발적으로 태워** 화력으로
    // 바꾸는 카드가 한 장도 없었다 (참회의 사슬은 전투 시작 거리를 한 번 깎을 뿐이다).
    // 하한 1m — 배기구가 스스로 플레이어를 죽이면 안 된다. 죽음은 사격 비용이 정한다.
    text: '사격을 시작할 때 거리 ' + n(TA.hg_pyre.burn) + 'm 를 태운다 · 이번 사격의 모든 탄 HEAT ' + sg(TA.hg_pyre.heat),
    hooks: {
      onMagStart: (c) => { c.s.distance = Math.max(1, c.s.distance - TA.hg_pyre.burn) },
      onFire: (c) => { c.heatGain += TA.hg_pyre.heat; proc(c) },
    },
  },

  // =========================================================================
  // 광학 (Optic) — 정보·거리·특수탄 축
  // =========================================================================
  {
    id: 'op_laser',
    name: '레이저 지시기',
    slot: 'optic',
    rarity: 'common',
    text: '거리 ' + n(TA.op_laser.thr) + 'm 이상이면 모든 탄 DMG ' + sg(TA.op_laser.dmg),
    hooks: { onFire: (c) => { if (c.s.distance >= TA.op_laser.thr) { c.dmg += TA.op_laser.dmg; proc(c) } } },
  },

  {
    id: 'op_thermal',
    name: '열화상 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    text: '특수탄이 탄창에 ' + n(TA.op_thermal.need) + '발 이상이면 모든 탄 DMG ' + sg(TA.op_thermal.dmg),
    hooks: {
      onFire: (c) => { if (specialsInMag(c) >= TA.op_thermal.need) { c.dmg += TA.op_thermal.dmg; proc(c) } },
    },
  },
  {
    id: 'op_soulmark',
    name: '영혼 표식',
    slot: 'optic',
    rarity: 'rare',
    // 전투당 1회 발동은 실측 처리량 기여 +1.6% — 희귀 중앙값 +41.5% 의 4% 였다.
    // 상시 조건부로 바꾼다. 조건이 전투 후반에 걸리므로 순서 결정을 깎지 않는다.
    // '적 HP 60% 이하' 는 봇 오라클(HP 1e12 프로브)에 영원히 안 보여 채택 0회였다.
    // 같은 뜻('전투 후반에 켜진다')을 **사격 횟수**로 표현하면 오라클도 사람도 읽는다.
    // +2.4 는 리프트 +16.1%(n=177) — 장기전이 흔해진 페이싱에서 상시 곱셈이었다. +1.8.
    text: '전투의 두 번째 사격부터 모든 탄 HEAT ' + sg(TA.op_soulmark.heat) + '. 전투를 이길 때마다 ' + sg(TA.op_soulmark.step) + ' 누적(런)',
    hooks: {
      onFire: (c) => {
        if (c.s.magsFired < 1) return
        c.heatGain += TA.op_soulmark.heat + getRunVar(c.s, c.self)
        proc(c)
      },
      onCombatEnd: (c) => { if (c.s.enemy.hp <= 0) addRunVar(c.s, c.self, TA.op_soulmark.step) },
    },
  },
  {
    id: 'op_quartermaster',
    name: '병참 렌즈',
    slot: 'optic',
    rarity: 'rare',
    // 매 탄창 무료 1발은 특수탄이 희소해진 뒤 리프트 +19.8%(n=83) — 사실상 특수탄
    // 공급 2배였다. 전투의 첫 사격에서만.
    // '매 사격' 무제한은 특수탄 경제를 통째로 무효화한다 (실측 처리량 +82.8%,
    // 영웅 밴드 41.8~62.7 의 위). 전투당 몇 번째 사격까지인지를 눈금으로 두어
    // '길게 끄는 전투에서는 결국 값을 낸다' 는 성격만 남긴다.
    text: '전투의 처음 ' + n(TA.op_quartermaster.mags) + '번 사격은 첫 특수탄이 소모되지 않는다',
    hooks: {
      onMagStart: (c) => {
        if (c.s.magsFired >= TA.op_quartermaster.mags) return
        c.s.flags['freeFirstSpecial'] = true
      },
    },
  },
  {
    id: 'op_emperor',
    name: '황제의 눈',
    slot: 'optic',
    rarity: 'relic',
    text: '특수탄 DMG ' + sg(TA.op_emperor.dmg) + ', HEAT ' + sg(TA.op_emperor.heat),
    hooks: {
      onFire: (c) => {
        if (!isSpecial(c)) return
        c.dmg += TA.op_emperor.dmg
        c.heatGain += TA.op_emperor.heat
        proc(c)
      },
    },
  },

  // =========================================================================
  // 개머리판 (Stock) — 자원·경제 축. "몇 번이나" 쏘는가.
  // =========================================================================
  {
    // 광학에 있던 '간이 거리계'. 이 효과는 데미지가 아니라 **행동 수**를 늘린다 —
    // 축으로 보면 개머리판이다. 광학은 조건·콤보 축으로 정리했다.
    id: 'st_rangefinder',
    name: '간이 거리계',
    slot: 'stock',
    rarity: 'common',
    // 커먼인데 리프트 +9.8% — 행동 수를 건드리는 카드는 대가가 있어야 한다.
    text: '사격 거리 소모 ' + sg(TA.st_rangefinder.fireCost) + 'm',
    mods: { fireCost: TA.st_rangefinder.fireCost },
  },
  {
    id: 'st_fixed',
    name: '고정 개머리판',
    slot: 'stock',
    rarity: 'common',
    // 페이싱이 조여진 뒤(여유 배수 0.9) 시작 거리 +8m 은 행동 수 +2 — 커먼인데
    // 리프트 +19%, +6m 에서도 +21%(n=34, R5~R10 내내 상위). +5m 으로.
    // (간이 거리계는 −1m/사격이라 4사격 이상 장기전에서 이걸 앞선다)
    text: '전투 시작 거리 ' + sg(TA.st_fixed.startDist) + 'm',
    mods: { startDist: TA.st_fixed.startDist },
  },
  {
    id: 'st_charm',
    name: '황동 부적',
    slot: 'stock',
    rarity: 'common',
    // +6 은 커먼인데 리프트 +9.1%(n=110). 특수탄 값이 오른 만큼 탄피 값도 올랐다. +4.
    text: '발사할 때마다 탄피 ' + sg(TA.st_charm.brass),
    hooks: {
      onAfterShot: (c) => {
        if (c.s.dryRun) return
        c.s.loadout.brass += TA.st_charm.brass
        proc(c)
      },
    },
  },
  {
    id: 'st_buffer',
    name: '완충기',
    slot: 'stock',
    rarity: 'uncommon',
    text: '사격 거리 소모 ' + sg(TA.st_buffer.fireCost) + 'm · 전투 시작 거리 ' + sg(TA.st_buffer.startDist) + 'm',
    mods: { startDist: TA.st_buffer.startDist, fireCost: TA.st_buffer.fireCost },
  },
  {
    id: 'st_penance',
    name: '참회의 사슬',
    slot: 'stock',
    rarity: 'uncommon',
    // 기본탄 12 에 +55 를 얹으면 총화력이 5.6배가 된다 — 언커먼 하나로 게임이 끝났다
    // (실측 장착률 41%, 전 부착물 1위). 대가(−10m)는 그대로 두고 값만 내린다.
    text: '전투 시작 거리 ' + sg(TA.st_penance.startDist) + 'm · 모든 탄 DMG ' + sg(TA.st_penance.dmg),
    mods: { startDist: TA.st_penance.startDist },
    hooks: { onFire: (c) => { c.dmg += TA.st_penance.dmg; proc(c) } },
  },
  {
    id: 'st_reliquary',
    name: '성유물 거치대',
    slot: 'stock',
    rarity: 'rare',
    // 칸만 주면 처리량 기여가 정확히 0 이라 실측 채택률도 0 이었다.
    // 희귀값을 하려면 켜자마자 효과가 있어야 한다 — 행동 수 축 보너스를 얹는다.
    // 페이싱을 조이자(여유 배수 0.8) 사격 비용 −2 는 행동 수를 최대 2.5배로 불려
    // 승률 리프트 +27.6% 로 유물보다 셌다. −1 로 내리니 간이 거리계(커먼, −1m)와
    // 동일해져 채택 0 — 축을 시작 거리로 바꿔 정체성을 준다.
    text: '보조 광학 칸 ' + sg(TA.st_reliquary.railSlots) + ' · 전투 시작 거리 ' + sg(TA.st_reliquary.startDist) + 'm',
    mods: { railSlots: TA.st_reliquary.railSlots, startDist: TA.st_reliquary.startDist },
  },
  {
    id: 'st_stride',
    name: '거인의 보폭',
    slot: 'stock',
    rarity: 'rare',
    // 속도 −3 은 배회자(5) 를 2 로 만들어 행동 수 2.5배 — 리프트 +33.7%. −2 로 내려도
    // +26.8%. 속도 축은 곱셈이라 대가 없이는 못 준다 — 시작 거리 −8m 을 붙인다.
    // 속도 축은 행동 수를 직접 늘려 곱셈처럼 작동한다 — 리프트 +18.8%.
    // 페이싱이 3~5행동으로 좁아진 뒤로는 −2 하나가 전투를 두 배로 만든다.
    text: '적 접근 속도 ' + sg(TA.st_stride.enemySpeed) + ' · 전투 시작 거리 ' + sg(TA.st_stride.startDist) + 'm',
    mods: { enemySpeed: TA.st_stride.enemySpeed, startDist: TA.st_stride.startDist },
  },
  {
    id: 'st_bandolier',
    name: '탄띠 걸이',
    slot: 'stock',
    rarity: 'relic',
    // 전투당 2발은 장기전에서 값이 죽는다. 사격당 1발이면 전투가 길수록 커진다 —
    // 거리(=사격 횟수)를 쓰는 유물이 되어 축이 맞는다.
    // 전투 시작 2발 + 사격마다 1발. 전투 시작분이 없으면 첫 탄창에 값이 0 이라
    // 유물을 집었는데 그 전투에서 아무 일도 안 일어난다.
    // 전투 2발이면 황제+계약+성사 3광학 조합이 단일 탄창 11.5배(R3 12배)에 닿는다.
    // 특수탄을 희소하게 만들자(2/2/1) 무제한 보급은 승률 리프트 +39% 였다.
    // 유물은 세도 되지만 '특수탄 경제를 통째로 무효화' 는 안 된다 — 전투당 상한 3발.
    // 상한 3 이어도 리프트 +55%(n=40) — 런당 60발 넘게 공급했다. 사격 보급은 2발까지.
    text: '전투 시작 시 무작위 특수탄 ' + n(TA.st_bandolier.start) + '발 · 사격을 시작할 때마다 ' + n(TA.st_bandolier.perMag) + '발 보급 (전투당 최대 ' + n(TA.st_bandolier.max) + '발)',
    hooks: {
      onCombatStart: (c) => { c.s.vars[c.self] = 0; supply(c.s, TA.st_bandolier.start) },
      onMagStart: (c) => {
        const k = getVar(c.s, c.self)
        if (k >= TA.st_bandolier.max) return
        c.s.vars[c.self] = k + 1
        supply(c.s, TA.st_bandolier.perMag)
      },
    },
  },

  {
    id: 'st_glacier',
    name: '빙하의 성해',
    slot: 'stock',
    rarity: 'relic',
    // R6 확장 문언 — startHeat/heatCarry 를 건드리는 것은 탄창 부위와 유물만 허용한다.
    // 이 유물은 그 특권을 **깎는 방향**으로 쓴다: 이월을 0 으로 만들어 "매 사격이 첫
    // 사격" 이 되게 하고, 대가를 저온 보너스로 돌려준다. 저온 축의 유일한 유물이다.
    // 급속 냉각기(−0.4)와 겹쳐도 computeHeatCarry 가 0 으로 클램프한다.
    text: '온도가 이월되지 않는다 · 발사 전 온도 ' + n(TA.st_glacier.thr) + ' 이하면 모든 탄 DMG ' + sg(TA.st_glacier.dmg),
    mods: { heatCarry: TA.st_glacier.carry },
    hooks: {
      onFire: (c) => {
        if (c.heatBefore > TA.st_glacier.thr) return
        c.dmg += TA.st_glacier.dmg
        proc(c)
      },
    },
  },

  // =========================================================================
  // 탄창 (Magazine) — 규칙 변경자. 용량이 곧 곱셈 횟수다.
  // =========================================================================
  {
    id: 'mg_standard',
    name: '표준 5연발',
    slot: 'magazine',
    rarity: 'common',
    text: '용량 ' + n(TA.mg_standard.cap) + '. 보정 없음',
    mag: { cap: TA.mg_standard.cap },
  },
  {
    id: 'mg_drum',
    name: '드럼 8연발',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 ' + n(TA.mg_drum.cap) + '. 온도 획득 ' + sg((TA.mg_drum.heatMul - 1) * 100) + '%',
    mag: { cap: TA.mg_drum.cap, heatGainMul: TA.mg_drum.heatMul },
  },
  {
    id: 'mg_precision',
    name: '정밀 3연발',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 ' + n(TA.mg_precision.cap) + '. 발사마다 HEAT ' + sg(TA.mg_precision.heat) + ' · 사격 거리 ' + sg(TA.mg_precision.fireCost) + 'm',
    mag: { cap: TA.mg_precision.cap },
    mods: { fireCost: TA.mg_precision.fireCost },
    hooks: { onFire: (c) => { c.heatGain += TA.mg_precision.heat; proc(c) } },
  },
  {
    id: 'mg_greed',
    name: '탐식의 성궤',
    slot: 'magazine',
    rarity: 'rare',
    text: '용량 ' + n(TA.mg_greed.cap) + '. 발사한 특수탄이 ' + pc(TA.mg_greed.keep) + '% 확률로 소모되지 않는다 (탄당 최대 2회 재발사)',
    mag: { cap: TA.mg_greed.cap, notConsumedChance: TA.mg_greed.keep },
  },
  {
    id: 'mg_coolant',
    name: '냉각 자켓',
    slot: 'magazine',
    rarity: 'rare',
    text: '용량 ' + n(TA.mg_coolant.cap) + '. 온도 이월 ' + sg(TA.mg_coolant.carry * 100) + '%p',
    mag: { cap: TA.mg_coolant.cap },
    mods: { heatCarry: TA.mg_coolant.carry },
  },
  {
    id: 'mg_executioner',
    name: '처형자',
    slot: 'magazine',
    rarity: 'rare',
    // R6 특권(startHeat)을 쓰는 유일한 부위. +18 은 테르밋탄 1발(48 heat·shot)의
    // 37% 값어치라 특권이 무의미했다. +34 로 71% 까지 올린다.
    text: '용량 ' + n(TA.mg_executioner.cap) + '. 사격 시작 온도 ' + sg(TA.mg_executioner.startHeat) + ' · 사격 거리 ' + sg(TA.mg_executioner.fireCost) + 'm',
    mag: { cap: TA.mg_executioner.cap },
    mods: { startHeat: TA.mg_executioner.startHeat, fireCost: TA.mg_executioner.fireCost },
  },
  {
    id: 'mg_penitent',
    name: '참회의 탄대',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 ' + n(TA.mg_penitent.cap) + '. 첫 탄 DMG 0, 이후 모든 탄 HEAT ' + sg(TA.mg_penitent.heat),
    mag: { cap: TA.mg_penitent.cap },
    hooks: {
      onFire: (c) => {
        // "첫 발은 제물" 규칙의 직접 구현 — 이 게임에서 유일한 대입 예외다.
        if (c.isFirst) { c.dmg = 0; proc(c); return }
        c.heatGain += TA.mg_penitent.heat
        proc(c)
      },
    },
  },
  {
    id: 'mg_belt',
    name: '무한 벨트',
    slot: 'magazine',
    rarity: 'relic',
    // 용량 사다리를 1/2/3/4/5/6/7/12 로 벌린다 — 유물이 한눈에 최대 실루엣이 된다.
    // 용량 12 는 리프트 +25.2%(n=105) — 유물이어도 '집으면 이긴다' 는 선을 넘었다.
    // 용량은 온도 누적의 지수축이라 값을 조금만 줄여도 크게 내려온다.
    text: '용량 ' + n(TA.mg_belt.cap) + '. 온도 획득 ' + sg((TA.mg_belt.heatMul - 1) * 100) + '%',
    mag: { cap: TA.mg_belt.cap, heatGainMul: TA.mg_belt.heatMul },
  },
  {
    id: 'mg_annex',
    name: '증축 탄창',
    slot: 'magazine',
    rarity: 'rare',
    // 탄창 9종이 전부 **고정 용량**이라 '용량' 은 장착 시점에 정해지고 끝나는 값이었다.
    // 이 탄창은 전투 안에서 용량이 자라므로, 용량 조건부 카드(압축 가스관 index>=2,
    // 연쇄 점화, 성수 앰플 isLast, 소염기 index<=1)의 성립률이 사격마다 바뀐다.
    // cap 은 fire() 가 validatePlan 에서 먼저 읽으므로 반드시 **사격이 끝난 뒤** 올린다.
    // 성장분을 vars 로 따로 들고 있어야 전투 중 부착물 교체(swapAttachment 가
    // computeCap 으로 cap 을 다시 잡는다)에도 다음 magEnd 에서 복원된다.
    // 최대 10 은 4탄창+ 전투(실측 30%)에서 드럼 8연발을 넘어섰다 — 리프트 +18%. 최대 8.
    text: '용량 ' + n(TA.mg_annex.cap) + '. 사격을 마칠 때마다 이번 전투 동안 용량 ' + sg(TA.mg_annex.step) + ' (최대 ' + n(TA.mg_annex.cap + TA.mg_annex.max) + ')',
    mag: { cap: TA.mg_annex.cap },
    hooks: {
      onMagEnd: (c) => {
        const g = Math.min(TA.mg_annex.max, getVar(c.s, c.self) + TA.mg_annex.step)
        c.s.vars[c.self] = g
        c.s.cap = computeCap(c.s.loadout) + g
      },
    },
  },

  {
    id: 'op_deferral',
    name: '유예의 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    // 이 게임의 배열 규칙은 '예열 먼저, 큰 것 나중' 하나뿐이고 카탈로그에 반례가 없었다.
    // 마지막 칸을 **나쁘게** 만드는 첫 카드다. 죽음의 성사(마지막 탄이 특수탄이면 HEAT +14)와
    // 논리적으로 배타라, 광학 3칸에서 처음으로 '이 둘은 같이 못 쓴다' 는 쌍이 생긴다.
    // '특수탄이 있을 때만' 을 반드시 건다 — 안 걸면 기본탄만인 탄창(실측 40.7%)에서
    // 조건이 공짜로 성립해 그냥 무조건 +DMG 가 된다.
    // +55 는 리프트 +10.5%(n=82) — 조건이 '특수탄 1발 + 기본탄 마무리' 라 거의 공짜였다. +40.
    text: '특수탄을 넣고도 기본탄으로 끝내면 모든 탄 DMG ' + sg(TA.op_deferral.dmg),
    hooks: {
      onFire: (c) => {
        const p = c.s.magPlan
        const last = p[p.length - 1]
        if (last === undefined || last.special !== null) return
        if (!p.some((r) => r.special !== null)) return
        c.dmg += TA.op_deferral.dmg
        proc(c)
      },
    },
  },
  {
    id: 'op_inquest',
    name: '이단 감식경',
    slot: 'optic',
    rarity: 'uncommon',
    // 갈림길은 문을 열기 전에 적의 패시브를 보여준다 (위험도3 100% / 2 30% / 1 0%).
    // 그런데 enemy.passive 를 읽는 부착물·특수탄이 0종이라, 런에서 가장 큰 결정인
    // '어느 문으로 갈까' 가 빌드와 아무 접점이 없었다. 이 카드가 그 접점이다.
    text: '적이 패시브를 지녔으면 모든 탄 DMG ' + sg(TA.op_inquest.dmg),
    hooks: {
      onFire: (c) => {
        if (c.s.enemy.passive === null) return
        c.dmg += TA.op_inquest.dmg
        proc(c)
      },
    },
  },
  {
    id: 'op_lastrites',
    name: '임종의 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    // 거리 조건 카드는 레이저 지시기(≥20m)와 총검 거치대(≤10m) 둘뿐이라, 거리는
    // 곱해질 값만 바꾸고 **곱하는 값**을 건드린 적이 없었다. 거리를 처음으로 온도에 잇는다.
    text: '거리 ' + n(TA.op_lastrites.thr) + 'm 이하면 모든 탄 HEAT ' + sg(TA.op_lastrites.heat),
    hooks: {
      onFire: (c) => {
        if (c.s.distance > TA.op_lastrites.thr) return
        c.heatGain += TA.op_lastrites.heat
        proc(c)
      },
    },
  },
  {
    id: 'op_poverty',
    name: '청빈의 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    // 실측 탄창의 40.7% 가 기본탄만으로 채워지는데 그 상태를 보상하는 카드가
    // 중(重)총열 하나뿐이었다. 진짜 값어치는 열화상·삼위일체·황제의 눈·죽음의 성사와
    // **동시에 켜질 수 없다**는 것 — 광학 세 칸을 채울 때 처음으로 '어느 축을 버릴까'
    // 라는 배제 결정이 생긴다.
    // 특수탄이 희소해지자 '기본탄만' 조건이 거의 상시 성립 — 리프트 +7.4%(n=204). +1.0.
    text: '탄창에 특수탄이 하나도 없으면 모든 탄 HEAT ' + sg(TA.op_poverty.heat),
    hooks: {
      onFire: (c) => {
        if (specialsInMag(c) > 0) return
        c.heatGain += TA.op_poverty.heat
        proc(c)
      },
    },
  },
  {
    id: 'op_vigil',
    name: '불침번의 렌즈',
    slot: 'optic',
    rarity: 'rare',
    // 성장형 3종(폭발 볼트·순교의 화로·영혼 표식)은 전부 **런 스코프**라 전투 안에서는
    // 상수다. 이 카드만 **전투 스코프**로 자라므로 "거리를 사서 사격 횟수를 늘린다" 는
    // 개머리판 축이 처음으로 피해로 환전된다. 상한 5회 = 유한자원(거리)이 곧 상한이다.
    text: '이번 전투에서 마친 사격 1회마다 모든 탄 DMG ' + sg(TA.op_vigil.step) + ' (최대 ' + sg(TA.op_vigil.step * TA.op_vigil.max) + ')',
    hooks: {
      onFire: (c) => {
        const k = Math.min(TA.op_vigil.max, c.s.magsFired)
        if (k <= 0) return
        c.dmg += k * TA.op_vigil.step
        proc(c)
      },
    },
  },
  {
    id: 'op_frostvault',
    name: '서리 성궤',
    slot: 'optic',
    rarity: 'rare',
    // 저온 축의 구조적 결함은 "보상이 DMG 라서, 조건이 성립하는 순간이 곱수가 가장
    // 작은 순간" 이라는 것이었다. 보상을 **온도**로 주되 마지막 탄 한 발에 몰아준다 —
    // 그래서 앞쪽 탄들의 저온 조건(급속 냉각기 ≤3.5, 한랭 총열 6−h)을 깨지 않는다.
    // 이 카드는 이 게임의 기본 휴리스틱(예열 먼저, 큰 것 나중)을 뒤집는다.
    text: '온도 ' + n(TA.op_frostvault.thr) + ' 이하에서 쏜 탄 1발마다 마지막 탄 HEAT ' + sg(TA.op_frostvault.step),
    hooks: {
      onMagStart: (c) => { c.s.vars[c.self] = 0 },
      onFire: (c) => {
        if (!c.isLast) return
        const k = getVar(c.s, c.self)
        if (k <= 0) return
        c.heatGain += k * TA.op_frostvault.step
        proc(c)
      },
      onAfterShot: (c) => {
        if (c.heatBefore <= TA.op_frostvault.thr) c.s.vars[c.self] = getVar(c.s, c.self) + 1
      },
    },
  },

  // =========================================================================
  // 광학 — 조건·콤보 축 (구 '보조 레일' 부착물).
  //   보조 레일은 이제 **효과 없는 추가 광학 칸**이므로, 조건·콤보 부착물은
  //   전부 광학 부위로 옮겼다. 광학은 하드포인트 1 + 레일 최대 2 = 최대 3중첩된다.
  // =========================================================================
  {
    id: 'op_holywater',
    name: '성수 앰플',
    slot: 'optic',
    rarity: 'common',
    text: '탄창의 마지막 탄 HEAT ' + sg(TA.op_holywater.heat),
    hooks: { onFire: (c) => { if (c.isLast) { c.heatGain += TA.op_holywater.heat; proc(c) } } },
  },
  {
    id: 'op_trinity',
    name: '삼위일체 각인',
    slot: 'optic',
    rarity: 'uncommon',
    // 조건이 열화상 조준경(≥2)의 진부분집합이라 페이로드가 낮으면 완전히 지배당한다.
    text: '탄창에 특수탄 ' + n(TA.op_trinity.need) + '발 이상이면 모든 탄 HEAT ' + sg(TA.op_trinity.heat),
    hooks: { onFire: (c) => { if (specialsInMag(c) >= TA.op_trinity.need) { c.heatGain += TA.op_trinity.heat; proc(c) } } },
  },
  {
    id: 'op_pact',
    name: '피의 계약',
    slot: 'optic',
    rarity: 'uncommon',
    // 임계 15(성립률 25.7%)에 +130 은 언커먼 밴드의 2배였다. 12(32.8%)/+70 으로.
    // +55 는 채택 32%/리프트 +7.2%(n=326) — 언커먼 중 유일하게 유의미한 양의 리프트. +45.
    text: '발사 전 온도 ' + n(TA.op_pact.thr) + ' 초과면 DMG ' + sg(TA.op_pact.dmg),
    hooks: { onFire: (c) => { if (c.heatBefore > TA.op_pact.thr) { c.dmg += TA.op_pact.dmg; proc(c) } } },
  },
  {
    // 순수 평탄 DMG 이므로 축으로 보면 총열이다.
    // 하락폭은 기본탄 바닥값(12)을 넘지 않게 잡는다 — 넘으면 적을 회복시킨다.
    id: 'br_gambler',
    name: '도박꾼의 성구',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '매 발사 50%로 DMG ' + sg(TA.br_gambler.up) + ', 50%로 ' + sg(-TA.br_gambler.down),
    hooks: {
      onFire: (c) => {
        // dryRun(봇 오라클·가치 분석기)에서는 기댓값을 준다 — 난수를 굴리면
        // 같은 계획을 두 번 재는 프로브가 매번 다른 답을 내 비교가 무너진다.
        const ev = (TA.br_gambler.up - TA.br_gambler.down) / 2
        if (c.s.dryRun) { c.dmg += ev; return }
        c.dmg += c.s.rng.next() < 0.5 ? TA.br_gambler.up : -TA.br_gambler.down
        proc(c)
      },
    },
  },
  {
    id: 'op_deathrite',
    name: '죽음의 성사',
    slot: 'optic',
    rarity: 'rare',
    text: '마지막 탄이 특수탄이면 그 탄 HEAT ' + sg(TA.op_deathrite.heat),
    hooks: {
      onFire: (c) => {
        if (!c.isLast || !isSpecial(c)) return
        c.heatGain += TA.op_deathrite.heat
        proc(c)
      },
    },
  },
  {
    // '무조건 최대 온도값 + 규칙 변경' 은 광학(조건·콤보 축)이 아니라 탄창이다.
    // 임계는 적 패시브 '열역학'(26)과 반드시 달라야 그 패시브가 살아 있다.
    id: 'mg_unstable',
    name: '불안정 노심',
    slot: 'magazine',
    rarity: 'rare',
    // 퓨즈 22 는 적 패시브 '열역학'(26)보다 낮아 그 패시브를 항상 무효로 만들었고,
    // 정상상태에서 3번째 발에 걸려 '용량 4' 가 영구히 3발이 됐다.
    text: '용량 ' + n(TA.mg_unstable.cap) + '. 발사마다 HEAT ' + sg(TA.mg_unstable.heat) + ' · 온도 이월 ' + sg(TA.mg_unstable.carry * 100) + '%p · 온도 ' + n(TA.mg_unstable.fuse) + ' 초과 시 사격 즉시 종료',
    mag: { cap: TA.mg_unstable.cap },
    mods: { heatCarry: TA.mg_unstable.carry },
    hooks: {
      onFire: (c) => { c.heatGain += TA.mg_unstable.heat; proc(c) },
      onAfterShot: (c) => { if (c.s.heat > TA.mg_unstable.fuse) c.s.abortMag = true },
    },
  },
  {
    id: 'hg_cryo',
    name: '급속 냉각기',
    slot: 'handguard',
    rarity: 'uncommon',
    // 임계 4 는 자기 이월 감소 덕에 5/5 전부 발동해 '조건'이 아니었다.
    // 3.5 로 낮추면 정상상태에서 4/5 만 켜져 배치 결정이 살아난다.
    // 저온 축(한랭 총열·냉동탄·초탄)의 유일한 진입점이다 — 여기가 죽으면 축 전체가 죽는다.
    text: '온도 이월 ' + sg(TA.hg_cryo.carry * 100) + '%p. 발사 전 온도 ' + n(TA.hg_cryo.thr) + ' 이하면 DMG ' + sg(TA.hg_cryo.dmg),
    mods: { heatCarry: TA.hg_cryo.carry },
    hooks: { onFire: (c) => { if (c.heatBefore <= TA.hg_cryo.thr) { c.dmg += TA.hg_cryo.dmg; proc(c) } } },
  },
  {
    id: 'br_frostbite',
    name: '한랭 총열',
    slot: 'barrel',
    rarity: 'rare',
    // 문턱을 12 → 6 으로. 12 면 이월 정상상태(약 7)에서도 늘 켜져 있어
    // "저온일 때만 강하다" 는 정체성이 성립하지 않았다.
    text: '발사 전 온도가 낮을수록 강하다 — DMG + (' + n(TA.br_frostbite.thr) + ' − 온도) × ' + n(TA.br_frostbite.mul),
    hooks: {
      onFire: (c) => {
        const gap = TA.br_frostbite.thr - c.heatBefore
        if (gap <= 0) return
        c.dmg += Math.round(gap * TA.br_frostbite.mul)
        proc(c)
      },
    },
  },
]

/**
 * 눈금(TA)을 카탈로그 객체에 다시 흘려보낸다.
 *   훅은 호출 때마다 TA 를 읽으므로 저절로 따라오지만, mods·mag 는 객체 **필드**라
 *   모듈 로드 시점에 굳는다. 튜너가 TA 를 흔든 뒤 이걸 불러야 용량·거리·이월이 반영된다.
 */
export function syncAttachments(): void {
  const t = TA as unknown as Record<string, Record<string, number>>
  for (const a of ATTACHMENTS) {
    const k = t[a.id]
    if (k === undefined) continue
    if (a.mag !== undefined) {
      if (typeof k['cap'] === 'number') a.mag.cap = k['cap']
      if (typeof k['heatMul'] === 'number') a.mag.heatGainMul = k['heatMul']
      if (typeof k['keep'] === 'number') a.mag.notConsumedChance = k['keep']
    }
    if (a.mods !== undefined) {
      const m = a.mods
      if (typeof k['fireCost'] === 'number') m.fireCost = k['fireCost']
      if (typeof k['startDist'] === 'number') m.startDist = k['startDist']
      if (typeof k['enemySpeed'] === 'number') m.enemySpeed = k['enemySpeed']
      if (typeof k['railSlots'] === 'number') m.railSlots = k['railSlots']
      if (typeof k['startHeat'] === 'number') m.startHeat = k['startHeat']
      if (typeof k['carry'] === 'number') m.heatCarry = k['carry']
    }
  }
}

export const ATT_BY_ID: Record<string, Attachment> = Object.fromEntries(
  ATTACHMENTS.map((a) => [a.id, a]),
)

export const STARTER_MAGAZINE = ATT_BY_ID['mg_standard']

export function attachmentsBySlot(slot: SlotKind): Attachment[] {
  return ATTACHMENTS.filter((a) => a.slot === slot)
}

export function attachmentsOfRarity(r: Rarity): Attachment[] {
  return ATTACHMENTS.filter((a) => a.rarity === r)
}

export function pickAttachment(
  rng: Rng,
  opts: { slot?: SlotKind; rarity: Rarity; exclude?: Set<string> },
): Attachment | null {
  const ex = opts.exclude ?? new Set<string>()
  const pool = ATTACHMENTS.filter(
    (a) => a.rarity === opts.rarity && (opts.slot === undefined || a.slot === opts.slot) && !ex.has(a.id),
  )
  if (pool.length === 0) return null
  return rng.pick(pool)
}

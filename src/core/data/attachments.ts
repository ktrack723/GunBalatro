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
    text: '모든 탄 DMG +14',
    hooks: { onFire: (c) => { c.dmg += 14; proc(c) } },
  },
  {
    id: 'br_heavy',
    name: '중(重)총열',
    slot: 'barrel',
    rarity: 'common',
    text: '기본탄 DMG +22',
    hooks: { onFire: (c) => { if (isBasic(c)) { c.dmg += 22; proc(c) } } },
  },
  {
    id: 'br_compensator',
    name: '소염기',
    slot: 'barrel',
    rarity: 'uncommon',
    // 첫 '두' 탄. 첫 탄만이면 cap9 에서 1/9 만 맞아 커먼 중총열에 지배당한다.
    text: '탄창의 첫 두 탄 DMG +95',
    hooks: { onFire: (c) => { if (c.index <= 1) { c.dmg += 95; proc(c) } } },
  },
  {
    id: 'br_bayonet',
    name: '총검 거치대',
    slot: 'barrel',
    rarity: 'uncommon',
    // 실측 42,587발 중 거리 ≤10 인 발사는 15.9%. 기대치 60×0.19=11.6 은
    // 커먼 연장 총열의 무조건 +14 보다 낮았다 — 조건부가 무조건보다 약하면 안 된다.
    text: '거리 10m 이하면 모든 탄 DMG +120',
    hooks: { onFire: (c) => { if (c.s.distance <= 10) { c.dmg += 120; proc(c) } } },
  },
  {
    id: 'br_catalyst',
    name: '촉매 총열',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '특수탄 DMG +70',
    hooks: { onFire: (c) => { if (isSpecial(c)) { c.dmg += 70; proc(c) } } },
  },
  {
    id: 'br_judgment',
    name: '심판의 총열',
    slot: 'barrel',
    rarity: 'rare',
    // 비율 보정은 옵틱 3중첩과 만나면 되먹임이 된다 — 상한을 박는다.
    text: '마지막 탄에 이번 탄창 누적 피해의 5% 추가 (최대 +180)',
    hooks: {
      onFire: (c) => {
        if (!c.isLast) return
        const add = Math.min(180, Math.round(c.s.magDamage * 0.05))
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
    text: '모든 탄 DMG +30. 특수탄을 쏠 때마다 +4 누적 (최대 +120)',
    hooks: {
      onFire: (c) => {
        c.dmg += 30 + Math.min(120, getRunVar(c.s, c.self))
        proc(c)
      },
      onAfterShot: (c) => {
        if (isSpecial(c)) addRunVar(c.s, c.self, 4)
      },
    },
  },
  {
    id: 'br_archetype',
    name: '볼터의 원형',
    slot: 'barrel',
    rarity: 'relic',
    text: '기본탄의 DMG 가 이번 탄창에서 쏜 특수탄 중 최고 DMG 와 같아진다',
    hooks: {
      // 툴팁대로 **탄창 스코프**다. vars 는 전투 내내 살아 있으므로 명시적으로 지운다.
      onMagStart: (c) => { c.s.vars[c.self] = 0 },
      onFire: (c) => {
        if (!isBasic(c)) return
        const best = getVar(c.s, c.self)
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
    text: '모든 탄 HEAT +0.45',
    hooks: { onFire: (c) => { c.heatGain += 0.45; proc(c) } },
  },
  {
    id: 'hg_catalyst',
    name: '소이 촉매',
    slot: 'handguard',
    rarity: 'common',
    text: '특수탄 HEAT +1.6',
    hooks: { onFire: (c) => { if (isSpecial(c)) { c.heatGain += 1.6; proc(c) } } },
  },
  {
    id: 'hg_gas',
    name: '압축 가스관',
    slot: 'handguard',
    rarity: 'common',
    // 대용량 탄창 전용 커먼. cap3 에서는 방열 핀에 지고 cap8+ 에서 이긴다.
    text: '탄창의 3번째 탄부터 HEAT +1.2',
    hooks: { onFire: (c) => { if (c.index >= 2) { c.heatGain += 1.2; proc(c) } } },
  },
  {
    id: 'hg_relay',
    name: '계전 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    // +2.4 는 커먼 소이 촉매(+45%)와 거의 동률이라 언커먼 계단이 없었다.
    text: '직전이 특수탄이었으면 HEAT +4.0',
    hooks: { onFire: (c) => { if (prevWasSpecial(c)) { c.heatGain += 4.0; proc(c) } } },
  },
  {
    id: 'hg_chain',
    name: '연쇄 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    // 계수 1.1 은 탄창당 +11.0 로 레어(순교 +0.5)를 크게 넘었다 — 등급 역전.
    text: '이미 쏜 탄 수 ×0.5 만큼 HEAT + (상한 +2.0)',
    hooks: {
      onFire: (c) => {
        const v = Math.min(c.index, 4) * 0.5
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
    text: '발사 전 온도 10 이상이면 HEAT +5.5',
    hooks: { onFire: (c) => { if (c.heatBefore >= 10) { c.heatGain += 5.5; proc(c) } } },
  },
  {
    id: 'hg_martyr',
    name: '순교의 화로',
    slot: 'handguard',
    rarity: 'rare',
    // 무상한 누적은 34탄창 만에 +249%(H1)까지 갔다. 상한 +0.7.
    text: '모든 탄 HEAT +0.5. 사격을 마칠 때마다 +0.05 누적 (최대 +0.7)',
    hooks: {
      onFire: (c) => { c.heatGain += 0.5 + Math.min(0.7, getRunVar(c.s, c.self)); proc(c) },
      onMagEnd: (c) => { addRunVar(c.s, c.self, 0.05) },
    },
  },
  {
    id: 'hg_inquisition',
    name: '이단심문관의 화염',
    slot: 'handguard',
    rarity: 'relic',
    // '남은 탄 2배' 뿐이면 특수탄이 마지막일 때 완전히 죽고, 기본탄만 있는
    // 탄창(실측 40.7%)에서도 0 이다. 유물이 커먼보다 약했다 — 바닥을 깔아준다.
    text: '특수탄 HEAT +2.0. 특수탄을 쏘면 이번 탄창의 남은 탄 온도 획득 2배',
    hooks: {
      onFire: (c) => { if (isSpecial(c)) { c.heatGain += 2.0; proc(c) } },
      onAfterShot: (c) => {
        if (!isSpecial(c)) return
        c.s.heatDoublePending = true
        proc(c)
      },
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
    text: '거리 20m 이상이면 모든 탄 DMG +15',
    hooks: { onFire: (c) => { if (c.s.distance >= 20) { c.dmg += 15; proc(c) } } },
  },

  {
    id: 'op_thermal',
    name: '열화상 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    text: '특수탄이 탄창에 2발 이상이면 모든 탄 DMG +32',
    hooks: {
      onFire: (c) => { if (specialsInMag(c) >= 2) { c.dmg += 32; proc(c) } },
    },
  },
  {
    id: 'op_soulmark',
    name: '영혼 표식',
    slot: 'optic',
    rarity: 'rare',
    // 전투당 1회 발동은 실측 처리량 기여 +1.6% — 희귀 중앙값 +41.5% 의 4% 였다.
    // 상시 조건부로 바꾼다. 조건이 전투 후반에 걸리므로 순서 결정을 깎지 않는다.
    text: '적 HP 60% 이하면 모든 탄 HEAT +2.0. 전투를 이길 때마다 +0.15 누적(런)',
    hooks: {
      onFire: (c) => {
        const e = c.s.enemy
        if (e.hp <= 0 || e.hp > e.maxHp * 0.6) return
        c.heatGain += 2.0 + getRunVar(c.s, c.self)
        proc(c)
      },
      onCombatEnd: (c) => { if (c.s.enemy.hp <= 0) addRunVar(c.s, c.self, 0.15) },
    },
  },
  {
    id: 'op_quartermaster',
    name: '병참 렌즈',
    slot: 'optic',
    rarity: 'rare',
    text: '탄창의 첫 특수탄은 소모되지 않는다',
    hooks: {
      onMagStart: (c) => { c.s.flags['freeFirstSpecial'] = true },
    },
  },
  {
    id: 'op_emperor',
    name: '황제의 눈',
    slot: 'optic',
    rarity: 'relic',
    text: '특수탄 DMG +90, HEAT +2.5',
    hooks: {
      onFire: (c) => {
        if (!isSpecial(c)) return
        c.dmg += 90
        c.heatGain += 2.5
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
    text: '사격 거리 소모 −1m',
    mods: { fireCost: -1 },
  },
  {
    id: 'st_fixed',
    name: '고정 개머리판',
    slot: 'stock',
    rarity: 'common',
    text: '전투 시작 거리 +6m',
    mods: { startDist: 6 },
  },
  {
    id: 'st_charm',
    name: '황동 부적',
    slot: 'stock',
    rarity: 'common',
    text: '발사할 때마다 탄피 +4',
    hooks: {
      onAfterShot: (c) => {
        if (c.s.dryRun) return
        c.s.loadout.brass += 4
        proc(c)
      },
    },
  },
  {
    id: 'st_buffer',
    name: '완충기',
    slot: 'stock',
    rarity: 'uncommon',
    text: '전투 시작 거리 +4m · 사격 거리 소모 −1m',
    mods: { startDist: 4, fireCost: -1 },
  },
  {
    id: 'st_penance',
    name: '참회의 사슬',
    slot: 'stock',
    rarity: 'uncommon',
    // 기본탄 12 에 +55 를 얹으면 총화력이 5.6배가 된다 — 언커먼 하나로 게임이 끝났다
    // (실측 장착률 41%, 전 부착물 1위). 대가(−10m)는 그대로 두고 값만 내린다.
    text: '전투 시작 거리 −10m · 모든 탄 DMG +35',
    mods: { startDist: -10 },
    hooks: { onFire: (c) => { c.dmg += 35; proc(c) } },
  },
  {
    id: 'st_reliquary',
    name: '성유물 거치대',
    slot: 'stock',
    rarity: 'rare',
    // 칸만 주면 처리량 기여가 정확히 0 이라 실측 채택률도 0 이었다.
    // 희귀값을 하려면 켜자마자 효과가 있어야 한다 — 행동 수 축 보너스를 얹는다.
    text: '보조 광학 칸 +1 · 사격 거리 소모 −2m',
    mods: { railSlots: 1, fireCost: -2 },
  },
  {
    id: 'st_stride',
    name: '거인의 보폭',
    slot: 'stock',
    rarity: 'rare',
    text: '적 접근 속도 −3',
    mods: { enemySpeed: -3 },
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
    text: '전투 시작 시 무작위 특수탄 2발 · 사격을 시작할 때마다 1발을 보급받는다',
    hooks: {
      onCombatStart: (c) => { supply(c.s, 2) },
      onMagStart: (c) => { supply(c.s, 1) },
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
    text: '용량 5. 보정 없음',
    mag: { cap: 5 },
  },
  {
    id: 'mg_drum',
    name: '드럼 8연발',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 7. 온도 획득 −20%',
    mag: { cap: 7, heatGainMul: 0.8 },
  },
  {
    id: 'mg_precision',
    name: '정밀 3연발',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 3. 발사마다 HEAT +3.5 · 사격 거리 −2m',
    mag: { cap: 3 },
    mods: { fireCost: -2 },
    hooks: { onFire: (c) => { c.heatGain += 3.5; proc(c) } },
  },
  {
    id: 'mg_greed',
    name: '탐식의 성궤',
    slot: 'magazine',
    rarity: 'rare',
    text: '용량 2. 발사한 특수탄이 80% 확률로 소모되지 않는다',
    mag: { cap: 2, notConsumedChance: 0.8 },
  },
  {
    id: 'mg_coolant',
    name: '냉각 자켓',
    slot: 'magazine',
    rarity: 'rare',
    text: '용량 6. 온도 이월 +25%p (총 75%)',
    mag: { cap: 6 },
    mods: { heatCarry: 0.25 },
  },
  {
    id: 'mg_executioner',
    name: '처형자',
    slot: 'magazine',
    rarity: 'rare',
    // R6 특권(startHeat)을 쓰는 유일한 부위. +18 은 테르밋탄 1발(48 heat·shot)의
    // 37% 값어치라 특권이 무의미했다. +34 로 71% 까지 올린다.
    text: '용량 1. 사격 시작 온도 +34 · 사격 거리 −3m',
    mag: { cap: 1 },
    mods: { startHeat: 34, fireCost: -3 },
  },
  {
    id: 'mg_penitent',
    name: '참회의 탄대',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 5. 첫 탄 DMG 0, 이후 모든 탄 HEAT +1.8',
    mag: { cap: 5 },
    hooks: {
      onFire: (c) => {
        // "첫 발은 제물" 규칙의 직접 구현 — 이 게임에서 유일한 대입 예외다.
        if (c.isFirst) { c.dmg = 0; proc(c); return }
        c.heatGain += 1.8
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
    text: '용량 12. 온도 획득 −30%',
    mag: { cap: 12, heatGainMul: 0.7 },
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
    text: '탄창의 마지막 탄 HEAT +4.0',
    hooks: { onFire: (c) => { if (c.isLast) { c.heatGain += 4.0; proc(c) } } },
  },
  {
    id: 'op_trinity',
    name: '삼위일체 각인',
    slot: 'optic',
    rarity: 'uncommon',
    text: '탄창에 특수탄 3발 이상이면 모든 탄 HEAT +2.2',
    hooks: { onFire: (c) => { if (specialsInMag(c) >= 3) { c.heatGain += 2.2; proc(c) } } },
  },
  {
    id: 'op_pact',
    name: '피의 계약',
    slot: 'optic',
    rarity: 'uncommon',
    // 임계 15(성립률 25.7%)에 +130 은 언커먼 밴드의 2배였다. 12(32.8%)/+70 으로.
    text: '발사 전 온도 12 초과면 DMG +70',
    hooks: { onFire: (c) => { if (c.heatBefore > 12) { c.dmg += 70; proc(c) } } },
  },
  {
    // 순수 평탄 DMG 이므로 축으로 보면 총열이다.
    // 하락폭은 기본탄 바닥값(12)을 넘지 않게 잡는다 — 넘으면 적을 회복시킨다.
    id: 'br_gambler',
    name: '도박꾼의 성구',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '매 발사 50%로 DMG +75, 50%로 −12',
    hooks: {
      onFire: (c) => {
        if (c.s.dryRun) { c.dmg += 31.5; return }
        c.dmg += c.s.rng.next() < 0.5 ? 75 : -12
        proc(c)
      },
    },
  },
  {
    id: 'op_deathrite',
    name: '죽음의 성사',
    slot: 'optic',
    rarity: 'rare',
    text: '마지막 탄이 특수탄이면 그 탄 HEAT +14',
    hooks: {
      onFire: (c) => {
        if (!c.isLast || !isSpecial(c)) return
        c.heatGain += 14
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
    text: '용량 4. 발사마다 HEAT +4.5 · 온도 이월 −25%p · 온도 22 초과 시 사격 즉시 종료',
    mag: { cap: 4 },
    mods: { heatCarry: -0.25 },
    hooks: {
      onFire: (c) => { c.heatGain += 4.5; proc(c) },
      onAfterShot: (c) => { if (c.s.heat > 22) c.s.abortMag = true },
    },
  },
  {
    id: 'hg_cryo',
    name: '급속 냉각기',
    slot: 'handguard',
    rarity: 'uncommon',
    // 임계 4 는 자기 이월 감소 덕에 5/5 전부 발동해 '조건'이 아니었다.
    // 3.5 로 낮추면 정상상태에서 4/5 만 켜져 배치 결정이 살아난다.
    text: '온도 이월 −40%p. 발사 전 온도 3.5 이하면 DMG +45',
    mods: { heatCarry: -0.4 },
    hooks: { onFire: (c) => { if (c.heatBefore <= 3.5) { c.dmg += 45; proc(c) } } },
  },
  {
    id: 'br_frostbite',
    name: '한랭 총열',
    slot: 'barrel',
    rarity: 'rare',
    // 문턱을 12 → 6 으로. 12 면 이월 정상상태(약 7)에서도 늘 켜져 있어
    // "저온일 때만 강하다" 는 정체성이 성립하지 않았다.
    text: '발사 전 온도가 낮을수록 강하다 — DMG + (6 − 온도) × 26',
    hooks: {
      onFire: (c) => {
        const gap = 6 - c.heatBefore
        if (gap <= 0) return
        c.dmg += Math.round(gap * 26)
        proc(c)
      },
    },
  },
]

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

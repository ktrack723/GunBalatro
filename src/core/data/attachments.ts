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
    text: '탄창의 첫 탄 DMG +95',
    hooks: { onFire: (c) => { if (c.isFirst) { c.dmg += 95; proc(c) } } },
  },
  {
    id: 'br_bayonet',
    name: '총검 거치대',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '거리 10m 이하면 모든 탄 DMG +60',
    hooks: { onFire: (c) => { if (c.s.distance <= 10) { c.dmg += 60; proc(c) } } },
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
    text: '마지막 탄에 이번 탄창 누적 피해의 10% 추가',
    hooks: {
      onFire: (c) => {
        if (!c.isLast) return
        const add = Math.round(c.s.magDamage * 0.1)
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
    text: '모든 탄 DMG +30. 특수탄을 쏠 때마다 +10 누적(런)',
    hooks: {
      onFire: (c) => {
        c.dmg += 30 + getRunVar(c.s, c.self)
        proc(c)
      },
      onAfterShot: (c) => {
        if (isSpecial(c)) addRunVar(c.s, c.self, 10)
      },
    },
  },
  {
    id: 'br_archetype',
    name: '볼터의 원형',
    slot: 'barrel',
    rarity: 'relic',
    text: '기본탄의 DMG 가 이번 탄창 최고 DMG 와 같아진다',
    hooks: {
      onFire: (c) => {
        if (!isBasic(c)) return
        const best = getVar(c.s, c.self)
        if (best > c.dmg) { c.dmg = best; proc(c) }
      },
      onAfterShot: (c) => {
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
    text: '탄창의 3번째 탄부터 HEAT +0.9',
    hooks: { onFire: (c) => { if (c.index >= 2) { c.heatGain += 0.9; proc(c) } } },
  },
  {
    id: 'hg_relay',
    name: '계전 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    text: '직전이 특수탄이었으면 HEAT +2.4',
    hooks: { onFire: (c) => { if (prevWasSpecial(c)) { c.heatGain += 2.4; proc(c) } } },
  },
  {
    id: 'hg_chain',
    name: '연쇄 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    text: '이미 쏜 탄 수 ×1.1 만큼 HEAT + (상한 +4.4)',
    hooks: {
      onFire: (c) => {
        const v = Math.min(c.index, 4) * 1.1
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
    text: '발사 전 온도 10 이상이면 HEAT +3.5',
    hooks: { onFire: (c) => { if (c.heatBefore >= 10) { c.heatGain += 3.5; proc(c) } } },
  },
  {
    id: 'hg_martyr',
    name: '순교의 화로',
    slot: 'handguard',
    rarity: 'rare',
    text: '모든 탄 HEAT +0.5. 사격을 마칠 때마다 +0.05 누적(런)',
    hooks: {
      onFire: (c) => { c.heatGain += 0.5 + getRunVar(c.s, c.self); proc(c) },
      onMagEnd: (c) => { addRunVar(c.s, c.self, 0.05) },
    },
  },
  {
    id: 'hg_inquisition',
    name: '이단심문관의 화염',
    slot: 'handguard',
    rarity: 'relic',
    text: '특수탄을 쏘면 이번 탄창의 남은 탄 온도 획득 2배',
    hooks: {
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
    text: '거리 20m 이상이면 모든 탄 DMG +30',
    hooks: { onFire: (c) => { if (c.s.distance >= 20) { c.dmg += 30; proc(c) } } },
  },
  {
    id: 'op_rangefinder',
    name: '간이 거리계',
    slot: 'optic',
    rarity: 'common',
    text: '사격 거리 소모 −1m',
    mods: { fireCost: -1 },
  },
  {
    id: 'op_thermal',
    name: '열화상 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    text: '특수탄이 탄창에 2발 이상이면 모든 탄 DMG +55',
    hooks: {
      onFire: (c) => { if (specialsInMag(c) >= 2) { c.dmg += 55; proc(c) } },
    },
  },
  {
    id: 'op_soulmark',
    name: '영혼 표식',
    slot: 'optic',
    rarity: 'rare',
    text: '적 HP 25% 이하가 되면 HEAT +7, 발동마다 +2 누적(런)',
    hooks: {
      onCombatStart: (c) => { c.s.flags['soulMark'] = false },
      onAfterShot: (c) => {
        if (c.s.flags['soulMark'] === true) return
        const e = c.s.enemy
        if (e.hp <= 0 || e.hp > e.maxHp * 0.25) return
        c.s.heat += 7 + getRunVar(c.s, c.self)
        addRunVar(c.s, c.self, 2)
        if (c.s.heat > c.s.peakHeat) c.s.peakHeat = c.s.heat
        c.s.flags['soulMark'] = true
        proc(c)
      },
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
    text: '발사할 때마다 탄피 +2',
    hooks: {
      onAfterShot: (c) => {
        if (c.s.dryRun) return
        c.s.loadout.brass += 2
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
    text: '전투 시작 거리 −10m · 모든 탄 DMG +55',
    mods: { startDist: -10 },
    hooks: { onFire: (c) => { c.dmg += 55; proc(c) } },
  },
  {
    id: 'st_reliquary',
    name: '성유물 거치대',
    slot: 'stock',
    rarity: 'rare',
    text: '보조 레일 +1',
    mods: { railSlots: 1 },
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
    text: '전투 시작 시 무작위 특수탄 2발을 보급받는다',
    hooks: {
      onCombatStart: (c) => {
        if (c.s.dryRun) return
        const ids = Object.keys(c.s.specials)
        const pool = ids.length > 0 ? ids : ['sp_incendiary']
        for (let i = 0; i < 2; i += 1) {
          const id = pool[c.s.rng.int(pool.length)]
          c.s.specials[id] = (c.s.specials[id] ?? 0) + 1
        }
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
    text: '용량 5. 보정 없음',
    mag: { cap: 5 },
  },
  {
    id: 'mg_drum',
    name: '드럼 8연발',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 8. 온도 획득 −35%',
    mag: { cap: 8, heatGainMul: 0.65 },
  },
  {
    id: 'mg_precision',
    name: '정밀 3연발',
    slot: 'magazine',
    rarity: 'uncommon',
    text: '용량 3. 발사마다 HEAT +2.8 · 사격 거리 −2m',
    mag: { cap: 3 },
    mods: { fireCost: -2 },
    hooks: { onFire: (c) => { c.heatGain += 2.8; proc(c) } },
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
    text: '용량 5. 사격 종료 시 온도의 35%를 다음 사격으로 이월',
    mag: { cap: 5, heatCarryRatio: 0.35 },
  },
  {
    id: 'mg_executioner',
    name: '처형자',
    slot: 'magazine',
    rarity: 'rare',
    text: '용량 1. 사격 시작 온도 +18 · 사격 거리 −3m',
    mag: { cap: 1 },
    mods: { startHeat: 18, fireCost: -3 },
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
    text: '용량 9. 온도 획득 −20%',
    mag: { cap: 9, heatGainMul: 0.8 },
  },

  // =========================================================================
  // 보조 레일 (Rail) — 조건·콤보 축. 하드포인트 사이를 잇는 "만약(if)".
  // =========================================================================
  {
    id: 'rl_holywater',
    name: '성수 앰플',
    slot: 'rail',
    rarity: 'common',
    text: '탄창의 마지막 탄 HEAT +1.8',
    hooks: { onFire: (c) => { if (c.isLast) { c.heatGain += 1.8; proc(c) } } },
  },
  {
    id: 'rl_ledger',
    name: '전리품 장부',
    slot: 'rail',
    rarity: 'common',
    text: '사격을 마칠 때마다 탄피 +8',
    hooks: {
      onMagEnd: (c) => {
        if (c.s.dryRun) return
        c.s.loadout.brass += 8
      },
    },
  },
  {
    id: 'rl_trinity',
    name: '삼위일체 각인',
    slot: 'rail',
    rarity: 'uncommon',
    text: '탄창에 특수탄 3발 이상이면 모든 탄 HEAT +1.6',
    hooks: { onFire: (c) => { if (specialsInMag(c) >= 3) { c.heatGain += 1.6; proc(c) } } },
  },
  {
    id: 'rl_pact',
    name: '피의 계약',
    slot: 'rail',
    rarity: 'uncommon',
    text: '발사 전 온도 15 초과면 DMG +130',
    hooks: { onFire: (c) => { if (c.heatBefore > 15) { c.dmg += 130; proc(c) } } },
  },
  {
    id: 'rl_gambler',
    name: '도박꾼의 성구',
    slot: 'rail',
    rarity: 'uncommon',
    text: '매 발사 50%로 DMG +170, 50%로 −40',
    hooks: {
      onFire: (c) => {
        if (c.s.dryRun) { c.dmg += 65; return }
        c.dmg += c.s.rng.next() < 0.5 ? 170 : -40
        proc(c)
      },
    },
  },
  {
    id: 'rl_deathrite',
    name: '죽음의 성사',
    slot: 'rail',
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
    id: 'rl_unstable',
    name: '불안정 노심',
    slot: 'rail',
    rarity: 'rare',
    text: '모든 탄 HEAT +4.5. 온도 26 초과 시 사격 즉시 종료',
    hooks: {
      onFire: (c) => { c.heatGain += 4.5; proc(c) },
      onAfterShot: (c) => { if (c.s.heat > 26) c.s.abortMag = true },
    },
  },
  {
    id: 'rl_relicbones',
    name: '성인의 유해',
    slot: 'rail',
    rarity: 'relic',
    text: '이번 런에서 획득한 부착물 수 ×16 만큼 DMG +',
    hooks: {
      onCombatStart: (c) => { c.s.vars[c.self] = getVar(c.s, '__taken') * 16 },
      onFire: (c) => {
        const v = getVar(c.s, c.self)
        if (v <= 0) return
        c.dmg += v
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

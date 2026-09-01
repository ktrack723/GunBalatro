// ============================================================================
// 부착물 카탈로그 56종 — 총열11 / 총열덮개12 / 광학10 / 개머리판11 / 보조레일12.
// 정적 보정은 mods 로, 런타임 효과는 hooks 로만 기술한다 (증가는 전부 덧셈).
// 조회·무작위 추출 헬퍼(ATT_BY_ID / bySlot / ofRarity / pickAttachment)도 함께 제공한다.
// ============================================================================

import type {
  Ammo,
  AmmoType,
  Attachment,
  CombatState,
  FireCtx,
  Grade,
  Rarity,
  Rng,
  SlotKind,
} from '../types'
import { GRADE_BASE, TYPE_DMG_MUL } from '../types'
import { distinctTypeCount, makeAmmo, nextUid, sameType } from '../ammoStats'

// ---------------------------------------------------------------------------
// 공용 헬퍼
// ---------------------------------------------------------------------------

/** 축성탄 와일드 판정이 살아 있는가 (성별 거부 패시브면 꺼진다) */
function wildOn(s: CombatState): boolean {
  return !s.enemy.passive?.disableWildcard
}

/** sameType 이 Ammo 를 받으므로 탄종 비교용 더미 탄을 미리 만들어 둔다 */
const TYPE_PROBE: Record<AmmoType, Ammo> = {
  AP: { uid: '#probe-AP', type: 'AP', grade: 1 },
  INC: { uid: '#probe-INC', type: 'INC', grade: 1 },
  HE: { uid: '#probe-HE', type: 'HE', grade: 1 },
  SANC: { uid: '#probe-SANC', type: 'SANC', grade: 1 },
}

/** 탄 a 가 탄종 t 로 취급되는가 (와일드 포함) */
function isType(s: CombatState, a: Ammo, t: AmmoType): boolean {
  return sameType(a, TYPE_PROBE[t], wildOn(s))
}

/**
 * 축성탄 그 자체인지.
 * 와일드는 "SANC 가 다른 탄종을 겸한다"는 단방향 규칙이므로,
 * 대칭 구현일 수 있는 sameType 대신 직접 비교한다 (AP 가 축성탄으로 둔갑하면 안 된다).
 */
function isSanc(a: Ammo): boolean {
  return a.type === 'SANC'
}

/** STEP1 과 동일한 탄 기본 데미지 (정적 스탯 산출이므로 곱셈 예외) */
function baseDmg(a: Ammo): number {
  return Math.round(GRADE_BASE[a.grade] * TYPE_DMG_MUL[a.type])
}

/** 누적 저장소 읽기 (미초기화면 0) */
function getVar(s: CombatState, key: string): number {
  const v = s.vars[key]
  return typeof v === 'number' ? v : 0
}

/**
 * ★ 런 스코프 카운터. 전투가 끝나도 살아남아 런 내내 자란다.
 * 발라트로의 스케일링 조커에 대응하는 이 게임의 유일한 복리 장치다
 * (곱셈 축을 온도 하나로 줄인 대가를 여기서 갚는다).
 */
function getRunVar(s: CombatState, key: string): number {
  const v = s.runVars[key]
  return typeof v === 'number' ? v : 0
}

function addRunVar(s: CombatState, key: string, delta: number): void {
  // 미리보기는 런 상태를 건드리지 않는다. (클론이 runVars 를 복사하지만 이중 안전장치)
  if (s.dryRun) return
  s.runVars[key] = getRunVar(s, key) + delta
}

/** 플래그 읽기 (미초기화면 false) */
function getFlag(s: CombatState, key: string): boolean {
  return s.flags[key] === true
}

/** 발동 연출 기록 */
function proc(c: FireCtx): void {
  c.triggered.push(c.self)
}

/** 등급 +2 (5 상한). 타입 단언 없이 표로 처리한다 */
const GRADE_PLUS2: Record<Grade, Grade> = { 1: 3, 2: 4, 3: 5, 4: 5, 5: 5 }

/** 탄약 주머니가 생성하는 전투 한정 탄의 후보 */
const POUCH_TYPES: readonly AmmoType[] = ['AP', 'INC', 'HE', 'SANC']
const POUCH_GRADES: readonly Grade[] = [1, 1, 2, 2, 3]

const SLOTS: readonly SlotKind[] = ['barrel', 'handguard', 'optic', 'stock', 'rail']
const RARITIES: readonly Rarity[] = ['common', 'uncommon', 'rare', 'relic']

// ---------------------------------------------------------------------------
// 2. 총열 (Barrel) — 데미지(칩) 축 · 11종
// ---------------------------------------------------------------------------
const BARRELS: Attachment[] = [
  {
    id: 'br_long_barrel',
    name: '연장 총열',
    slot: 'barrel',
    rarity: 'common',
    text: '모든 탄 DMG +12',
    hooks: {
      onFire(c) {
        c.dmg += 12
        proc(c)
      },
    },
  },
  {
    id: 'br_heavy_barrel',
    name: '중(重)총열',
    slot: 'barrel',
    rarity: 'common',
    text: '철갑탄 DMG +28',
    hooks: {
      onFire(c) {
        if (!isType(c.s, c.ammo, 'AP')) return
        c.dmg += 28
        proc(c)
      },
    },
  },
  {
    id: 'br_rifling',
    name: '강선 각인',
    slot: 'barrel',
    rarity: 'common',
    text: '등급 3 이상인 탄 DMG +30',
    hooks: {
      onFire(c) {
        if (c.ammo.grade < 3) return
        c.dmg += 30
        proc(c)
      },
    },
  },
  {
    id: 'br_flash_hider',
    name: '소염기',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '탄창의 첫 탄 DMG +90',
    hooks: {
      onFire(c) {
        if (!c.isFirst) return
        c.dmg += 90
        proc(c)
      },
    },
  },
  {
    id: 'br_bayonet_lug',
    name: '총검 거치대',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '거리 10m 이하면 모든 탄 DMG +55',
    hooks: {
      onFire(c) {
        if (c.s.distance > 10) return
        c.dmg += 55
        proc(c)
      },
    },
  },
  {
    id: 'br_purity_catalyst',
    name: '정화 촉매',
    slot: 'barrel',
    rarity: 'uncommon',
    text: '축성탄 DMG +50, 축성탄의 다음 탄 +15×등급',
    hooks: {
      onFire(c) {
        let hit = false
        if (isSanc(c.ammo)) {
          c.dmg += 50
          hit = true
        }
        // 축성탄의 "다음 탄 보너스" 추가분. 파이프라인의 pendingNextDmg 등록 순서에
        // 의존하지 않도록 직전 탄(prev)을 직접 보고 얹는다.
        const p = c.prev
        if (p !== null && isSanc(p)) {
          c.dmg += 15 * p.grade
          hit = true
        }
        if (hit) proc(c)
      },
    },
  },
  {
    id: 'br_explosive_bolt',
    name: '폭발 볼트 총열',
    slot: 'barrel',
    rarity: 'rare',
    text: '고폭탄 발사마다 모든 탄 DMG +12 — 런 내내 누적',
    hooks: {
      // 런 스코프다. onCombatStart 에서 초기화하지 않는다 — 그게 핵심이다.
      // onFire 가 먼저 읽고 onAfterShot 이 나중에 올린다 →
      // 자기 자신이 이번 발사에 올린 값은 이번 발사에 적용되지 않는다.
      onFire(c) {
        const v = getRunVar(c.s, c.self)
        if (v <= 0) return
        c.dmg += v
        proc(c)
      },
      onAfterShot(c) {
        if (!isType(c.s, c.ammo, 'HE')) return
        addRunVar(c.s, c.self, 12)
      },
    },
  },
  {
    id: 'br_judgment',
    name: '심판의 총열',
    slot: 'barrel',
    rarity: 'rare',
    text: '마지막 탄 DMG +이번 탄창 누적 피해의 8%',
    hooks: {
      onFire(c) {
        if (!c.isLast) return
        const add = Math.round(c.s.magDamage * 0.08)
        if (add <= 0) return
        c.dmg += add
        proc(c)
      },
    },
  },
  {
    id: 'br_reload_litany',
    name: '재장전 성구',
    slot: 'barrel',
    rarity: 'rare',
    text: '탄창의 서로 다른 등급 수 ×40 만큼 모든 탄 DMG +',
    hooks: {
      onMagStart(c) {
        const grades = new Set<Grade>()
        for (const a of c.plan) grades.add(a.grade)
        c.s.vars[c.self] = grades.size * 40
      },
      onFire(c) {
        const v = getVar(c.s, c.self)
        if (v <= 0) return
        c.dmg += v
        proc(c)
      },
    },
  },
  {
    id: 'br_name_of_god',
    name: '신의 이름',
    slot: 'barrel',
    rarity: 'relic',
    text: '이번 탄창에 처음 등장한 탄종이면 DMG +200',
    hooks: {
      onFire(c) {
        const w = wildOn(c.s)
        for (const a of c.s.magFired) {
          if (sameType(a, c.ammo, w)) return
        }
        c.dmg += 200
        proc(c)
      },
    },
  },
  {
    id: 'br_bolter_archetype',
    name: '볼터의 원형',
    slot: 'barrel',
    rarity: 'relic',
    text: '모든 탄의 DMG가 가방 최고 데미지 탄과 같아진다',
    hooks: {
      onCombatStart(c) {
        let best = 0
        const pools: readonly Ammo[][] = [
          c.s.loadout.bag,
          c.s.bag,
          c.s.tray,
          c.s.spent,
          c.s.reserve,
        ]
        for (const pool of pools) {
          for (const a of pool) {
            const d = baseDmg(a)
            if (d > best) best = d
          }
        }
        c.s.vars[c.self] = best
      },
      onFire(c) {
        const best = getVar(c.s, c.self)
        if (best <= c.dmg) return
        // 대입이지만 "최댓값으로 끌어올린다"는 의미이므로 Math.max 형태로만 쓴다.
        c.dmg = Math.max(c.dmg, best)
        proc(c)
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 3. 총열덮개 (Handguard) — 온도(멀트) 축 · 12종
// ---------------------------------------------------------------------------
const HANDGUARDS: Attachment[] = [
  {
    id: 'hg_heat_fin',
    name: '방열 핀',
    slot: 'handguard',
    rarity: 'common',
    text: '모든 탄 HEAT +0.30',
    hooks: {
      onFire(c) {
        c.heatGain += 0.3
        proc(c)
      },
    },
  },
  {
    id: 'hg_incendiary_catalyst',
    name: '소이 촉매',
    slot: 'handguard',
    rarity: 'common',
    text: '소이탄 HEAT +0.60',
    hooks: {
      onFire(c) {
        if (!isType(c.s, c.ammo, 'INC')) return
        c.heatGain += 0.6
        proc(c)
      },
    },
  },
  {
    id: 'hg_gas_tube',
    name: '압축 가스관',
    slot: 'handguard',
    rarity: 'common',
    text: '탄창의 3번째 탄부터 HEAT +0.55',
    hooks: {
      onFire(c) {
        if (c.index < 2) return
        c.heatGain += 0.55
        proc(c)
      },
    },
  },
  {
    id: 'hg_double_feed',
    name: '이중 급탄',
    slot: 'handguard',
    rarity: 'uncommon',
    text: '직전 탄과 같은 탄종이면 HEAT +1.30',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null) return
        if (!sameType(p, c.ammo, wildOn(c.s))) return
        c.heatGain += 1.3
        proc(c)
      },
    },
  },
  {
    id: 'hg_cross_ignition',
    name: '교차 점화',
    slot: 'handguard',
    rarity: 'uncommon',
    text: '직전 탄과 다른 탄종이면 HEAT +1.10',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null) return
        if (sameType(p, c.ammo, wildOn(c.s))) return
        c.heatGain += 1.1
        proc(c)
      },
    },
  },
  {
    id: 'hg_ascension_valve',
    name: '승천 밸브',
    slot: 'handguard',
    rarity: 'uncommon',
    text: '직전 탄보다 등급이 높으면 HEAT +1.60',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade <= p.grade) return
        c.heatGain += 1.6
        proc(c)
      },
    },
  },
  {
    id: 'hg_backflow_valve',
    name: '역류 밸브',
    slot: 'handguard',
    rarity: 'uncommon',
    text: '직전 탄보다 등급이 낮으면 HEAT +2.20',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade >= p.grade) return
        c.heatGain += 2.2
        proc(c)
      },
    },
  },
  {
    id: 'hg_furnace_heart',
    name: '용광로 심장',
    slot: 'handguard',
    rarity: 'rare',
    text: '온도 10 이상이면 이후 모든 발사 HEAT +3.00',
    hooks: {
      onFire(c) {
        if (c.heatBefore < 10) return
        c.heatGain += 3
        proc(c)
      },
    },
  },
  {
    id: 'hg_martyr_forge',
    name: '순교의 화로',
    slot: 'handguard',
    rarity: 'rare',
    text: '사격을 마칠 때마다 시작 온도 +0.45 — 런 내내 누적',
    hooks: {
      // 런 스코프 누적. 전투가 끝나도 사라지지 않는 이 게임의 주력 온도 스케일러다.
      onCombatStart(c) {
        c.s.heatStartBase += getRunVar(c.s, c.self)
      },
      onMagEnd(c) {
        addRunVar(c.s, c.self, 0.45)
        c.s.heatStartBase += 0.45
      },
    },
  },
  {
    id: 'hg_chain_ignition',
    name: '연쇄 점화',
    slot: 'handguard',
    rarity: 'rare',
    text: '이번 탄창에서 이미 쏜 탄 수 ×1.4 만큼 HEAT +',
    hooks: {
      onFire(c) {
        if (c.index <= 0) return
        c.heatGain += c.index * 1.4
        proc(c)
      },
    },
  },
  {
    id: 'hg_inquisitor_flame',
    name: '이단심문관의 화염',
    slot: 'handguard',
    rarity: 'relic',
    text: '소이탄을 쏘면 남은 탄의 온도 획득 2배 (중첩 없음)',
    hooks: {
      onAfterShot(c) {
        if (!isType(c.s, c.ammo, 'INC')) return
        if (c.s.heatDoublePending) return
        c.s.heatDoublePending = true
        proc(c)
      },
    },
  },
  {
    id: 'hg_eternal_flame',
    name: '영원한 불',
    slot: 'handguard',
    rarity: 'relic',
    text: '온도가 사격 사이에 유지된다. 사격 시작마다 HEAT −5',
    hooks: {
      // mods 로 표현할 수 없는 "온도 초기화 규칙 자체의 변경"이므로 플래그 방식이다.
      // 파이프라인은 flags['eternalFlame'] 가 서 있으면 사격 시작 시 온도를 1.00 으로
      // 되돌리지 않고 heat = max(1, heat - 5) 로 이월한다.
      onCombatStart(c) {
        c.s.flags['eternalFlame'] = true
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 4. 광학 (Optic) — 정보 / 거리 축 · 10종
// ---------------------------------------------------------------------------
const OPTICS: Attachment[] = [
  {
    id: 'op_iron_sight',
    name: '아이언 사이트',
    slot: 'optic',
    rarity: 'common',
    text: '트레이 +1 (9발)',
    mods: { tray: 1 },
  },
  {
    id: 'op_laser_designator',
    name: '레이저 지시기',
    slot: 'optic',
    rarity: 'common',
    text: '거리 20m 이상이면 모든 탄 DMG +25',
    hooks: {
      onFire(c) {
        if (c.s.distance < 20) return
        c.dmg += 25
        proc(c)
      },
    },
  },
  {
    id: 'op_rangefinder',
    name: '간이 거리계',
    slot: 'optic',
    rarity: 'common',
    text: '사격 행동의 거리 소모 −1m',
    mods: { fireCost: -1 },
  },
  {
    id: 'op_thermal_scope',
    name: '열화상 조준경',
    slot: 'optic',
    rarity: 'uncommon',
    text: '가방의 다음 3발을 미리 본다. 모든 탄 DMG +20',
    hooks: {
      // UI 가 flags['peek3'] 를 읽어 가방 상단 3발을 공개한다.
      onCombatStart(c) {
        c.s.flags['peek3'] = true
      },
      onFire(c) {
        c.dmg += 20
        proc(c)
      },
    },
  },
  {
    id: 'op_ballistic_computer',
    name: '탄도 계산기',
    slot: 'optic',
    rarity: 'uncommon',
    text: '사격 사이 1회, 배출 행동의 거리 소모 0m',
    hooks: {
      // 배출이 flags['freeEject'] 를 소비(false)하고, 다음 사격이 끝나면 다시 충전된다.
      onCombatStart(c) {
        c.s.flags['freeEject'] = true
      },
      onMagEnd(c) {
        c.s.flags['freeEject'] = true
      },
    },
  },
  {
    id: 'op_sanctify_lens',
    name: '성별 렌즈',
    slot: 'optic',
    rarity: 'uncommon',
    text: '사격 시작 시 탄창 1번 탄을 축성탄으로 (등급 유지)',
    hooks: {
      onMagStart(c) {
        if (c.plan.length === 0) return
        const first = c.plan[0]
        if (first.type === 'SANC') return
        // 가방 원본을 오염시키지 않도록 uid 를 유지한 복제본으로 교체한다.
        c.plan[0] = { uid: first.uid, type: 'SANC', grade: first.grade }
      },
    },
  },
  {
    id: 'op_prescient_lens',
    name: '예지 렌즈',
    slot: 'optic',
    rarity: 'rare',
    text: '사격 시작 시 가방의 최강 탄 1발을 탄창에 추가',
    hooks: {
      onMagStart(c) {
        const bag = c.s.bag
        if (bag.length === 0) return
        // "원하는 탄종"의 자동 대행: 가방에서 기본 데미지가 가장 높은 탄을 검색한다.
        let bi = 0
        for (let i = 1; i < bag.length; i += 1) {
          if (baseDmg(bag[i]) > baseDmg(bag[bi])) bi = i
        }
        const taken = bag.splice(bi, 1)
        if (taken.length === 0) return
        c.plan.push(taken[0])
      },
    },
  },
  {
    id: 'op_soul_mark',
    name: '영혼 표식',
    slot: 'optic',
    rarity: 'rare',
    text: '적 HP 25% 이하 시 HEAT +6, 발동마다 +2 누적 (전투 1회)',
    hooks: {
      // 런 스코프 누적. 표식은 전투가 끝나도 지워지지 않는다 — 광학 축의 복리 장치.
      onCombatStart(c) {
        c.s.flags['soulMark'] = false
      },
      onAfterShot(c) {
        if (getFlag(c.s, 'soulMark')) return
        const e = c.s.enemy
        if (e.hp <= 0 || e.hp > e.maxHp * 0.25) return
        // 이번 발사는 이미 끝났으므로 heatGain 이 아니라 현재 온도를 직접 올린다.
        c.s.heat += 6 + getRunVar(c.s, c.self)
        addRunVar(c.s, c.self, 2)
        if (c.s.heat > c.s.peakHeat) c.s.peakHeat = c.s.heat
        c.s.flags['soulMark'] = true
        proc(c)
      },
    },
  },
  {
    id: 'op_crusader_eye',
    name: '성전 사수의 눈',
    slot: 'optic',
    rarity: 'rare',
    text: '사격 시작마다 트레이 최저 등급 탄 1발 등급 +2',
    hooks: {
      onMagStart(c) {
        if (c.s.dryRun) return
        const tray = c.s.tray
        if (tray.length === 0) return
        let li = 0
        for (let i = 1; i < tray.length; i += 1) {
          if (tray[i].grade < tray[li].grade) li = i
        }
        const src = tray[li]
        if (src.grade >= 5) return
        // 그 전투 동안만 유효해야 하므로 가방 원본 객체를 건드리지 않고 복제로 교체한다.
        tray[li] = { uid: src.uid, type: src.type, grade: GRADE_PLUS2[src.grade] }
      },
    },
  },
  {
    id: 'op_emperor_eye',
    name: '황제의 눈',
    slot: 'optic',
    rarity: 'relic',
    text: '트레이가 가방 전체가 된다',
    hooks: {
      // 트레이 수치를 부풀리는 대신 규칙 자체를 바꾼다: combat 이 이 플래그를 보고
      // 가방 전체를 트레이로 취급한다.
      onCombatStart(c) {
        c.s.flags['fullTray'] = true
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 5. 개머리판 (Stock) — 자원 / 경제 축 · 11종
// ---------------------------------------------------------------------------
const STOCKS: Attachment[] = [
  {
    id: 'st_fixed_stock',
    name: '고정 개머리판',
    slot: 'stock',
    rarity: 'common',
    text: '전투 시작 거리 +5m · 사격 거리 소모 −1m',
    mods: { startDist: 5, fireCost: -1 },
  },
  {
    id: 'st_ammo_pouch',
    name: '탄약 주머니',
    slot: 'stock',
    rarity: 'common',
    text: '전투 시작 시 무작위 탄 2발을 예비칸에 생성',
    hooks: {
      onCombatStart(c) {
        if (c.s.dryRun) return
        for (let i = 0; i < 2; i += 1) {
          const type = c.s.rng.pick(POUCH_TYPES)
          const grade = c.s.rng.pick(POUCH_GRADES)
          // 전투 한정 탄. uid 는 ammoStats 의 결정론적 카운터에서 받는다.
          c.s.reserve.push(makeAmmo(type, grade, nextUid()))
        }
      },
    },
  },
  {
    id: 'st_charm_pouch',
    name: '부적 주머니',
    slot: 'stock',
    rarity: 'common',
    text: '발사할 때마다 탄피 +1',
    hooks: {
      onAfterShot(c) {
        if (c.s.dryRun) return
        c.s.loadout.brass += 1
        proc(c)
      },
    },
  },
  {
    id: 'st_buffer',
    name: '완충기',
    slot: 'stock',
    rarity: 'uncommon',
    text: '첫 두 번의 사격 행동은 거리 소모 −3m',
    hooks: {
      onCombatStart(c) {
        c.s.vars[c.self] = 0
      },
      onMagStart(c) {
        if (c.s.dryRun) return
        const used = getVar(c.s, c.self)
        if (used >= 2) return
        c.s.vars[c.self] = used + 1
        // 거리 소모 감소분을 같은 값의 환급으로 표현한다 (덧셈, 순서 무관).
        c.s.distance += 3
      },
    },
  },
  {
    id: 'st_loot_belt',
    name: '전리품 벨트',
    slot: 'stock',
    rarity: 'uncommon',
    text: '전투 종료 시 남은 거리 1m당 탄피 +2',
    hooks: {
      onCombatEnd(c) {
        if (c.s.dryRun) return
        const left = Math.max(0, Math.floor(c.s.distance))
        if (left <= 0) return
        c.s.loadout.brass += left * 2
      },
    },
  },
  {
    id: 'st_spare_mag',
    name: '예비 탄창',
    slot: 'stock',
    rarity: 'uncommon',
    text: 'CAP +1, TRAY −1',
    mods: { cap: 1, tray: -1 },
  },
  {
    id: 'st_chain_of_penance',
    name: '참회의 사슬',
    slot: 'stock',
    rarity: 'uncommon',
    text: '전투 시작 거리 −10m, 모든 탄 DMG +75',
    mods: { startDist: -10 },
    hooks: {
      onFire(c) {
        c.dmg += 75
        proc(c)
      },
    },
  },
  {
    id: 'st_reliquary_mount',
    name: '성유물 거치대',
    slot: 'stock',
    rarity: 'rare',
    text: '보조 레일 슬롯 +1',
    mods: { railSlots: 1 },
  },
  {
    id: 'st_auto_loader',
    name: '자동 급탄기',
    slot: 'stock',
    rarity: 'rare',
    text: '사격 종료 시 쏜 탄 중 최저 등급 1발을 트레이로 회수',
    hooks: {
      onMagEnd(c) {
        if (c.s.dryRun) return
        const fired = c.s.magFired
        if (fired.length === 0) return
        let li = 0
        for (let i = 1; i < fired.length; i += 1) {
          if (fired[i].grade < fired[li].grade) li = i
        }
        const target = fired[li]
        const si = c.s.spent.findIndex((a) => a.uid === target.uid)
        if (si < 0) return
        const back = c.s.spent.splice(si, 1)
        if (back.length === 0) return
        c.s.tray.push(back[0])
      },
    },
  },
  {
    id: 'st_giant_stride',
    name: '거인의 보폭',
    slot: 'stock',
    rarity: 'rare',
    text: '적 접근 속도 −2m/행동 (최소 2)',
    mods: { enemySpeed: -2 },
  },
  {
    id: 'st_infinite_magazine',
    name: '무한 탄약고',
    slot: 'stock',
    rarity: 'relic',
    text: '배출이 거리를 소모하지 않는다. TRAY +3',
    mods: { tray: 3 },
    hooks: {
      // ejectCost 를 음수로 밀면 거리가 늘어나는 사고가 나므로 규칙 플래그로 표현한다.
      // combat 은 flags['freeEjectAlways'] 가 서 있으면 배출 비용을 0 으로 본다.
      onCombatStart(c) {
        c.s.flags['freeEjectAlways'] = true
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 6. 보조 레일 (Rail) — 조건 / 콤보 축 · 12종
// ---------------------------------------------------------------------------
const RAILS: Attachment[] = [
  {
    id: 'rl_brass_charm',
    name: '황동 부적',
    slot: 'rail',
    rarity: 'common',
    text: '사격 행동마다 탄피 +6',
    hooks: {
      onMagEnd(c) {
        if (c.s.dryRun) return
        c.s.loadout.brass += 6
      },
    },
  },
  {
    id: 'rl_holy_water',
    name: '성수 앰플',
    slot: 'rail',
    rarity: 'common',
    text: '탄창의 마지막 탄 HEAT +1.00',
    hooks: {
      onFire(c) {
        if (!c.isLast) return
        c.heatGain += 1
        proc(c)
      },
    },
  },
  {
    id: 'rl_pilgrim_rosary',
    name: '순례자의 묵주',
    slot: 'rail',
    rarity: 'uncommon',
    text: '직전 탄과 등급이 같으면 DMG +70',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || p.grade !== c.ammo.grade) return
        c.dmg += 70
        proc(c)
      },
    },
  },
  {
    id: 'rl_trinity_sigil',
    name: '삼위일체 각인',
    slot: 'rail',
    rarity: 'uncommon',
    text: '탄창에 탄종 3종 이상이면 모든 발사 HEAT +1.50',
    hooks: {
      onFire(c) {
        if (distinctTypeCount(c.s.magPlan, wildOn(c.s)) < 3) return
        c.heatGain += 1.5
        proc(c)
      },
    },
  },
  {
    id: 'rl_blood_pact',
    name: '피의 계약',
    slot: 'rail',
    rarity: 'uncommon',
    text: '이번 탄창 온도 15 초과 시 이후 모든 탄 DMG +110',
    hooks: {
      // 전투 전체 peakHeat 가 아니라 "이번 탄창" 기준이어야 하므로 별도 최고치를 추적한다.
      onMagStart(c) {
        c.s.vars[c.self] = 0
      },
      onFire(c) {
        if (c.heatBefore <= 15 && getVar(c.s, c.self) <= 15) return
        c.dmg += 110
        proc(c)
      },
      onAfterShot(c) {
        const peak = getVar(c.s, c.self)
        if (c.s.heat > peak) c.s.vars[c.self] = c.s.heat
      },
    },
  },
  {
    id: 'rl_gambler_litany',
    name: '도박꾼의 성구',
    slot: 'rail',
    rarity: 'uncommon',
    text: '매 발사 50%로 DMG +150, 50%로 DMG −40',
    hooks: {
      onFire(c) {
        if (c.s.dryRun) {
          // 미리보기가 실제 결과를 바꾸면 안 되므로 rng 를 소비하지 않고 기대값을 쓴다.
          c.dmg += 55
          proc(c)
          return
        }
        c.dmg += c.s.rng.next() < 0.5 ? 150 : -40
        proc(c)
      },
    },
  },
  {
    id: 'rl_descend_litany',
    name: '역순의 성구',
    slot: 'rail',
    rarity: 'rare',
    text: '직전 탄보다 등급이 낮으면 HEAT +4.00',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade >= p.grade) return
        c.heatGain += 4
        proc(c)
      },
    },
  },
  {
    id: 'rl_ascend_litany',
    name: '오름의 성구',
    slot: 'rail',
    rarity: 'rare',
    text: '직전 탄보다 등급이 높으면 DMG +130',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade <= p.grade) return
        c.dmg += 130
        proc(c)
      },
    },
  },
  {
    id: 'rl_death_rite',
    name: '죽음의 성사',
    slot: 'rail',
    rarity: 'rare',
    text: '탄창의 마지막 탄이 철갑탄이면 HEAT +12',
    hooks: {
      onFire(c) {
        if (!c.isLast || !isType(c.s, c.ammo, 'AP')) return
        c.heatGain += 12
        proc(c)
      },
    },
  },
  {
    id: 'rl_unstable_core',
    name: '불안정 노심',
    slot: 'rail',
    rarity: 'rare',
    text: '모든 발사 HEAT +6.00. 온도 30 초과 시 사격 즉시 종료',
    hooks: {
      onFire(c) {
        c.heatGain += 6
        proc(c)
      },
      onAfterShot(c) {
        if (c.s.heat > 30) c.s.abortMag = true
      },
    },
  },
  {
    id: 'rl_machine_sigil',
    name: '기계교 각인',
    slot: 'rail',
    rarity: 'relic',
    text: '전투 시작 시 다른 부착물 1개를 무작위 복제',
    hooks: {
      onCombatStart(c) {
        if (c.s.dryRun) return
        const pool = c.s.attachments.filter((a) => a.id !== c.self && a.rarity !== 'relic')
        if (pool.length === 0) return
        c.s.attachments.push(c.s.rng.pick(pool))
      },
    },
  },
  {
    id: 'rl_saint_relic',
    name: '성인의 유해',
    slot: 'rail',
    rarity: 'relic',
    text: '이번 런에서 획득한 부착물 수 ×14 만큼 모든 탄 DMG +',
    hooks: {
      // 기획서 §6 원안: "이번 런에서 획득한 부착물 수". 교체로 버린 것도 센다.
      // → 보상방에서 "아무거나 줍기"를 처음으로 정당화하는 부착물.
      onCombatStart(c) {
        c.s.vars[c.self] = getVar(c.s, '__taken') * 14
      },
      onFire(c) {
        const v = getVar(c.s, c.self)
        if (v <= 0) return
        c.dmg += v
        proc(c)
      },
    },
  },
]

// ---------------------------------------------------------------------------
// 카탈로그 & 조회
// ---------------------------------------------------------------------------

/** 부착물 56종 전체 (슬롯 순회 순서대로 나열) */
export const ATTACHMENTS: Attachment[] = [
  ...BARRELS,
  ...HANDGUARDS,
  ...OPTICS,
  ...STOCKS,
  ...RAILS,
]

/** id → 부착물 */
export const ATT_BY_ID: Record<string, Attachment> = (() => {
  const m: Record<string, Attachment> = {}
  for (const a of ATTACHMENTS) m[a.id] = a
  return m
})()

/** 해당 슬롯의 부착물 목록 */
export function attachmentsBySlot(slot: SlotKind): Attachment[] {
  return ATTACHMENTS.filter((a) => a.slot === slot)
}

/** 해당 레어도의 부착물 목록 */
export function attachmentsOfRarity(r: Rarity): Attachment[] {
  return ATTACHMENTS.filter((a) => a.rarity === r)
}

/** 조건에 맞는 부착물 1개를 무작위로. 후보가 없으면 null */
export function pickAttachment(
  rng: Rng,
  opts: { slot?: SlotKind; rarity: Rarity; exclude?: Set<string> },
): Attachment | null {
  const ex = opts.exclude
  const pool = ATTACHMENTS.filter(
    (a) =>
      a.rarity === opts.rarity &&
      (opts.slot === undefined || a.slot === opts.slot) &&
      (ex === undefined || !ex.has(a.id)),
  )
  if (pool.length === 0) return null
  return rng.pick(pool)
}

// ---------------------------------------------------------------------------
// 개발용 어서션 — ATTACHMENTS.md §7 분포표와 대조 (import 시 1회)
// ---------------------------------------------------------------------------
function auditCatalog(): void {
  const wantSlot: Record<SlotKind, number> = {
    barrel: 11,
    handguard: 12,
    optic: 10,
    stock: 11,
    rail: 12,
  }
  const wantRarity: Record<Rarity, number> = {
    common: 14,
    uncommon: 18,
    rare: 16,
    relic: 8,
  }

  for (const slot of SLOTS) {
    const n = attachmentsBySlot(slot).length
    if (n !== wantSlot[slot]) {
      console.warn(`[attachments] 슬롯 ${slot} 개수 불일치: ${n} (기대 ${wantSlot[slot]})`)
    }
  }
  for (const r of RARITIES) {
    const n = attachmentsOfRarity(r).length
    if (n !== wantRarity[r]) {
      console.warn(`[attachments] 레어도 ${r} 개수 불일치: ${n} (기대 ${wantRarity[r]})`)
    }
  }
  if (ATTACHMENTS.length !== 56) {
    console.warn(`[attachments] 총계 불일치: ${ATTACHMENTS.length} (기대 56)`)
  }
  if (Object.keys(ATT_BY_ID).length !== ATTACHMENTS.length) {
    const seen = new Set<string>()
    const dup: string[] = []
    for (const a of ATTACHMENTS) {
      if (seen.has(a.id)) dup.push(a.id)
      seen.add(a.id)
    }
    console.warn(`[attachments] id 중복: ${dup.join(', ')}`)
  }
}

auditCatalog()

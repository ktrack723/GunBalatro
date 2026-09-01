// 폐허(Derelict) 이벤트 6종(GDD.md §9.4). 이벤트는 "자원 환율표"일 뿐 새 규칙을 만들지 않는다.
// 각 선택지의 apply(run, rng) 는 RunState 를 직접 변형하고 결과 문장 1줄을 돌려준다.
// 무작위는 전부 인자로 받은 Rng 로만 굴린다.

import type {
  Ammo,
  AmmoType,
  Attachment,
  DerelictEvent,
  Grade,
  Loadout,
  Magazine,
  Rng,
  RunState,
  SlotKind,
} from '../types'
import { ammoLabel, makeAmmo, nextUid } from '../ammoStats'
import { pickAttachment } from './attachments'
import { MAGAZINES } from './magazines'

// ---------------------------------------------------------------------------
// 공용 상수 / 헬퍼
// ---------------------------------------------------------------------------

/** 가방이 이보다 작아지는 압축은 하지 않는다 (드로우가 말라붙는 상태 방지) */
const MIN_BAG = 6

/** 보조 레일 상한 (ATTACHMENTS.md §6 "보조 레일 0~2") */
const MAX_RAIL_SLOTS = 2

type HardpointSlot = Exclude<SlotKind, 'rail'>

const HARDPOINTS: readonly HardpointSlot[] = ['barrel', 'handguard', 'optic', 'stock']

const ALL_TYPES: readonly AmmoType[] = ['AP', 'INC', 'HE', 'SANC']
const ALL_GRADES: readonly Grade[] = [1, 2, 3, 4, 5]
/** 폐허에서 줍는 탄의 등급 분포 — 저등급이 압도적으로 흔하다 */
const SCRAP_GRADE_W: readonly number[] = [40, 30, 18, 9, 3]

/** 등급 +1 (5는 상한). 타입 단언 없이 승급을 표현하기 위한 표 */
const NEXT_GRADE: Record<Grade, Grade> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }

/** 한국어 조사 선택 — 마지막 글자의 받침 유무로 고른다 (한글 음절이 아니면 받침 없음 취급) */
function josa(word: string, withJong: string, withoutJong: string): string {
  const code = word.charCodeAt(word.length - 1)
  if (code < 0xac00 || code > 0xd7a3) return word + withoutJong
  return word + ((code - 0xac00) % 28 !== 0 ? withJong : withoutJong)
}

/** 부착물이 꽂힌 자리를 가리키는 참조 */
type SlotRef = { kind: 'hard'; slot: HardpointSlot } | { kind: 'rail'; index: number }

function readSlot(l: Loadout, ref: SlotRef): Attachment | null {
  return ref.kind === 'hard' ? l[ref.slot] : l.rails[ref.index] ?? null
}

function writeSlot(l: Loadout, ref: SlotRef, a: Attachment | null): void {
  if (ref.kind === 'hard') l[ref.slot] = a
  else l.rails[ref.index] = a
}

/** rails 배열 길이를 railSlots 에 맞춘다 (types.ts 의 "길이 == railSlots" 계약 방어) */
function syncRails(l: Loadout): void {
  if (l.railSlots < 0) l.railSlots = 0
  while (l.rails.length < l.railSlots) l.rails.push(null)
  while (l.rails.length > l.railSlots) l.rails.pop()
}

/** 현재 장착 중인 부착물의 자리 목록 */
function equippedRefs(l: Loadout): SlotRef[] {
  syncRails(l)
  const out: SlotRef[] = []
  for (const s of HARDPOINTS) {
    if (l[s] !== null) out.push({ kind: 'hard', slot: s })
  }
  for (let i = 0; i < l.rails.length; i++) {
    if (l.rails[i] !== null) out.push({ kind: 'rail', index: i })
  }
  return out
}

/** 장착 중인 부착물 id 집합 (중복 지급 방지용) */
function equippedIds(l: Loadout): Set<string> {
  const set = new Set<string>()
  for (const ref of equippedRefs(l)) {
    const a = readSlot(l, ref)
    if (a) set.add(a.id)
  }
  return set
}

/** 비어 있는 보조 레일 칸. 없으면 -1 */
function emptyRailIndex(l: Loadout): number {
  syncRails(l)
  for (let i = 0; i < l.rails.length; i++) {
    if (l.rails[i] === null) return i
  }
  return -1
}

/** 지금 장착 가능한 슬롯 종류 (레일이 0칸이면 레일 부착물은 뽑지 않는다) */
function equippableSlots(l: Loadout): SlotKind[] {
  syncRails(l)
  const slots: SlotKind[] = ['barrel', 'handguard', 'optic', 'stock']
  if (l.rails.length > 0) slots.push('rail')
  return slots
}

/**
 * 부착물을 장착한다. 빈 자리가 있으면 그곳에, 없으면 같은 부위를 교체한다.
 * 결과 문장 조각을 돌려준다 (호출부가 앞말을 붙여 쓴다).
 */
function equipAttachment(l: Loadout, a: Attachment): string {
  syncRails(l)
  if (a.slot === 'rail') {
    const idx = emptyRailIndex(l)
    if (idx >= 0) {
      l.rails[idx] = a
      return josa(a.name, '을', '를') + ' 보조 레일에 달았다.'
    }
    if (l.rails.length === 0) {
      // 레일이 아예 없으면 장착할 방법이 없다 — 이 경로는 pickAttachment 단계에서 이미 걸러진다.
      return josa(a.name, '은', '는') + ' 달 곳이 없어 버렸다.'
    }
    const old = l.rails[0]
    l.rails[0] = a
    return (old ? old.name + ' 대신 ' : '') + josa(a.name, '을', '를') + ' 보조 레일에 달았다.'
  }
  const slot: HardpointSlot = a.slot
  const old = l[slot]
  l[slot] = a
  return (old ? old.name + ' 대신 ' : '') + josa(a.name, '을', '를') + ' 장착했다.'
}

/** 가방에서 무작위 count 발 제거. MIN_BAG 아래로는 내려가지 않는다. 실제 제거 수를 돌려준다 */
function removeRandomAmmo(bag: Ammo[], count: number, rng: Rng): number {
  let removed = 0
  for (let i = 0; i < count; i++) {
    if (bag.length <= MIN_BAG || bag.length === 0) break
    bag.splice(rng.int(bag.length), 1)
    removed++
  }
  return removed
}

/** 무작위 탄 1발 생성. grade 를 주지 않으면 SCRAP_GRADE_W 분포로 굴린다 */
function randomAmmo(rng: Rng, grade?: Grade): Ammo {
  const t = rng.pick(ALL_TYPES)
  const g = grade ?? rng.weighted(ALL_GRADES, SCRAP_GRADE_W)
  return makeAmmo(t, g, nextUid())
}

/** 가방에서 서로 다른 인덱스 n 개를 무작위로 (조건 필터 지원) */
function pickIndices(bag: readonly Ammo[], n: number, rng: Rng, ok: (a: Ammo) => boolean): number[] {
  const cand: number[] = []
  for (let i = 0; i < bag.length; i++) {
    if (ok(bag[i])) cand.push(i)
  }
  rng.shuffle(cand)
  return cand.slice(0, n)
}

// ---------------------------------------------------------------------------
// 이벤트 6종 (GDD.md §9.4)
// ---------------------------------------------------------------------------

const CORPSE_PILE: DerelictEvent = {
  id: 'corpse_pile',
  name: '시체 더미',
  body: '무너진 계단참에 시체가 산처럼 쌓여 있다. 아직 온기가 남은 것도 있다.',
  options: [
    {
      label: '주머니를 턴다 — 탄피 +60',
      apply(run: RunState): string {
        run.loadout.brass += 60
        return '시체들의 주머니에서 탄피 60개를 긁어모았다.'
      },
    },
    {
      // GDD §9.4 원안 그대로. RunState.pending 이 다음 전투 1회에만 소비된다.
      label: '시체 아래를 파헤친다 — 희귀 부착물 · 다음 전투 시작 거리 −8m',
      apply(run: RunState, rng: Rng): string {
        const l = run.loadout
        const slot = rng.pick(equippableSlots(l))
        const att = pickAttachment(rng, { slot, rarity: 'uncommon', exclude: equippedIds(l) })
        run.pending.startDistDelta -= 8
        if (!att) return '쓸 만한 것은 없었다. 소란만 남았고 무리가 가까워졌다.'
        run.attachmentsTaken += 1
        return equipAttachment(l, att) + ' 소란에 무리가 8m 가까워졌다.'
      },
    },
  ],
}

const SEALED_ARK: DerelictEvent = {
  id: 'sealed_ark',
  name: '봉인된 성궤',
  body: '납으로 봉인된 성궤가 제단 위에 놓여 있다. 안에서 무언가 달그락거린다.',
  options: [
    {
      label: '탄을 봉헌한다 — 가방의 탄 3발 등급 +1',
      apply(run: RunState, rng: Rng): string {
        const bag = run.loadout.bag
        const idx = pickIndices(bag, 3, rng, (a) => a.grade < 5)
        if (idx.length === 0) return '이미 전부 최고 등급이다. 성궤는 침묵했다.'
        const names: string[] = []
        for (const i of idx) {
          bag[i].grade = NEXT_GRADE[bag[i].grade]
          names.push(ammoLabel(bag[i]))
        }
        return names.join(', ') + ' — ' + idx.length + '발이 승급했다.'
      },
    },
    {
      label: '성궤를 총에 물린다 — 무작위 미보유 탄창으로 교체',
      apply(run: RunState, rng: Rng): string {
        const cur: Magazine = run.loadout.magazine
        const pool = MAGAZINES.filter((m) => m.id !== cur.id)
        if (pool.length === 0) return '성궤는 지금 물린 것과 똑같은 물건이었다.'
        const next = rng.pick(pool)
        run.loadout.magazine = next
        return cur.name + ' 대신 ' + josa(next.name, '을', '를') + ' 물렸다.'
      },
    },
  ],
}

const CONFESSIONAL: DerelictEvent = {
  id: 'confessional',
  name: '고해실',
  body: '먼지 앉은 고해실. 격자 너머에서 아직도 누군가 듣고 있는 것 같다.',
  options: [
    {
      label: '죄를 고백한다 — 가방에서 탄 2발 영구 제거',
      apply(run: RunState, rng: Rng): string {
        // 정비소 제거가 아니므로 run.removals(가격 상승 카운터)는 건드리지 않는다.
        const n = removeRandomAmmo(run.loadout.bag, 2, rng)
        if (n === 0) return '더 덜어낼 것이 없다. 가방은 이미 가볍다.'
        return '고해와 함께 탄 ' + n + '발을 태웠다. (가방 ' + run.loadout.bag.length + '발)'
      },
    },
    {
      label: '성물을 요구한다 — 부착물 1개를 같은 부위 영웅으로 교체',
      apply(run: RunState, rng: Rng): string {
        const l = run.loadout
        const refs = equippedRefs(l)
        if (refs.length === 0) return '바칠 성물이 없다. 격자 너머는 조용했다.'
        const ref = rng.pick(refs)
        const old = readSlot(l, ref)
        if (!old) return '바칠 성물이 없다. 격자 너머는 조용했다.'
        const next =
          pickAttachment(rng, { slot: old.slot, rarity: 'rare', exclude: equippedIds(l) }) ??
          pickAttachment(rng, { slot: old.slot, rarity: 'rare' })
        if (!next) return josa(old.name, '을', '를') + ' 바쳤으나 돌아온 것은 없었다.'
        writeSlot(l, ref, next)
        return josa(old.name, '을', '를') + ' 바치고 ' + josa(next.name, '을', '를') + ' 받았다.'
      },
    },
  ],
}

const BURNING_ICON: DerelictEvent = {
  id: 'burning_icon',
  name: '불타는 성구',
  body: '꺼지지 않는 불길에 휩싸인 성상. 다가서면 총열까지 열기가 전해진다.',
  options: [
    {
      // GDD §9.4 원안 그대로. RunState.sectorMods 가 섹터 전환 시 초기화된다.
      label: '총열을 불길에 담근다 — 이번 섹터 내내 사격 시작 온도 +3',
      apply(run: RunState): string {
        run.sectorMods.heatStartDelta += 3
        return '총열이 식지 않는다. 이번 섹터 내내 사격이 온도 4.00에서 시작한다.'
      },
    },
    {
      label: '금박을 벗겨낸다 — 탄피 +40',
      apply(run: RunState): string {
        run.loadout.brass += 40
        return '성상의 금박을 벗겨 탄피 40개로 바꿨다.'
      },
    },
  ],
}

const ARMORY_COLLAPSE: DerelictEvent = {
  id: 'armory_collapse',
  name: '탄약고 붕괴',
  body: '천장이 무너져 탄약고가 반쯤 묻혔다. 오래 머물 곳은 아니다.',
  options: [
    {
      label: '닥치는 대로 쓸어담는다 — 무작위 탄 6발',
      apply(run: RunState, rng: Rng): string {
        const bag = run.loadout.bag
        for (let i = 0; i < 6; i++) bag.push(randomAmmo(rng))
        return '탄 6발을 주웠다. 가방이 ' + bag.length + '발로 불었다.'
      },
    },
    {
      label: '무거운 것을 버린다 — 가방을 절반으로 압축',
      apply(run: RunState, rng: Rng): string {
        const bag = run.loadout.bag
        const want = Math.floor(bag.length / 2)
        const n = removeRandomAmmo(bag, want, rng)
        if (n === 0) return '버릴 것이 없다. 가방은 이미 최소한이다.'
        return '탄 ' + n + '발을 잔해에 묻었다. (가방 ' + bag.length + '발)'
      },
    },
  ],
}

const MIRROR_ROOM: DerelictEvent = {
  id: 'mirror_room',
  name: '거울 방',
  body: '깨진 거울이 사방을 둘러싼 방. 총이 두 자루로 보인다.',
  options: [
    {
      label: '총을 거울에 비춘다 — 부착물 1개를 빈 보조 레일에 복제',
      apply(run: RunState, rng: Rng): string {
        const l = run.loadout
        const idx = emptyRailIndex(l)
        if (idx < 0) return '비출 자리가 없다. 거울은 아무것도 돌려주지 않았다.'
        const refs = equippedRefs(l)
        if (refs.length === 0) return '비출 것이 없다. 거울 속 총도 맨몸이었다.'
        const src = readSlot(l, rng.pick(refs))
        if (!src) return '비출 것이 없다. 거울 속 총도 맨몸이었다.'
        // id 는 그대로 둔다(효과 동일성 유지). 배열에 같은 객체가 두 번 들어가지 않도록 얕은 복제만 한다.
        const copy: Attachment = { ...src }
        l.rails[idx] = copy
        return josa(src.name, '이', '가') + ' 거울 속에서 하나 더 걸어 나왔다.'
      },
    },
    {
      label: '거울 틀을 뜯어낸다 — 보조 레일 +1',
      apply(run: RunState): string {
        const l = run.loadout
        if (l.railSlots >= MAX_RAIL_SLOTS) {
          // 상한(2칸)에 걸린 경우의 방어 — 선택지가 죽지 않도록 탄피로 환산한다.
          l.brass += 80
          return '레일은 이미 가득이다. 틀을 팔아 탄피 80개를 얻었다.'
        }
        l.railSlots += 1
        syncRails(l)
        return '거울 틀을 잘라 보조 레일 1칸을 늘렸다. (레일 ' + l.railSlots + '칸)'
      },
    },
  ],
}

export const DERELICTS: DerelictEvent[] = [
  CORPSE_PILE,
  SEALED_ARK,
  CONFESSIONAL,
  BURNING_ICON,
  ARMORY_COLLAPSE,
  MIRROR_ROOM,
]

/**
 * 아직 안 본 이벤트를 우선해서 1종 고른다. 전부 봤으면 6종 전체에서 고른다.
 * 고른 id 는 seen 에 기록된다 (호출부가 같은 Set 을 계속 넘기면 반복이 최소화된다).
 */
export function pickDerelict(rng: Rng, seen: Set<string>): DerelictEvent {
  const fresh = DERELICTS.filter((e) => !seen.has(e.id))
  const pool = fresh.length > 0 ? fresh : DERELICTS
  const ev = rng.pick(pool)
  seen.add(ev.id)
  return ev
}

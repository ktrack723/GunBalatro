// ============================================================================
// 폐허 이벤트 (Derelict) — 6종
//   이벤트는 "기존 자원을 다른 자원으로 바꾸는 환율표"로만 존재한다.
//   새 규칙을 만들지 않는다 (JUSTIFICATION §1).
//   v2 의 자원 축: 탄피 / 특수탄 / 부착물 / 레일 슬롯 / 거리
// ============================================================================
import type { Attachment, DerelictEvent, Rarity, Rng, RunState, SlotKind } from '../types'
import { HARDPOINTS, MAX_RAIL_SLOTS } from '../types'
import { ATTACHMENTS, pickAttachment } from './attachments'
import { SPECIALS, SPECIAL_BY_ID } from './specials'

function equippedIds(run: RunState): Set<string> {
  const l = run.loadout
  const out = new Set<string>()
  for (const a of [l.barrel, l.handguard, l.optic, l.stock, l.magazine]) {
    if (a !== null) out.add(a.id)
  }
  for (const r of l.rails) if (r !== null) out.add(r.id)
  for (const a of l.stash) out.add(a.id)
  return out
}

/** 장착하거나, 자리가 없으면 보관함으로 (전투 중 교체 가능하므로 버려지지 않는다) */
export function equip(run: RunState, a: Attachment): string {
  const l = run.loadout
  run.attachmentsTaken += 1
  if (a.slot === 'rail') {
    const at = l.rails.findIndex((r) => r === null)
    if (at >= 0) {
      l.rails[at] = a
      return a.name + ' 을(를) 보조 레일에 달았다.'
    }
    l.stash.push(a)
    return a.name + ' — 레일이 꽉 차 보관함에 넣었다.'
  }
  const hp = a.slot as Hardpoint
  const cur = l[hp]
  l[hp] = a
  if (cur !== null) {
    l.stash.push(cur)
    return a.name + ' 로 교체했다. (' + cur.name + ' 은 보관함으로)'
  }
  return a.name + ' 을(를) 장착했다.'
}

export function growRails(run: RunState, n: number): void {
  const l = run.loadout
  const next = Math.min(MAX_RAIL_SLOTS, l.railSlots + n)
  while (l.rails.length < next) l.rails.push(null)
  l.railSlots = next
}

function addSpecial(run: RunState, id: string, n: number): void {
  run.loadout.specials[id] = (run.loadout.specials[id] ?? 0) + n
}

function randomSpecialId(rng: Rng, rarity?: Rarity): string {
  const pool = rarity === undefined ? SPECIALS : SPECIALS.filter((s) => s.rarity === rarity)
  const list = pool.length > 0 ? pool : SPECIALS
  return rng.pick(list).id
}

type Hardpoint = 'barrel' | 'handguard' | 'optic' | 'stock' | 'magazine'

function freeSlots(run: RunState): SlotKind[] {
  const l = run.loadout
  const out: SlotKind[] = []
  for (const s of HARDPOINTS as readonly Hardpoint[]) if (l[s] === null) out.push(s)
  if (l.rails.some((r) => r === null)) out.push('rail')
  return out.length > 0 ? out : [...(HARDPOINTS as readonly SlotKind[])]
}

// ---------------------------------------------------------------------------

const CORPSE_PILE: DerelictEvent = {
  id: 'corpse_pile',
  name: '시체 더미',
  body: '통로를 반쯤 막은 시체 더미. 아직 온기가 남아 있다.',
  options: [
    {
      label: '주머니를 뒤진다 — 탄피 +60',
      apply(run) {
        run.loadout.brass += 60
        return '시체들의 주머니에서 탄피 60개를 긁어모았다.'
      },
    },
    {
      label: '시체 아래를 파헤친다 — 희귀 부착물 · 다음 전투 시작 거리 −8m',
      apply(run, rng) {
        const slot = rng.pick(freeSlots(run))
        const a = pickAttachment(rng, { slot, rarity: 'uncommon', exclude: equippedIds(run) })
        run.pending.startDistDelta -= 8
        if (a === null) return '쓸 만한 것은 없었다. 소란에 무리만 가까워졌다.'
        return equip(run, a) + ' 소란에 무리가 8m 가까워졌다.'
      },
    },
  ],
}

const SEALED_ARK: DerelictEvent = {
  id: 'sealed_ark',
  name: '봉인된 성궤',
  body: '납으로 봉인된 성궤. 안에서 무언가 달그락거린다.',
  options: [
    {
      label: '뜯어 연다 — 무작위 영웅 특수탄 2발',
      apply(run, rng) {
        const id = randomSpecialId(rng, 'rare')
        addSpecial(run, id, 2)
        return SPECIAL_BY_ID[id].name + ' 2발을 얻었다.'
      },
    },
    {
      label: '통째로 짊어진다 — 무작위 특수탄 6발 (등급 무작위)',
      apply(run, rng) {
        const lines: string[] = []
        for (let i = 0; i < 6; i += 1) {
          const id = randomSpecialId(rng)
          addSpecial(run, id, 1)
          lines.push(SPECIAL_BY_ID[id].name)
        }
        return '잡다한 탄 6발: ' + lines.join(', ')
      },
    },
  ],
}

const CONFESSIONAL: DerelictEvent = {
  id: 'confessional',
  name: '고해실',
  body: '먼지 쌓인 고해실. 격자 너머에서 낮은 숨소리가 들린다.',
  options: [
    {
      label: '고해한다 — 보관함의 부착물 하나를 같은 부위 영웅급으로',
      apply(run, rng) {
        const l = run.loadout
        if (l.stash.length === 0) return '내놓을 것이 없었다.'
        const i = rng.int(l.stash.length)
        const old = l.stash[i]
        const next = pickAttachment(rng, { slot: old.slot, rarity: 'rare', exclude: equippedIds(run) })
        if (next === null) return '격자 너머는 침묵했다.'
        l.stash[i] = next
        return old.name + ' 이(가) ' + next.name + ' 이(가) 되었다.'
      },
    },
    {
      label: '침묵한다 — 탄피 +45',
      apply(run) {
        run.loadout.brass += 45
        return '아무 말도 하지 않았다. 헌금함에서 탄피 45개를 챙겼다.'
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
      label: '총열을 불길에 담근다 — 이번 섹터 내내 사격 시작 온도 +3',
      apply(run) {
        run.sectorMods.heatStartDelta += 3
        return '총열이 식지 않는다. 이번 섹터 내내 사격이 더 뜨겁게 시작한다.'
      },
    },
    {
      label: '금박을 벗겨낸다 — 탄피 +40',
      apply(run) {
        run.loadout.brass += 40
        return '성상의 금박을 벗겨 탄피 40개로 바꿨다.'
      },
    },
  ],
}

const ARMORY_COLLAPSE: DerelictEvent = {
  id: 'armory_collapse',
  name: '탄약고 붕괴',
  body: '무너진 탄약고. 잔해 속에서 온전한 상자가 보인다.',
  options: [
    {
      label: '깊이 들어간다 — 무작위 특수탄 4발 · 다음 전투 시작 거리 −6m',
      apply(run, rng) {
        for (let i = 0; i < 4; i += 1) addSpecial(run, randomSpecialId(rng), 1)
        run.pending.startDistDelta -= 6
        return '특수탄 4발을 챙겼지만 잔해가 무너져 시간을 잃었다.'
      },
    },
    {
      label: '입구만 훑는다 — 소이탄 2발 · 철갑탄 2발',
      apply(run) {
        addSpecial(run, 'sp_incendiary', 2)
        addSpecial(run, 'sp_ap', 2)
        return '소이탄 2발과 철갑탄 2발을 챙겼다.'
      },
    },
  ],
}

const MIRROR_ROOM: DerelictEvent = {
  id: 'mirror_room',
  name: '거울 방',
  body: '사방이 거울인 방. 거울 속의 당신은 총을 조금 다르게 들고 있다.',
  options: [
    {
      label: '거울에 손을 넣는다 — 보조 레일 +1',
      apply(run) {
        if (run.loadout.railSlots >= MAX_RAIL_SLOTS) {
          run.loadout.brass += 70
          return '레일은 두 칸이 끝이다. 대신 탄피 70개를 챙겼다.'
        }
        growRails(run, 1)
        return '보조 레일 ' + run.loadout.railSlots + '번째 칸이 열렸다.'
      },
    },
    {
      label: '거울을 깬다 — 무작위 부착물 하나를 보관함에',
      apply(run, rng) {
        const rarity: Rarity = rng.next() < 0.35 ? 'rare' : 'uncommon'
        const a =
          pickAttachment(rng, { rarity, exclude: equippedIds(run) }) ??
          rng.pick(ATTACHMENTS)
        run.loadout.stash.push(a)
        run.attachmentsTaken += 1
        return '깨진 거울에서 ' + a.name + ' 이(가) 떨어졌다. (보관함)'
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

export function pickDerelict(rng: Rng, seen: Set<string>): DerelictEvent {
  const fresh = DERELICTS.filter((d) => !seen.has(d.id))
  const pool = fresh.length > 0 ? fresh : DERELICTS
  return rng.pick(pool)
}

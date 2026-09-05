// ============================================================================
// 크레딧 — 세 지역을 전부 넘어섰을 때 한 번.
//
// 왜 굳이 롤을 올리는가:
//   완주는 이 게임에서 가장 드문 사건이다. 그런데 예전에는 결과 화면의 '완주'
//   두 글자로 끝났다 — 통계표가 승리의 보상이 되면 이긴 사람이 자기가 무엇을
//   지나왔는지 되짚을 자리가 없다. 지역 이름과 거기서 마주친 것들을 순서대로
//   다시 올려 주는 것만으로 런 하나가 이야기로 닫힌다.
//
// 조작: 아무 데나 누르면 빨라지고, [건너뛰기] 로 즉시 끝난다.
//   축하는 강제되면 안 된다 — 두 번째 완주부터는 넘기고 싶은 것이 당연하다.
// ============================================================================
import { REGIONS } from '../../core/data/regions'
import { add, on } from '../dom'
import { button, openScreen } from './LoadoutSheet'

/** 롤이 한 번 올라가는 데 걸리는 시간(ms) */
const ROLL_MS = 21000

interface Line {
  text: string
  kind: 'title' | 'lead' | 'role' | 'name' | 'small' | 'gap'
}

function lines(): Line[] {
  const L: Line[] = []
  const push = (kind: Line['kind'], text = ''): void => {
    L.push({ text, kind })
  }

  push('gap')
  push('title', 'GUNBALATRO')
  push('small', '탄을 어떤 순서로 넣느냐가 전부다')
  push('gap')
  push('gap')
  push('lead', '당신은 세 지역을 지나왔다')
  push('gap')

  for (const r of REGIONS) {
    push('role', '지역 ' + r.index + '   ' + r.name)
    push('small', r.tagline)
    push('name', r.boss.name)
    push('small', '「' + r.boss.death + '」')
    push('gap')
  }

  push('gap')
  push('role', '개발')
  push('name', '이준행')
  push('name', '김승건')
  push('gap')
  push('gap')
  push('role', '규칙')
  push('small', '기본탄 하나와 부착물만으로 굴러가는 덱')
  push('gap')
  push('role', '만든 것들')
  push('small', 'three.js · Vite · TypeScript')
  push('gap')
  push('gap')
  push('lead', '복도는 아직 남아 있다')
  push('gap')
  push('gap')

  return L
}

export function showCredits(host: HTMLElement): Promise<void> {
  const sc = openScreen(host, '크레딧', 'credits')
  const { root, bin } = sc
  root.style.overflow = 'hidden'

  const roll = add(root, 'div', 'credits-roll')
  for (const l of lines()) {
    if (l.kind === 'gap') {
      add(roll, 'div', 'credits-gap')
      continue
    }
    add(roll, 'div', 'credits-' + l.kind, l.text)
  }
  roll.style.animationDuration = ROLL_MS + 'ms'

  const bar = add(root, 'div', 'credits-bar')
  const skip = button(bar, '건너뛰기', { kind: 'ghost' })

  let settled = false
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      sc.close()
      resolve()
    }
    // 롤이 끝까지 올라가면 저절로 닫힌다 (+ 여운 0.6초)
    const timer = window.setTimeout(finish, ROLL_MS + 600)
    bin.add(on(skip, 'click', finish))
    // 화면을 누르고 있는 동안 3배속 — 다 읽은 사람을 붙잡아 두지 않는다
    bin.add(on(roll, 'pointerdown', () => {
      roll.style.animationDuration = Math.round(ROLL_MS / 3) + 'ms'
    }))
  })
}

// ============================================================================
// BossRig.ts — 지역 보스의 몸.
//
// 왜 EnemyRig 와 따로 두는가:
//   EnemyRig 는 **인스턴싱된 다지체**다 — 같은 지오메트리를 여러 벌 찍어 무리를
//   만드는 것이 그 구조의 목적이고, 그래서 개체마다 다른 형태를 가질 수 없다.
//   보스는 정확히 그 반대다. 하나뿐이고, 실루엣이 곧 이름이다.
//
// 설계 원칙 — 아이코닉·기괴·심플:
//   ① 한 장으로 읽혀야 한다. 실루엣만 잘라 놔도 셋이 구별되어야 한다.
//   ② 얼굴이 몸통만큼 크다. 무서운 것은 디테일이 아니라 **크기가 틀린 것**이다.
//   ③ 부품 수는 적게. 셋 다 큰 덩어리 하나 + 얼굴 + 팔로 끝난다.
//
// 그리기 예산: 보스당 메시 2개(몸 · 발광) + 움직이는 팔 그룹. 광원은 쓰지 않는다.
// ============================================================================
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/** 플레이어 눈높이. 코앞에 왔을 때 **눈이 마주쳐야** 한다 (EnemyRig 와 같은 값) */
const EYE_H = 1.62

// --- 지오메트리 헬퍼 ---------------------------------------------------------
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const n = g.attributes.position!.count
  const arr = new Float32Array(n * 3)
  const c = new THREE.Color(hex)
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r
    arr[i * 3 + 1] = c.g
    arr[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

function box(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  hex: number, rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  if (ry) g.rotateY(ry)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return tint(g, hex)
}

function ball(
  r: number, sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  hex: number, seg = 12,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1))
  g.scale(sx, sy, sz)
  g.translate(x, y, z)
  return tint(g, hex)
}

function tube(
  r0: number, r1: number, h: number,
  x: number, y: number, z: number,
  hex: number, seg = 8, rx = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg, 1, false)
  if (rx) g.rotateX(rx)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return tint(g, hex)
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return g ?? new THREE.BufferGeometry()
}

// ---------------------------------------------------------------------------
export interface BossVisual {
  /** 씬에 붙는 노드 */
  object: THREE.Group
  /** 조준점 높이 (트레이서가 꽂히는 y) */
  aimY: number
  /** 매 프레임. hit 0~1(피격 직후 1), die 0~1(죽는 중 1로) */
  update(t: number, hit: number, die: number): void
  /** 피격 백색 발광 */
  setFlash(v: number): void
  dispose(): void
}

/** 보스 셋이 공유하는 뼈대 — 몸 하나 + 발광 하나 + 팔 몇 개 */
class Rig implements BossVisual {
  readonly object = new THREE.Group()
  readonly aimY: number
  private readonly bodyMat: THREE.MeshStandardMaterial
  private readonly glowMat: THREE.MeshBasicMaterial
  private readonly meshes: THREE.Mesh[] = []
  private readonly geos: THREE.BufferGeometry[] = []
  /** [그룹, 위상, 진폭, 축] — 축 0=X 회전(앞뒤), 1=Z 회전(좌우) */
  private readonly swing: Array<[THREE.Group, number, number, number]> = []
  private readonly bob: THREE.Group
  private readonly scale: number
  private readonly freq: number
  private readonly glowBase: number

  constructor(opts: {
    body: THREE.BufferGeometry
    glow: THREE.BufferGeometry
    glowColor: number
    aimY: number
    freq: number
    glowOpacity: number
    /** 전체 배율. 보스는 사람보다 커야 한다 — 올려다보게 만드는 것이 절반이다 */
    scale: number
  }) {
    this.aimY = opts.aimY * opts.scale
    this.freq = opts.freq
    this.glowBase = opts.glowOpacity
    this.bob = new THREE.Group()
    this.bob.scale.setScalar(opts.scale)
    this.scale = opts.scale
    this.object.add(this.bob)

    this.bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.08,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    })
    this.glowMat = new THREE.MeshBasicMaterial({
      color: opts.glowColor,
      transparent: true,
      opacity: opts.glowOpacity,
      toneMapped: false,
      fog: false,
      depthWrite: false,
    })

    const bm = new THREE.Mesh(opts.body, this.bodyMat)
    const gm = new THREE.Mesh(opts.glow, this.glowMat)
    gm.renderOrder = 6
    for (const m of [bm, gm]) {
      m.frustumCulled = false
      this.bob.add(m)
      this.meshes.push(m)
    }
    this.geos.push(opts.body, opts.glow)
  }

  /** 흔들리는 부속(팔·촉수)을 단다. pivot 위치에 그룹을 세우고 지오메트리를 붙인다 */
  addLimb(
    px: number, py: number, pz: number,
    geo: THREE.BufferGeometry,
    phase: number, amp: number, axis: number,
  ): void {
    const g = new THREE.Group()
    g.position.set(px, py, pz)
    const m = new THREE.Mesh(geo, this.bodyMat)
    m.frustumCulled = false
    g.add(m)
    this.bob.add(g)
    this.meshes.push(m)
    this.geos.push(geo)
    this.swing.push([g, phase, amp, axis])
  }

  update(t: number, hit: number, die: number): void {
    // 숨쉬기 — 큰 것은 느리게 움직여야 크게 보인다
    const breath = Math.sin(t * this.freq) * 0.5 + 0.5
    this.bob.position.y = breath * 0.06 - die * 1.15
    this.bob.rotation.z = Math.sin(t * this.freq * 0.61) * 0.018 + die * 0.42
    // 피격 움찔 — 뒤로 밀렸다 돌아온다
    this.bob.position.z = -hit * 0.28
    this.bob.scale.setScalar(this.scale * (1 - die * 0.12))

    for (const [g, ph, amp, axis] of this.swing) {
      const a = Math.sin(t * this.freq * 1.7 + ph) * amp * (1 - die * 0.6) + hit * 0.25
      if (axis === 0) g.rotation.x = a
      else g.rotation.z = a
    }
    this.glowMat.opacity = this.glowBase * (1 - die)
  }

  setFlash(v: number): void {
    this.bodyMat.emissiveIntensity = v
  }

  /** 안광 색을 바꾼다 (깜빡이의 전구 명멸) */
  setGlowColor(hex: number): void {
    this.glowMat.color.setHex(hex)
  }

  setGlow(v: number): void {
    this.glowMat.opacity = v
  }

  dispose(): void {
    for (const g of this.geos) g.dispose()
    this.bodyMat.dispose()
    this.glowMat.dispose()
    this.object.clear()
  }
}

// ---------------------------------------------------------------------------
// 깜빡이 — 배전함이 걸어 나온다.
//   몸통은 각진 철제 캐비닛 하나. 얼굴은 전구 두 개와 통풍 그릴 하나뿐이다.
//   팔은 케이블 다발이라 어깨에서 바닥까지 늘어져 끌린다.
// ---------------------------------------------------------------------------
class Blinky extends Rig {
  private flickT = 0
  constructor() {
    const STEEL = 0x555c62
    const DARK = 0x2c3238
    const RUST = 0x6a4a32

    const body: THREE.BufferGeometry[] = [
      // 캐비닛 본체
      box(1.02, 1.55, 0.56, 0, 1.55, 0, STEEL),
      // 문짝 두 짝 (앞면 분할선이 곧 얼굴의 좌우 대칭축이 된다)
      box(0.46, 1.34, 0.06, -0.25, 1.55, 0.30, DARK),
      box(0.46, 1.34, 0.06, 0.25, 1.55, 0.30, DARK),
      // 상단 갓 — 눈두덩처럼 튀어나와 그늘을 만든다
      box(1.16, 0.12, 0.72, 0, 2.34, 0.02, STEEL),
      // 통풍 그릴 = 입. 가로 슬랫 다섯 장
      box(0.62, 0.045, 0.05, 0, 1.30, 0.33, 0x1a1e22),
      box(0.62, 0.045, 0.05, 0, 1.21, 0.33, 0x1a1e22),
      box(0.62, 0.045, 0.05, 0, 1.12, 0.33, 0x1a1e22),
      box(0.62, 0.045, 0.05, 0, 1.03, 0.33, 0x1a1e22),
      box(0.66, 0.28, 0.02, 0, 1.165, 0.31, 0x0d1013),
      // 눈 소켓 (전구를 감싸는 링)
      tube(0.19, 0.19, 0.1, -0.26, 2.02, 0.30, RUST, 10, Math.PI / 2),
      tube(0.19, 0.19, 0.1, 0.26, 2.02, 0.30, RUST, 10, Math.PI / 2),
      // 다리 — 짧은 배관 두 개
      tube(0.14, 0.11, 0.82, -0.3, 0.4, 0, DARK, 7),
      tube(0.14, 0.11, 0.82, 0.3, 0.4, 0, DARK, 7),
      box(0.4, 0.09, 0.5, -0.3, 0.04, 0.04, DARK),
      box(0.4, 0.09, 0.5, 0.3, 0.04, 0.04, DARK),
      // 등 뒤로 뻗은 배관 다발 — 어디에 연결돼 있는지 알 수 없다
      tube(0.07, 0.07, 1.5, -0.2, 2.1, -0.5, RUST, 6, 0.5),
      tube(0.07, 0.07, 1.5, 0.22, 2.2, -0.55, RUST, 6, 0.62),
    ]
    // 전구 두 개 (발광)
    const glow: THREE.BufferGeometry[] = [
      ball(0.145, 1, 1, 0.7, -0.26, 2.02, 0.34, 0xffffff, 10),
      ball(0.145, 1, 1, 0.7, 0.26, 2.02, 0.34, 0xffffff, 10),
      // 그릴 안쪽에서 새는 빛
      box(0.58, 0.2, 0.01, 0, 1.165, 0.345, 0xffffff),
    ]
    super({
      body: merge(body),
      glow: merge(glow),
      glowColor: 0xffd07a,
      aimY: EYE_H * 1.02,
      freq: 1.05,
      glowOpacity: 0.95,
      scale: 1.4,
    })

    // 케이블 팔 — 어깨에서 늘어져 바닥에 끌린다
    for (const side of [-1, 1]) {
      const arm: THREE.BufferGeometry[] = []
      for (let i = 0; i < 4; i++) {
        const y = -0.32 * i
        arm.push(tube(0.075 - i * 0.008, 0.07 - i * 0.008, 0.34, side * (0.06 + i * 0.05), y - 0.17, i * 0.03, 0x30363c, 6))
      }
      arm.push(box(0.2, 0.12, 0.3, side * 0.26, -1.3, 0.1, 0x6a4a32))
      super.addLimb(side * 0.56, 2.12, 0.06, merge(arm), side > 0 ? 0 : Math.PI, 0.16, 0)
    }
  }

  /**
   * 전구는 **명멸한다** — 이름이 그것이다.
   *   결정론적 사인 합성에 짧은 정전을 섞는다. 완전히 꺼지는 순간이 있어야
   *   "깜빡인다" 로 읽힌다.
   */
  override update(t: number, hit: number, die: number): void {
    super.update(t, hit, die)
    this.flickT = t
    const n = Math.sin(t * 7.3) * 0.5 + Math.sin(t * 17.1) * 0.3
    const out = Math.sin(t * 1.9) > 0.94 ? 0.05 : 1
    super.setGlow(Math.max(0, (0.62 + n * 0.22) * out * (1 - die)))
  }
}

// ---------------------------------------------------------------------------
// 관리인 — 벽지와 같은 색의 거인.
//   그림자가 없는 지역이므로 실루엣이 색으로 구별되지 않는다. 대신 **얼굴만**
//   검다 — 눈 두 개와 초승달 입. 팔은 비정상적으로 길어 바닥을 쓸고 다닌다.
// ---------------------------------------------------------------------------
class Custodian extends Rig {
  constructor() {
    const SKIN = 0xd8c057
    const DEEP = 0xa88c33

    const body: THREE.BufferGeometry[] = [
      // 몸통 — 아래로 갈수록 벌어지는 매끈한 덩어리 (다리가 없다)
      ball(0.52, 1.0, 1.75, 0.72, 0, 1.55, 0, SKIN, 14),
      ball(0.62, 1.0, 0.55, 0.8, 0, 0.42, 0, DEEP, 14),
      // 목 — 아주 짧다. 머리가 어깨에 얹혀 있다
      tube(0.2, 0.26, 0.2, 0, 2.42, 0, DEEP, 10),
      // 머리 — 몸통에 비해 크다
      ball(0.42, 1.06, 1.0, 0.94, 0, 2.78, 0, SKIN, 16),
      // 어깨 — 각이 없어야 사람이 아니게 보인다
      ball(0.2, 1.0, 0.8, 1.0, -0.46, 2.3, 0, SKIN, 10),
      ball(0.2, 1.0, 0.8, 1.0, 0.46, 2.3, 0, SKIN, 10),
    ]
    // 얼굴 — 여기만 검다
    const glow: THREE.BufferGeometry[] = [
      ball(0.115, 1, 1, 0.35, -0.15, 2.86, 0.38, 0xffffff, 12),
      ball(0.115, 1, 1, 0.35, 0.15, 2.86, 0.38, 0xffffff, 12),
    ]
    // 초승달 입 — 상자를 호를 따라 세워 만든다 (토러스보다 싸고 더 거칠다)
    for (let i = 0; i < 9; i++) {
      const u = (i / 8) * 2 - 1
      const x = u * 0.27
      const y = 2.62 - (1 - u * u) * 0.12
      glow.push(box(0.075, 0.055 + (1 - Math.abs(u)) * 0.05, 0.02, x, y, 0.40, 0xffffff, 0, 0, -u * 0.5))
    }
    super({
      body: merge(body),
      glow: merge(glow),
      glowColor: 0x120d02,
      aimY: EYE_H * 1.08,
      freq: 0.72,
      glowOpacity: 1,
      scale: 1.3,
    })

    // 팔 — 바닥을 넘어설 만큼 길다. 걸을 때마다 카펫을 쓴다
    for (const side of [-1, 1]) {
      const arm: THREE.BufferGeometry[] = [
        tube(0.115, 0.085, 1.5, side * 0.06, -0.75, 0, SKIN, 8),
        tube(0.085, 0.06, 1.1, side * 0.16, -1.85, 0.06, SKIN, 8),
        // 손 — 손가락 넷이 그대로 뻗어 있다
        ball(0.09, 1.0, 0.7, 0.9, side * 0.2, -2.42, 0.06, DEEP, 8),
      ]
      for (let f = 0; f < 4; f++) {
        arm.push(tube(0.022, 0.012, 0.34, side * 0.2 + (f - 1.5) * 0.045, -2.62, 0.08, DEEP, 5))
      }
      super.addLimb(side * 0.48, 2.3, 0, merge(arm), side > 0 ? 0.6 : 0.6 + Math.PI, 0.2, 0)
    }
  }
}

// ---------------------------------------------------------------------------
// 어머니 — 천장에서 늘어진 살덩이.
//   종 모양 하나에 큰 눈 하나. 그 아래로 세로로 벌어진 입. 촉수 여섯이 바닥까지
//   드리워져 복도를 막는다. 좌우 대칭이 아주 강해서 '얼굴' 로 읽힌다.
// ---------------------------------------------------------------------------
class Mother extends Rig {
  constructor() {
    const FLESH = 0x8e2b2d
    const DEEP = 0x50161a
    const PALE = 0xc39a86

    // 종은 z 로 눌러 둔다(0.72). 얼굴 부품은 그 앞면(z ≈ 0.68)보다 **더 앞에**
    // 놓아야 파묻히지 않는다 — 첫 조립에서 눈이 몸 안에 갇혀 안 보였다.
    const body: THREE.BufferGeometry[] = [
      ball(0.98, 1.05, 0.98, 0.72, 0, 1.95, 0, FLESH, 16),
      ball(0.78, 1.12, 0.62, 0.8, 0, 1.16, 0.04, FLESH, 14),
      // 천장으로 이어지는 줄기 — 어디에 매달려 있는지 끝이 보이지 않는다
      tube(0.24, 0.46, 1.6, 0, 3.15, -0.12, DEEP, 10),
      tube(0.5, 0.62, 0.3, 0, 2.6, -0.08, DEEP, 12),
      // 갈비 융기 — **옆구리에만**. 앞면에 두면 눈꺼풀처럼 읽혀 얼굴을 망친다
      box(0.16, 0.1, 1.1, -0.82, 2.25, -0.1, DEEP, 0, 0, 0.5),
      box(0.16, 0.1, 1.1, 0.82, 2.25, -0.1, DEEP, 0, 0, -0.5),
      box(0.14, 0.09, 0.95, -0.9, 1.85, -0.05, DEEP, 0, 0, 0.3),
      box(0.14, 0.09, 0.95, 0.9, 1.85, -0.05, DEEP, 0, 0, -0.3),
      // 눈두덩 — 눈보다 조금 뒤, 조금 크게. 눈이 '박혀 있다' 로 읽히게 한다
      ball(0.44, 1.0, 1.0, 0.3, 0, 1.86, 0.6, PALE, 14),
      // 입술 — 세로 틈을 감싼다
      ball(0.2, 1.0, 2.0, 0.28, 0, 1.16, 0.62, PALE, 10),
      // 동공 — **안광보다 앞에** 둔다. 발광 메시는 깊이를 쓰지 않으므로
      // 이 원반이 앞에 있으면 그만큼 가려져 '눈' 으로 읽힌다. 없으면 알이다.
      ball(0.115, 1, 1, 0.25, 0, 1.86, 1.0, 0x140507, 12),
    ]
    const glow: THREE.BufferGeometry[] = [
      // 큰 눈 하나 — 이 게임에서 가장 큰 안광이다. 몸 앞면 밖으로 튀어나온다
      ball(0.33, 1, 1, 0.55, 0, 1.86, 0.78, 0xffffff, 16),
      // 세로로 벌어진 입
      ball(0.115, 1, 3.0, 0.5, 0, 1.16, 0.76, 0xffffff, 10),
    ]
    super({
      body: merge(body),
      glow: merge(glow),
      glowColor: 0xffc0ac,
      aimY: EYE_H * 1.02,
      freq: 0.55,
      glowOpacity: 0.92,
      scale: 1.25,
    })

    // 촉수 여섯 — 종의 아랫단을 둘러 늘어져 복도를 막는다
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5
      const px = Math.cos(a) * 0.72
      const pz = Math.sin(a) * 0.4
      const arm: THREE.BufferGeometry[] = []
      for (let k = 0; k < 3; k++) {
        arm.push(
          tube(
            0.11 - k * 0.025, 0.09 - k * 0.025, 0.4,
            Math.cos(a) * k * 0.07, -0.2 - k * 0.38, Math.sin(a) * k * 0.05,
            k < 2 ? FLESH : DEEP, 6,
          ),
        )
      }
      super.addLimb(px, 1.18, pz, merge(arm), i * 1.05, 0.26, i % 2)
    }
  }
}

// ---------------------------------------------------------------------------
export function makeBoss(id: string): BossVisual | null {
  switch (id) {
    case 'boss_blinky':
      return new Blinky()
    case 'boss_custodian':
      return new Custodian()
    case 'boss_mother':
      return new Mother()
    default:
      return null
  }
}

// ============================================================================
// EnemyRig.ts — 적. **사람 형태를 버렸다.**
//
//   이 게임의 적은 좀비의 실루엣일 필요가 없다. 실루엣이 하는 일은 딱 둘이다:
//     ① 지금 얼마나 가까운가 (거리 = 남은 목숨)
//     ② 지금 살아 있는가 (피격/처치 반응)
//   사람형은 둘 다 잘 못한다 — 어두운 복도에서 사람 실루엣은 벽 소품과 섞인다.
//   대신 **거대 절지 크리처**로 간다: 낮고 넓은 갑각 + 다리 8개가 몸 위로 아치를 그리고,
//   앞쪽에 머리 줄기가 여러 개 솟는다. 폭이 넓어 복도를 가로로 채우므로
//   "가까워진다"가 화면 점유율로 즉시 읽힌다.
//
//   색은 검정이다. 그래서 **손전등이 정보 채널**이 된다 — 빛이 닿는 만큼만 보인다.
//   거리 판독은 몸이 아니라 **다수의 안광**이 맡는다 (가산 블렌딩이라 광량과 무관).
//
//   드로우콜 3장 유지: 몸 / 다리(개체×다리수) / 안광(개체×눈수). 전부 인스턴싱.
// ============================================================================
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { makeViewRng, viewSeedOf, type ViewRng } from './postShader'

const MAX_BODIES = 5
const MAX_LEGS = 8
const MAX_EYES = 9

/** 거리(m) → 카메라 전방 z. 30m 은 멀리, 0m 은 코앞 */
export function distanceToZ(meters: number): number {
  return -(Math.max(0, meters) * 0.55 + 1.2)
}

// --- 지오메트리 헬퍼 ---------------------------------------------------------
/** XY 평면 위의 두 점을 잇는 원뿔대. 다리 마디 하나 = 이것 하나 */
function limb(
  x0: number, y0: number, x1: number, y1: number,
  r0: number, r1: number, seg = 5,
): THREE.BufferGeometry {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.hypot(dx, dy) || 0.001
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false)
  g.rotateZ(Math.atan2(dy, dx) - Math.PI / 2)
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, 0)
  return g
}

function blob(
  r: number, sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 9, 6)
  g.scale(sx, sy, sz)
  g.translate(x, y, z)
  return g
}

/** 앞으로 뻗은 머리 줄기 — 끝에 안광이 붙는다 */
function stalk(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  r: number,
): THREE.BufferGeometry {
  const len = Math.hypot(ax, ay, az) || 0.001
  const g = new THREE.CylinderGeometry(r * 0.45, r, len, 5, 1, false)
  g.translate(0, len / 2, 0)
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(ax, ay, az).normalize(),
  )
  g.applyQuaternion(q)
  g.translate(x, y, z)
  return g
}

// ---------------------------------------------------------------------------
// 아키타입 — 규칙(속도/HP)은 core 가 정하고, 여기서는 **실루엣만** 바꾼다.
// ---------------------------------------------------------------------------
interface ArchParams {
  /** 전체 크기 */
  scale: number
  /** 갑각이 뜬 높이 (m) */
  ride: number
  /** 다리 개수 (짝수로 맞춰 좌우 대칭) */
  legs: number
  /** 다리 길이 배율 */
  legLen: number
  /** 몸통 가로 배율 — 복도를 얼마나 채우나 */
  wide: number
  /** 걸음 주파수 */
  freq: number
  /** 떨림 세기 */
  tremor: number
  /** 개체 흩어짐 */
  spread: number
  /** 머리 줄기 개수 */
  heads: number
}

function archParams(id: string): ArchParams {
  switch (id) {
    // 주자: 다리 6개, 길고 낮게 — 도약 직전의 자세
    case 'runner':
      return { scale: 1.06, ride: 0.68, legs: 6, legLen: 1.34, wide: 0.90, freq: 3.4, tremor: 1.5, spread: 0.5, heads: 2 }
    // 비대체: 부푼 배가 복도를 메운다. 다리는 짧고 몸에 눌린다
    case 'bloat':
      return { scale: 1.55, ride: 0.60, legs: 8, legLen: 0.80, wide: 1.55, freq: 0.8, tremor: 0.6, spread: 0.4, heads: 4 }
    // 무리: 작은 것들이 여럿
    case 'horde':
      return { scale: 0.78, ride: 0.54, legs: 6, legLen: 1.00, wide: 0.92, freq: 2.2, tremor: 1.2, spread: 1.15, heads: 2 }
    // 기어다니는 것: 바닥에 붙어 넓게 퍼진다
    case 'crawler':
      return { scale: 1.18, ride: 0.28, legs: 8, legLen: 1.45, wide: 1.40, freq: 1.9, tremor: 1.0, spread: 0.5, heads: 3 }
    // 배회자: 기준선
    default:
      return { scale: 1.20, ride: 0.86, legs: 8, legLen: 1.10, wide: 1.05, freq: 1.3, tremor: 1.0, spread: 0.55, heads: 3 }
  }
}

/** 안광 배치 (몸 기준 로컬 오프셋 + 크기). 앞쪽에 몰려 있어 '얼굴'로 읽힌다 */
const EYE_LOCAL: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.000, 0.075, 0.360, 1.35],
  [-0.105, 0.055, 0.330, 1.0],
  [0.105, 0.055, 0.330, 1.0],
  [-0.170, 0.020, 0.265, 0.78],
  [0.170, 0.020, 0.265, 0.78],
  [-0.062, 0.115, 0.300, 0.62],
  [0.062, 0.115, 0.300, 0.62],
  [-0.215, -0.030, 0.170, 0.5],
  [0.215, -0.030, 0.170, 0.5],
]

interface Body {
  ox: number
  oz: number
  phase: number
  freqMul: number
  scale: number
  yaw: number
  shake: number
  /** 다리별 위상 (교대 보행) */
  legPhase: number[]
}

export class EnemyRig {
  /** 씬 루트에 붙는 노드 */
  readonly object = new THREE.Group()

  private readonly bodyMesh: THREE.InstancedMesh
  private readonly legMesh: THREE.InstancedMesh
  private readonly eyeMesh: THREE.InstancedMesh
  private readonly mat: THREE.MeshStandardMaterial
  private readonly eyeMat: THREE.MeshBasicMaterial

  private rng: ViewRng = makeViewRng(0x2b1e)
  private readonly bodies: Body[] = []
  private params: ArchParams = archParams('shambler')
  private count = 1

  // 거리 보간
  private z = distanceToZ(30)
  private zFrom = this.z
  private zTo = this.z
  private tweenT = 1
  private readonly TWEEN = 0.6
  private nearness = 0

  // 상태
  private t = 0
  private hitT = -1
  private dieT = -1
  private dead = false

  private readonly _m = new THREE.Matrix4()
  private readonly _p = new THREE.Vector3()
  private readonly _q = new THREE.Quaternion()
  private readonly _e = new THREE.Euler()
  private readonly _s = new THREE.Vector3()
  private readonly _tw = new THREE.Vector3()

  constructor() {
    // --- 몸통: 두흉부 + 부푼 배 + 머리 줄기 + 큰턱 -------------------------
    //   원점은 갑각 중심. 그룹을 ride 높이에 놓으면 다리가 바닥에 닿는다.
    const bodyParts: THREE.BufferGeometry[] = [
      blob(0.30, 1.0, 0.52, 1.15, 0, 0, 0.10),        // 두흉부
      blob(0.34, 1.12, 0.78, 1.25, 0, -0.02, -0.44),  // 배
      blob(0.16, 1.0, 0.7, 1.0, 0, 0.10, -0.16),      // 이음 마디
      // 등판 융기 — 손전등이 닿을 때 하이라이트가 걸리는 면
      blob(0.13, 1.5, 0.42, 0.9, 0, 0.16, -0.40),
      blob(0.09, 1.4, 0.4, 0.8, 0, 0.19, -0.10),
      // 큰턱 2개
      limb(0.09, 0.0, 0.17, -0.14, 0.030, 0.008).translate(0, -0.02, 0.34),
      limb(-0.09, 0.0, -0.17, -0.14, 0.030, 0.008).translate(0, -0.02, 0.34),
    ]
    // 머리 줄기 4개까지 만들어 두고, 아키타입별 개수만큼만 보이게 스케일한다
    // (인스턴싱이라 개체별로 지오메트리를 못 바꾼다 — 항상 그리되 형태로 변주한다)
    const stalks: Array<[number, number, number, number, number, number]> = [
      [0, 0.14, 0.28, 0, 0.30, 0.22],
      [-0.13, 0.10, 0.26, -0.16, 0.24, 0.20],
      [0.13, 0.10, 0.26, 0.16, 0.24, 0.20],
      [0, 0.16, 0.02, 0, 0.26, -0.10],
    ]
    for (const [x, y, z, ax, ay, az] of stalks) {
      bodyParts.push(stalk(x, y, z, ax, ay, az, 0.036))
    }
    const bodyGeo = mergeGeometries(bodyParts)!
    for (const g of bodyParts) g.dispose()

    // --- 다리 한 짝 (엉덩이 관절이 원점, +X 로 뻗는다) ---------------------
    //   무릎이 몸보다 **위로** 솟는다. 거미가 무서운 이유는 이 아치다.
    const legParts: THREE.BufferGeometry[] = [
      blob(0.055, 1, 1, 1, 0.02, 0.02, 0),                    // 고관절
      limb(0.02, 0.02, 0.40, 0.36, 0.052, 0.034),             // 넓적다리 (위로)
      blob(0.040, 1, 1, 1, 0.40, 0.36, 0),                    // 무릎
      limb(0.40, 0.36, 0.66, -0.60, 0.034, 0.013),            // 정강이 (아래로)
      limb(0.66, -0.60, 0.745, -0.735, 0.013, 0.004),         // 발톱
    ]
    const legGeo = mergeGeometries(legParts)!
    for (const g of legParts) g.dispose()

    // --- 머티리얼 ----------------------------------------------------------
    //   검은 각질. roughness 를 낮게 잡아 **젖은 하이라이트**가 서게 한다 —
    //   완전 무광 검정은 손전등을 비춰도 아무것도 안 보인다.
    this.mat = new THREE.MeshStandardMaterial({
      color: 0x070809,
      roughness: 0.34,
      metalness: 0.18,
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 0,
    })
    this.eyeMat = new THREE.MeshBasicMaterial({
      color: 0xff2f1e,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    })

    this.bodyMesh = new THREE.InstancedMesh(bodyGeo, this.mat, MAX_BODIES)
    this.legMesh = new THREE.InstancedMesh(legGeo, this.mat, MAX_BODIES * MAX_LEGS)
    const eyeGeo = new THREE.PlaneGeometry(0.052, 0.030)
    this.eyeMesh = new THREE.InstancedMesh(eyeGeo, this.eyeMat, MAX_BODIES * MAX_EYES)
    for (const m of [this.bodyMesh, this.legMesh, this.eyeMesh]) {
      m.frustumCulled = false
      m.castShadow = false
      m.receiveShadow = false
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      this.object.add(m)
    }
    this.eyeMesh.renderOrder = 6
    this.spawn(1, 'shambler')
  }

  // -------------------------------------------------------------------------
  spawn(bodyCount: number, archetypeId: string): void {
    this.count = THREE.MathUtils.clamp(Math.floor(bodyCount) || 1, 1, MAX_BODIES)
    this.params = archParams(archetypeId)
    this.rng = makeViewRng(viewSeedOf(archetypeId) ^ (this.count * 2654435761))
    this.bodies.length = 0
    for (let i = 0; i < this.count; i++) {
      const solo = this.count === 1
      const legPhase: number[] = []
      for (let k = 0; k < MAX_LEGS; k++) {
        // 좌우 교대 + 앞뒤 파동 — 거미의 4쌍 교대 보행
        legPhase.push((k % 2) * Math.PI + Math.floor(k / 2) * 0.9)
      }
      this.bodies.push({
        ox: solo ? this.rng.range(-0.12, 0.12) : this.rng.range(-1, 1) * this.params.spread,
        oz: solo ? 0 : -this.rng.range(0, 2.4),
        phase: this.rng.range(0, Math.PI * 2),
        freqMul: this.rng.range(0.86, 1.18),
        scale: this.params.scale * this.rng.range(0.94, 1.06),
        yaw: this.rng.range(-0.14, 0.14),
        shake: 0,
        legPhase,
      })
    }
    this.bodyMesh.count = this.count
    this.legMesh.count = this.count * this.params.legs
    this.eyeMesh.count = this.count * MAX_EYES
    this.dead = false
    this.dieT = -1
    this.hitT = -1
    this.mat.emissiveIntensity = 0
    this.eyeMat.opacity = 0.95
    for (const m of [this.bodyMesh, this.legMesh, this.eyeMesh]) m.visible = true
    this.writeMatrices()
  }

  /** 거리(m) → 3D 위치. animate=true 면 600ms ease-in 보간 (§2.3 t=300) */
  setDistance(meters: number, startDist: number, animate: boolean): void {
    const z = distanceToZ(meters)
    this.nearness = THREE.MathUtils.clamp(1 - meters / Math.max(1, startDist), 0, 1)
    if (animate) {
      this.zFrom = this.z
      this.zTo = z
      this.tweenT = 0
    } else {
      this.z = this.zFrom = this.zTo = z
      this.tweenT = 1
    }
  }

  /** 손전등이 겨눌 z (Scene 이 읽어 스포트라이트 타깃을 옮긴다) */
  get bodyZ(): number {
    return this.z
  }

  /** 피격: 백색 emissive 2프레임 후 감쇠 (§2.2 t=120) */
  hitFlash(): void {
    this.hitT = 0
  }

  /** 히트 리액션: 다리가 접히며 뒤로 밀린다 */
  shake(): void {
    for (const b of this.bodies) b.shake = 1
  }

  /** 처치 (§2.4) */
  die(): void {
    if (this.dead) return
    this.dead = true
    this.dieT = 0
  }

  get isDead(): boolean {
    return this.dead
  }

  /** 갑각 월드 좌표 (트레이서 끝점). 무리면 가장 앞선 개체를 겨눈다 */
  get targetWorld(): THREE.Vector3 {
    let b = this.bodies[0]
    for (const o of this.bodies) if (b && o.oz > b.oz) b = o
    const s = b ? b.scale : 1
    this._tw.set(b ? b.ox : 0, this.params.ride * s, this.z + (b ? b.oz : 0) + 0.1 * s)
    this.object.updateWorldMatrix(true, false)
    return this._tw.applyMatrix4(this.object.matrixWorld)
  }

  // -------------------------------------------------------------------------
  update(dt: number): void {
    const d = Math.min(dt, 0.05)
    this.t += d

    // 거리 보간 (ease-in)
    if (this.tweenT < 1) {
      this.tweenT = Math.min(1, this.tweenT + d / this.TWEEN)
      const e = this.tweenT * this.tweenT
      this.z = this.zFrom + (this.zTo - this.zFrom) * e
    }

    // 피격 플래시: 33ms 유지 후 120ms 감쇠
    let flash = 0
    if (this.hitT >= 0) {
      this.hitT += d
      if (this.hitT < 0.033) flash = 1
      else if (this.hitT < 0.153) flash = 1 - (this.hitT - 0.033) / 0.12
      else this.hitT = -1
    }

    // 죽음
    let dieP = 0
    if (this.dieT >= 0) {
      this.dieT += d
      dieP = THREE.MathUtils.clamp(this.dieT / 0.9, 0, 1)
      if (dieP >= 1) {
        for (const m of [this.bodyMesh, this.legMesh, this.eyeMesh]) m.visible = false
        this.dieT = -1
      }
    }

    // --- 머티리얼 ---------------------------------------------------------
    //   몸은 **검다**. 보이는 이유는 손전등이 닿아서다 — emissive 로 실루엣을
    //   세우는 v1 의 방식은 "검은색으로 해달라"는 요구와 정면으로 충돌한다.
    //   그래서 거리 판독은 emissive 가 아니라 **안광**이 맡는다 (아래 writeMatrices).
    //   여기 남은 emissive 는 아주 약한 자기발광(젖은 표면의 되비침) 뿐이다.
    if (dieP > 0) {
      const burst = Math.max(0, 1 - dieP / 0.22)
      this.mat.emissive.setRGB(1, 0.12 * burst + 0.02, 0.06 * burst)
      this.mat.emissiveIntensity = 0.05 + burst * 2.6
      this.eyeMat.opacity = 0.95 * (1 - dieP)
    } else if (flash > 0) {
      this.mat.emissive.setRGB(1, 1, 1)
      this.mat.emissiveIntensity = flash * 1.8
    } else {
      // 손전등 밖에서도 형체가 '있다'는 것만 느껴질 정도. 색은 거의 검정.
      this.mat.emissive.setRGB(0.05, 0.055, 0.075)
      this.mat.emissiveIntensity = 0.34 + 0.16 * (1 - this.nearness)
    }

    for (const b of this.bodies) {
      if (b.shake > 0) b.shake = Math.max(0, b.shake - d / 0.14)
    }

    this.writeMatrices(dieP)
  }

  private writeMatrices(dieP = 0): void {
    const P = this.params
    const legs = P.legs
    let legI = 0
    let eyeI = 0

    for (let i = 0; i < this.count; i++) {
      const b = this.bodies[i]!
      const w = this.t * P.freq * b.freqMul * Math.PI
      // 떨림 — 이 크리처의 서명. 고주파 저진폭, 걷지 않아도 항상 떤다.
      const trem = P.tremor * (0.010 + 0.006 * Math.sin(this.t * 3.1 + b.phase))
      const tx = Math.sin(this.t * 47 + b.phase * 3) * trem
      const ty = Math.sin(this.t * 61 + b.phase * 5) * trem
      const tRoll = Math.sin(this.t * 53 + b.phase) * trem * 2.4

      const bob = Math.sin(w * 2 + b.phase) * 0.030
      const swayX = Math.sin(w + b.phase) * 0.035
      const back = b.shake * -0.10
      const sink = dieP > 0 ? -P.ride * 0.9 * dieP * dieP : 0
      const collapse = dieP > 0 ? dieP : 0

      const s = b.scale * (dieP > 0 ? 1 + Math.max(0, 1 - dieP / 0.2) * 0.06 : 1)
      const bx = b.ox + swayX + tx
      const by = P.ride * s + bob + sink + ty
      const bz = this.z + b.oz + back

      // --- 갑각 ---
      this._p.set(bx, by, bz)
      this._e.set(0.05 + collapse * 0.5, b.yaw, tRoll + Math.sin(w + b.phase) * 0.04)
      this._q.setFromEuler(this._e)
      this._s.set(s * P.wide, s * (1 - dieP * 0.3), s)
      this._m.compose(this._p, this._q, this._s)
      this.bodyMesh.setMatrixAt(i, this._m)

      // --- 다리 ---
      //   엉덩이 관절을 갑각 둘레에 배치하고, 각 다리를 바깥으로 yaw 시킨다.
      //   앞쪽 반원에 몰아 배치해 '앞으로 기어온다'가 읽히게 한다.
      //   오일러 순서는 기본 'XYZ' — 회전 행렬이 Rx·Ry·Rz 라 **Z 가 다리 자기 평면에서
      //   먼저** 걸린다. 그래서 Z = 보행 들어올림, Y = 몸 둘레 벌림으로 나눠 쓴다.
      //   좌우 대칭은 음수 스케일이 아니라 Y 회전 π 로 만든다 (음수 스케일은 법선을 뒤집는다).
      for (let k = 0; k < legs; k++) {
        const side = k % 2 === 0 ? 1 : -1
        const rank = Math.floor(k / 2) // 0 = 가장 앞
        const pairs = Math.max(1, Math.ceil(legs / 2))
        const along = pairs === 1 ? 0.5 : rank / (pairs - 1) // 0..1 앞→뒤
        const splay = (along - 0.46) * 1.6 // 앞다리는 +z(카메라 쪽), 뒷다리는 -z
        const hipZ = 0.24 - along * 0.60
        const gait = Math.sin(w * 1.6 + b.legPhase[k]!)
        const legTrem = Math.sin(this.t * (58 + k * 7) + b.phase) * P.tremor * 0.05

        this._p.set(
          bx + side * 0.16 * s * P.wide,
          by - 0.02 * s,
          bz + hipZ * s,
        )
        this._e.set(
          0,
          b.yaw + (side > 0 ? splay : Math.PI - splay),
          gait * 0.20 + legTrem * 1.6 - collapse * 1.25,
        )
        this._q.setFromEuler(this._e)
        const ls = s * P.legLen
        this._s.set(ls, ls, ls)
        this._m.compose(this._p, this._q, this._s)
        this.legMesh.setMatrixAt(legI, this._m)
        legI += 1
      }

      // --- 안광 ---
      //   가산 블렌딩이라 광량과 무관하게 보인다 → **거리 판독은 이 눈들이 한다.**
      //   먼 거리에서는 개별 눈이 1px 이하로 뭉개지므로, 거리가 멀수록 조금 키운다.
      const far = 1 - this.nearness
      const eyeBoost = 1 + far * 2.2
      const eyesOn = Math.min(MAX_EYES, 3 + P.heads * 2)
      for (let k = 0; k < MAX_EYES; k++) {
        const [ex, ey, ez, esz] = EYE_LOCAL[k]!
        // 머리 줄기 수가 적은 아키타입은 바깥쪽 눈을 끈다 (스케일 0)
        const on = k < eyesOn
        const blink = 0.86 + 0.14 * Math.sin(this.t * (2.3 + k * 0.4) + b.phase * 2)
        this._p.set(
          bx + ex * s * P.wide,
          by + ey * s,
          bz + ez * s,
        )
        this._e.set(0, b.yaw * 0.5, tRoll * 0.5)
        this._q.setFromEuler(this._e)
        const sc = on && dieP < 1 ? esz * s * eyeBoost * blink * (1 - dieP) : 0
        this._s.set(sc, sc, sc)
        this._m.compose(this._p, this._q, this._s)
        this.eyeMesh.setMatrixAt(eyeI, this._m)
        eyeI += 1
      }
    }

    this.legMesh.count = this.count * legs
    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.legMesh.instanceMatrix.needsUpdate = true
    this.eyeMesh.instanceMatrix.needsUpdate = true
  }

  setVisible(v: boolean): void {
    this.object.visible = v
  }

  dispose(): void {
    this.bodyMesh.geometry.dispose()
    this.legMesh.geometry.dispose()
    this.eyeMesh.geometry.dispose()
    this.bodyMesh.dispose()
    this.legMesh.dispose()
    this.eyeMesh.dispose()
    this.mat.dispose()
    this.eyeMat.dispose()
    this.object.removeFromParent()
  }
}

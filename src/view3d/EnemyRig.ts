// ============================================================================
// EnemyRig.ts — 좀비. 캡슐+박스 실루엣을 병합해 InstancedMesh 3장으로 렌더한다.
//   몸통 / 팔 / 안광 = 드로우콜 3. bodyCount(무리 5) 만큼 인스턴싱.
//   거리(m) → z 매핑, 히트 리액션, 처치 붕괴를 담당한다.
// ============================================================================
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { makeViewRng, viewSeedOf, type ViewRng } from './postShader'

const MAX_BODIES = 5
const HALF_PI = Math.PI / 2

/** 거리(m) → 카메라 전방 z. 30m 은 멀리, 0m 은 코앞 */
export function distanceToZ(meters: number): number {
  return -(Math.max(0, meters) * 0.55 + 1.2)
}

function cap(r: number, len: number, x: number, y: number, z: number, rx = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(r, len, 3, 7)
  if (rx) g.rotateX(rx)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

function bx(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx) g.rotateX(rx)
  g.translate(x, y, z)
  return g
}

interface ArchParams {
  scale: number
  wide: number
  freq: number
  lean: number
  crawl: number
  spread: number
}

function archParams(id: string): ArchParams {
  switch (id) {
    case 'runner':
      return { scale: 0.98, wide: 0.86, freq: 4.0, lean: 0.30, crawl: 0, spread: 0.5 }
    case 'bloat':
      return { scale: 1.18, wide: 1.42, freq: 0.95, lean: 0.02, crawl: 0, spread: 0.4 }
    case 'horde':
      return { scale: 0.95, wide: 0.96, freq: 1.9, lean: 0.14, crawl: 0, spread: 1.05 }
    case 'crawler':
      return { scale: 0.88, wide: 1.0, freq: 2.6, lean: 0.0, crawl: 1.12, spread: 0.5 }
    default:
      return { scale: 1.0, wide: 1.0, freq: 1.6, lean: 0.11, crawl: 0, spread: 0.55 }
  }
}

interface Body {
  ox: number
  oz: number
  phase: number
  freqMul: number
  scale: number
  yaw: number
  shake: number
}

export class EnemyRig {
  /** 씬 루트에 붙는 노드 */
  readonly object = new THREE.Group()

  private readonly bodyMesh: THREE.InstancedMesh
  private readonly armMesh: THREE.InstancedMesh
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
    // --- 몸통 (다리·골반·흉곽·어깨·머리) ---
    const bodyGeo = mergeGeometries([
      cap(0.075, 0.40, -0.10, 0.32, 0),
      cap(0.075, 0.40, 0.10, 0.32, 0),
      bx(0.11, 0.08, 0.20, -0.10, 0.05, 0.03),
      bx(0.11, 0.08, 0.20, 0.10, 0.05, 0.03),
      bx(0.30, 0.20, 0.20, 0, 0.68, 0),
      cap(0.19, 0.34, 0, 1.02, -0.01),
      bx(0.34, 0.24, 0.21, 0, 1.14, 0.005),
      bx(0.45, 0.13, 0.17, 0, 1.35, 0),
      cap(0.05, 0.06, 0, 1.43, -0.01),
      cap(0.105, 0.07, 0, 1.545, -0.015, 0.16),
      bx(0.10, 0.055, 0.09, 0, 1.487, 0.072),
    ])!
    // --- 팔 (어깨 피벗 기준. 앞으로 뻗은 좀비 자세) ---
    const armGeo = mergeGeometries([
      cap(0.058, 0.22, -0.245, -0.09, 0.06, 0.55),
      cap(0.058, 0.22, 0.245, -0.09, 0.06, 0.55),
      cap(0.052, 0.24, -0.262, -0.28, 0.24, 1.15),
      cap(0.052, 0.24, 0.262, -0.28, 0.24, 1.15),
      bx(0.085, 0.06, 0.12, -0.268, -0.375, 0.40),
      bx(0.085, 0.06, 0.12, 0.268, -0.375, 0.40),
    ])!

    this.mat = new THREE.MeshStandardMaterial({
      color: 0x6c7160,
      roughness: 0.96,
      metalness: 0.02,
      emissive: new THREE.Color(0x1a2018),
      emissiveIntensity: 0.05,
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
    this.armMesh = new THREE.InstancedMesh(armGeo, this.mat, MAX_BODIES)
    const eyeGeo = new THREE.PlaneGeometry(0.155, 0.042)
    this.eyeMesh = new THREE.InstancedMesh(eyeGeo, this.eyeMat, MAX_BODIES)
    for (const m of [this.bodyMesh, this.armMesh, this.eyeMesh]) {
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
      this.bodies.push({
        ox: solo ? this.rng.range(-0.12, 0.12) : this.rng.range(-1, 1) * this.params.spread,
        oz: solo ? 0 : -this.rng.range(0, 2.4),
        phase: this.rng.range(0, Math.PI * 2),
        freqMul: this.rng.range(0.88, 1.14),
        scale: this.params.scale * this.rng.range(0.94, 1.06),
        yaw: this.rng.range(-0.16, 0.16),
        shake: 0,
      })
    }
    this.bodyMesh.count = this.count
    this.armMesh.count = this.count
    this.eyeMesh.count = this.count
    this.dead = false
    this.dieT = -1
    this.hitT = -1
    this.mat.emissiveIntensity = 0.05
    this.eyeMat.opacity = 0.95
    for (const m of [this.bodyMesh, this.armMesh, this.eyeMesh]) m.visible = true
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

  /** 피격: 백색 emissive 2프레임 후 감쇠 (§2.2 t=120) */
  hitFlash(): void {
    this.hitT = 0
  }

  /** 히트 리액션: −0.06m 후퇴 후 복귀 */
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

  /** 흉부 월드 좌표 (트레이서 끝점). 무리면 가장 앞선 개체를 겨눈다 */
  get targetWorld(): THREE.Vector3 {
    let b = this.bodies[0]
    for (const o of this.bodies) if (b && o.oz > b.oz) b = o
    const s = b ? b.scale : 1
    this._tw.set(
      (b ? b.ox : 0),
      1.15 * s * (this.params.crawl > 0 ? 0.45 : 1),
      this.z + (b ? b.oz : 0),
    )
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
        for (const m of [this.bodyMesh, this.armMesh, this.eyeMesh]) m.visible = false
        this.dieT = -1
      }
    }

    // 머티리얼: 기본 림 + 피격 백색 + 사망 적색.
    //
    // 림은 "멀리서도 실루엣이 읽히게"가 아니라 **거리를 읽게** 하는 정보 채널이다.
    // 이 게임에서 거리는 목숨이자 남은 행동 수이므로, 적이 어디쯤 있는지가
    // 손전등 원뿔 밖에서도 항상 보여야 한다. 실기 캡처에서 30m 의 적이
    // 거의 보이지 않아 위협이 전혀 읽히지 않았다 → 먼 거리일수록 림을 크게 준다.
    // (가까울수록 손전등이 직접 비추므로 림은 줄여도 된다.)
    const rim = 0.10 + 0.62 * (1 - this.nearness)
    if (dieP > 0) {
      const burst = Math.max(0, 1 - dieP / 0.22)
      this.mat.emissive.setRGB(1, 0.12 * burst + 0.02, 0.06 * burst)
      this.mat.emissiveIntensity = rim + burst * 2.6
      this.eyeMat.opacity = 0.95 * (1 - dieP)
    } else if (flash > 0) {
      this.mat.emissive.setRGB(1, 1, 1)
      this.mat.emissiveIntensity = rim + flash * 1.8
    } else {
      // 먼 거리에서는 손전등이 닿지 않으므로 emissive 만으로 실루엣을 세운다.
      // 색이 거의 검정(0.10)이면 intensity 를 올려도 결과가 어둡다 → 색 자체를 멀수록 밝게.
      const far = 1 - this.nearness
      this.mat.emissive.setRGB(0.10 + 0.30 * far, 0.125 + 0.34 * far, 0.095 + 0.26 * far)
      this.mat.emissiveIntensity = rim
    }

    for (const b of this.bodies) {
      if (b.shake > 0) b.shake = Math.max(0, b.shake - d / 0.14)
    }

    this.writeMatrices(dieP)
  }

  private writeMatrices(dieP = 0): void {
    const P = this.params
    for (let i = 0; i < this.count; i++) {
      const b = this.bodies[i]!
      const w = this.t * P.freq * b.freqMul * Math.PI
      // 보행 사인파: 상하 / 좌우 / 롤
      const bob = Math.sin(w * 2 + b.phase) * 0.038
      const swayX = Math.sin(w + b.phase) * 0.045
      const roll = Math.sin(w + b.phase) * 0.055
      const back = b.shake * -0.06
      const sink = dieP > 0 ? -1.05 * dieP * dieP : 0
      const fall = dieP > 0 ? dieP * 1.25 : 0
      const puff = dieP > 0 ? 1 + Math.max(0, 1 - dieP / 0.2) * 0.07 : 1

      const s = b.scale * puff
      this._p.set(b.ox + swayX, bob + sink, this.z + b.oz + back)
      this._e.set(P.lean + P.crawl + fall, b.yaw, roll)
      this._q.setFromEuler(this._e)
      this._s.set(s * P.wide, s * (1 - dieP * 0.25), s)
      this._m.compose(this._p, this._q, this._s)
      this.bodyMesh.setMatrixAt(i, this._m)

      // 팔: 어깨 피벗에서 앞뒤로 흔들린다
      const swing = Math.sin(w + b.phase + 0.6) * 0.20 - 0.10
      this._p.set(
        b.ox + swayX,
        (1.35 * s) + bob + sink,
        this.z + b.oz + back,
      )
      this._e.set(P.lean + P.crawl + fall + swing, b.yaw, roll)
      this._q.setFromEuler(this._e)
      this._m.compose(this._p, this._q, this._s)
      this.armMesh.setMatrixAt(i, this._m)

      // 안광: 항상 카메라(+Z) 를 향한다
      this._p.set(
        b.ox + swayX,
        (1.545 * s) + bob + sink - fall * 0.35,
        this.z + b.oz + back + 0.11 * s,
      )
      this._e.set(0, b.yaw, roll * 0.5)
      this._q.setFromEuler(this._e)
      this._s.set(s, s, s)
      this._m.compose(this._p, this._q, this._s)
      this.eyeMesh.setMatrixAt(i, this._m)
    }
    this.bodyMesh.instanceMatrix.needsUpdate = true
    this.armMesh.instanceMatrix.needsUpdate = true
    this.eyeMesh.instanceMatrix.needsUpdate = true
  }

  setVisible(v: boolean): void {
    this.object.visible = v
  }

  dispose(): void {
    this.bodyMesh.geometry.dispose()
    this.armMesh.geometry.dispose()
    this.eyeMesh.geometry.dispose()
    this.bodyMesh.dispose()
    this.armMesh.dispose()
    this.eyeMesh.dispose()
    this.mat.dispose()
    this.eyeMat.dispose()
    this.object.removeFromParent()
  }
}

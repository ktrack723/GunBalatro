// ============================================================================
// GunRig.ts — 볼터 라이플. 지오메트리는 전부 코드 생성(에셋 파일 0).
//   PRESENTATION.md §3 온도 5단계 램프 / §2.1 장전 / §2.2 반동 / §2.3 노리쇠 후퇴.
//   카메라의 자식으로 붙는다(화면 고정). 머티리얼 3장으로 병합해 드로우콜을 줄인다.
// ============================================================================
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Fx } from './Fx'
import { makeViewRng, type ViewRng } from './postShader'

// --- 온도 단계표 (PRESENTATION.md §3 과 1:1) ---------------------------------
interface HeatStage {
  min: number
  name: string
  color: number
  emis: number
}
export const HEAT_STAGES: readonly HeatStage[] = [
  { min: 1.0, name: 'COLD', color: 0x6b6f74, emis: 0.0 },
  { min: 3.0, name: 'WARM', color: 0x7a2c10, emis: 0.25 },
  { min: 8.0, name: 'HOT', color: 0xff6a12, emis: 0.85 },
  { min: 16.0, name: 'SEARING', color: 0xffc44d, emis: 1.6 },
  { min: 30.0, name: 'SANCTIFIED', color: 0xfff6e0, emis: 2.6 },
]

export function heatStageIndex(heat: number): number {
  let i = 0
  for (let k = 0; k < HEAT_STAGES.length; k++) {
    if (heat >= HEAT_STAGES[k]!.min) i = k
  }
  return i
}

// --- 지오메트리 헬퍼 ---------------------------------------------------------
function box(
  w: number, h: number, d: number,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  if (rx || ry || rz) g.rotateX(rx), g.rotateY(ry), g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

function cyl(
  rt: number, rb: number, h: number, seg: number,
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false)
  if (rx || ry || rz) g.rotateX(rx), g.rotateY(ry), g.rotateZ(rz)
  g.translate(x, y, z)
  return g
}

const HALF_PI = Math.PI / 2

export class GunRig {
  /** 카메라에 붙일 최상위 노드. 위치는 GameScene.resize() 가 잡아준다 */
  readonly object = new THREE.Group()
  /** 사운드 훅 (현재는 no-op. 오디오 레이어가 나중에 연결) */
  onSound: (id: string) => void = () => {}

  private readonly fx: Fx
  private readonly rng: ViewRng = makeViewRng(0x9017)
  private readonly sway = new THREE.Group()
  private readonly recoilNode = new THREE.Group()
  private readonly parts = new THREE.Group()

  private readonly steelMat: THREE.MeshStandardMaterial
  private readonly heatMat: THREE.MeshStandardMaterial
  private readonly brassMat: THREE.MeshStandardMaterial
  private readonly dotMat: THREE.MeshBasicMaterial
  private readonly glowMat: THREE.MeshBasicMaterial

  private readonly meshes: THREE.Mesh[] = []
  private readonly magMesh: THREE.Mesh
  private readonly boltMesh: THREE.Mesh
  private readonly glowMesh: THREE.Mesh
  private readonly muzzleObj = new THREE.Object3D()
  private readonly _mw = new THREE.Vector3()
  private readonly _sp = new THREE.Vector3()

  // 상태
  private heat = 1
  private heatShown = 1
  private stage = 0
  private stagePulse = 0
  private lowered = false
  private t = 0
  private sparkAcc = 0
  private jittering = false

  // 반동 스프링
  private kickX = 0
  private kickVX = 0
  private kickZ = 0
  private kickVZ = 0

  // 노리쇠 / 장전
  private boltZ = 0
  private boltTarget = 0
  private boltLocked = false
  private reloadT = -1

  private readonly baseColor = new THREE.Color()
  private readonly emisColor = new THREE.Color()
  private readonly cA = new THREE.Color()
  private readonly cB = new THREE.Color()

  constructor(fx: Fx) {
    this.fx = fx

    this.steelMat = new THREE.MeshStandardMaterial({
      color: 0x2c3036, roughness: 0.62, metalness: 0.55,
      emissive: 0x000000, emissiveIntensity: 1,
    })
    this.heatMat = new THREE.MeshStandardMaterial({
      color: 0x6b6f74, roughness: 0.5, metalness: 0.6,
      emissive: 0x000000, emissiveIntensity: 0,
    })
    this.brassMat = new THREE.MeshStandardMaterial({
      color: 0xc8a44d, roughness: 0.42, metalness: 0.82,
    })
    this.dotMat = new THREE.MeshBasicMaterial({
      color: 0xff3a30, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xff9a3c, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })

    // --- 강철부 (수신부·개머리·손잡이·광학) ---
    const steel: THREE.BufferGeometry[] = [
      box(0.088, 0.105, 0.36, 0, -0.062, -0.19),
      box(0.052, 0.020, 0.30, 0, -0.002, -0.20),
      box(0.076, 0.118, 0.20, 0, -0.092, 0.10),
      box(0.056, 0.036, 0.15, 0, -0.024, 0.065),
      box(0.048, 0.140, 0.064, 0, -0.162, -0.028, 0.30),
      box(0.030, 0.014, 0.078, 0, -0.130, -0.098),
      box(0.054, 0.052, 0.115, 0, 0.030, -0.118),
      box(0.060, 0.013, 0.032, 0, 0.052, -0.172),
      box(0.013, 0.046, 0.013, 0, 0.022, -0.600),
      box(0.030, 0.030, 0.055, 0, -0.070, 0.010),
    ]
    // --- 총열부 (온도 램프 대상) ---
    const hot: THREE.BufferGeometry[] = [
      cyl(0.021, 0.021, 0.47, 10, 0, -0.028, -0.535, HALF_PI),
      box(0.074, 0.074, 0.24, 0, -0.028, -0.400),
      cyl(0.036, 0.031, 0.078, 10, 0, -0.028, -0.788, HALF_PI),
      box(0.058, 0.010, 0.030, 0, 0.006, -0.795),
      box(0.010, 0.058, 0.030, 0, -0.028, -0.795),
    ]
    for (let i = 0; i < 5; i++) {
      hot.push(box(0.078, 0.010, 0.016, 0, 0.010, -0.32 - i * 0.036))
    }
    // --- 황동 장식 (제국식 각인) ---
    const brass: THREE.BufferGeometry[] = [
      box(0.092, 0.014, 0.020, 0, -0.020, -0.040),
      box(0.020, 0.052, 0.010, 0, -0.062, -0.372),
      box(0.058, 0.010, 0.010, 0, -0.030, 0.170),
      box(0.012, 0.012, 0.012, 0, -0.010, -0.300, 0, 0, Math.PI / 4),
    ]

    this.addMerged(steel, this.steelMat)
    this.addMerged(hot, this.heatMat)
    this.addMerged(brass, this.brassMat)

    // --- 애니메이션 파트 ---
    const magGeo = mergeGeometries([
      box(0.068, 0.170, 0.100, 0, -0.190, -0.178, 0.10),
      box(0.074, 0.014, 0.106, 0, -0.272, -0.170, 0.10),
    ])!
    this.magMesh = new THREE.Mesh(magGeo, this.steelMat)
    this.parts.add(this.magMesh)

    const boltGeo = mergeGeometries([
      box(0.028, 0.028, 0.088, 0.058, -0.030, -0.270),
      box(0.020, 0.020, 0.030, 0.076, -0.030, -0.240),
    ])!
    this.boltMesh = new THREE.Mesh(boltGeo, this.steelMat)
    this.parts.add(this.boltMesh)

    // 조준점 (광학 내부)
    const dot = new THREE.Mesh(new THREE.PlaneGeometry(0.013, 0.013), this.dotMat)
    dot.position.set(0, 0.030, -0.176)
    this.parts.add(dot)

    // 백열 이상에서 켜지는 볼륨 글로우 (광원 아님 — additive 평면)
    this.glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.22), this.glowMat)
    this.glowMesh.position.set(0, -0.028, -0.50)
    this.glowMesh.renderOrder = 12
    this.parts.add(this.glowMesh)

    this.muzzleObj.position.set(0, -0.028, -0.840)
    this.parts.add(this.muzzleObj)

    this.recoilNode.add(this.parts)
    this.sway.add(this.recoilNode)
    this.object.add(this.sway)
    // 자연스러운 파지 각도
    this.parts.rotation.set(-0.018, 0.030, 0.048)
    this.applyHeatMaterial(1, 0)
  }

  private addMerged(list: THREE.BufferGeometry[], mat: THREE.Material): void {
    const merged = mergeGeometries(list)
    for (const g of list) g.dispose()
    if (!merged) return
    const m = new THREE.Mesh(merged, mat)
    m.frustumCulled = false
    this.meshes.push(m)
    this.parts.add(m)
  }

  // -------------------------------------------------------------------------
  // 배치 (GameScene.resize 가 화면 비율에 맞춰 호출)
  // -------------------------------------------------------------------------
  layout(x: number, y: number, z: number): void {
    this.object.position.set(x, y, z)
  }

  /** 이동 구간에서는 총을 내린다 */
  setLowered(v: boolean): void {
    this.lowered = v
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  /** PRESENTATION §3 온도 5단계 램프 */
  setHeat(heat: number): void {
    const h = Math.max(1, heat)
    const next = heatStageIndex(h)
    if (next !== this.stage) {
      // 단계 경계 통과 — 총이 한 번 크게 번쩍한다
      this.stagePulse = 1
      this.fx.screenFlash(next > this.stage ? 0.10 + next * 0.03 : 0.05, 240)
      this.onSound('heat.stage.' + HEAT_STAGES[next]!.name)
      this.stage = next
    }
    this.heat = h
  }

  /** 전투 시작 등에서 온도를 즉시 리셋 (램프 보간 없이) */
  resetHeat(heat: number): void {
    const h = Math.max(1, heat)
    this.heat = h
    this.heatShown = h
    this.stage = heatStageIndex(h)
    this.stagePulse = 0
    this.applyHeatMaterial(h, 0)
  }

  /** 반동. strength 는 대략 0.6(약) ~ 1.6(강) */
  kick(strength: number): void {
    const s = THREE.MathUtils.clamp(strength, 0, 2.5)
    this.kickVX += 6.2 * s
    this.kickVZ += 2.4 * s
  }

  /** 노리쇠 후퇴 고정 (탄창 종료, §2.3 t=0) */
  boltBack(): void {
    this.boltLocked = true
    this.boltTarget = 0.078
    this.onSound('bolt.back')
    this.fx.smoke(this.muzzleWorld)
  }

  /** 장전 (§2.1 700ms 타임라인) */
  reloadAnim(): void {
    this.reloadT = 0
    this.boltLocked = true
    this.boltTarget = 0.078
    this.onSound('reload.start')
  }

  /** 총구 월드 좌표 (트레이서 시작점) */
  get muzzleWorld(): THREE.Vector3 {
    this.muzzleObj.updateWorldMatrix(true, false)
    return this._mw.setFromMatrixPosition(this.muzzleObj.matrixWorld)
  }

  get heatStage(): number {
    return this.stage
  }

  // -------------------------------------------------------------------------
  update(dt: number): void {
    const d = Math.min(dt, 0.05)
    this.t += d

    this.updateReload(d)

    // --- 반동 스프링 (임계 감쇠에 가깝게) ---
    const k = 460, c = 27
    this.kickVX += (-k * this.kickX - c * this.kickVX) * d
    this.kickX += this.kickVX * d
    this.kickVZ += (-k * this.kickZ - c * this.kickVZ) * d
    this.kickZ += this.kickVZ * d
    this.recoilNode.rotation.x = this.kickX * 0.055
    this.recoilNode.position.z = this.kickZ * 0.020
    this.recoilNode.position.y = -this.kickX * 0.004

    // --- 노리쇠 ---
    this.boltZ += (this.boltTarget - this.boltZ) * Math.min(1, d * 22)
    this.boltMesh.position.z = this.boltZ

    // --- 온도 램프 ---
    this.heatShown += (this.heat - this.heatShown) * Math.min(1, d * 6)
    this.stagePulse *= Math.exp(-d / 0.13)
    this.applyHeatMaterial(this.heatShown, this.stagePulse)
    // 적열(8) 이상에서 화면 가장자리 아지랑이 (§2.2 t=250). 시퀀서가 덮어써도 무방
    this.fx.heatDistortion(THREE.MathUtils.clamp((this.heatShown - 8) / 22, 0, 1))

    // --- 자세 (전투 / 이동) ---
    const targetRx = this.lowered ? 0.55 : 0
    const targetY = this.lowered ? -0.16 : 0
    this.sway.rotation.x += (targetRx - this.sway.rotation.x) * Math.min(1, d * 5)
    this.sway.position.y += (targetY - this.sway.position.y) * Math.min(1, d * 5)

    // --- 호흡 / 보행 스웨이 ---
    const bf = this.lowered ? 2.1 : 0.62
    const amp = this.lowered ? 1 : 0.4
    this.sway.position.x = Math.sin(this.t * bf * Math.PI) * 0.006 * amp
    this.sway.rotation.z = Math.sin(this.t * bf * Math.PI * 0.5) * 0.012 * amp

    // --- 16 이상: 미세 떨림 / 30 이상: 스파크 ---
    const hs = this.heatShown
    if (hs >= 16) {
      const j = THREE.MathUtils.clamp((hs - 16) / 14, 0, 1) * 0.005 + 0.0012
      this.parts.position.x = Math.sin(this.t * 71) * j
      this.parts.position.y = Math.sin(this.t * 83 + 1.7) * j
      this.parts.rotation.z = 0.048 + Math.sin(this.t * 63) * j * 1.4
      this.jittering = true
    } else if (this.jittering) {
      this.jittering = false
      this.parts.position.set(0, 0, 0)
      this.parts.rotation.z = 0.048
    }
    if (hs >= 30) {
      this.sparkAcc += d
      const period = 1 / (8 + Math.min(20, (hs - 30) * 0.8))
      while (this.sparkAcc > period) {
        this.sparkAcc -= period
        const p = this._sp.copy(this.muzzleWorld)
        p.x += this.rng.range(-0.05, 0.05)
        p.y += this.rng.range(-0.02, 0.06)
        p.z += this.rng.range(0, 0.28)
        this.fx.spark(p, 0xffd08a)
      }
    } else {
      this.sparkAcc = 0
    }
  }

  private updateReload(d: number): void {
    if (this.reloadT < 0) {
      this.magMesh.position.y = 0
      return
    }
    const t = (this.reloadT += d) * 1000
    if (t < 300) {
      // 탄창 삽입 (아래에서 올라온다)
      const p = THREE.MathUtils.clamp(t / 300, 0, 1)
      this.magMesh.position.y = -0.20 * (1 - p * p)
    } else if (t < 420) {
      this.magMesh.position.y = 0
      if (this.boltTarget !== 0.078) this.boltTarget = 0.078
      // 삽입 충격
      const p = (t - 300) / 120
      this.recoilNode.position.y = -0.012 * Math.sin(p * Math.PI)
    } else {
      this.magMesh.position.y = 0
      if (this.boltLocked) {
        this.boltLocked = false
        this.boltTarget = 0
        this.onSound('bolt.forward')
        this.kick(0.35)
      }
      if (t >= 700) this.reloadT = -1
    }
  }

  private applyHeatMaterial(heat: number, pulse: number): void {
    const i = heatStageIndex(heat)
    const a = HEAT_STAGES[i]!
    const b = HEAT_STAGES[Math.min(i + 1, HEAT_STAGES.length - 1)]!
    const span = b.min > a.min ? b.min - a.min : 20
    // 단계 안에서는 천천히 시작해 경계 직전에 다음 단계로 붙는다.
    // (표의 단계값이 뭉개지지 않으면서 연속적으로 보이게 하는 절충)
    const raw = THREE.MathUtils.clamp((heat - a.min) / span, 0, 1)
    const t = raw * raw
    this.cA.setHex(a.color)
    this.cB.setHex(b.color)
    this.baseColor.copy(this.cA).lerp(this.cB, t)
    const emis = a.emis + (b.emis - a.emis) * t

    this.heatMat.color.copy(this.baseColor)
    this.emisColor.copy(this.baseColor)
    this.heatMat.emissive.copy(this.emisColor)
    this.heatMat.emissiveIntensity = emis * (1 + pulse * 1.6) + pulse * 0.5

    // 성화 단계: 총 전체가 발광
    const fullGlow = THREE.MathUtils.clamp((heat - 26) / 12, 0, 1)
    this.steelMat.emissive.copy(this.emisColor)
    this.steelMat.emissiveIntensity = fullGlow * 0.55 + pulse * 0.25

    // 볼륨 글로우 (백열 이상)
    const g = THREE.MathUtils.clamp((heat - 13) / 10, 0, 1)
    this.glowMat.opacity = g * 0.34 + pulse * 0.12
    this.glowMat.color.copy(this.baseColor)
    this.glowMesh.visible = this.glowMat.opacity > 0.004
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose()
    this.magMesh.geometry.dispose()
    this.boltMesh.geometry.dispose()
    this.glowMesh.geometry.dispose()
    this.steelMat.dispose()
    this.heatMat.dispose()
    this.brassMat.dispose()
    this.dotMat.dispose()
    this.glowMat.dispose()
    this.object.removeFromParent()
  }
}

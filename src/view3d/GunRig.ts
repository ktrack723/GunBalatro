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
/**
 * emis 값은 **형태가 읽히는 선까지만** 올린다.
 * 예전 값(1.6 / 2.6)은 뷰모델 조명과 겹쳐 톤매핑에서 포화돼, 백열 이상에서
 * 총이 음영 없는 노란 덩어리로 뭉개졌다. 온도 정보는 색이 나르게 하고
 * 발광은 실루엣을 지우지 않을 만큼만 준다.
 */
export const HEAT_STAGES: readonly HeatStage[] = [
  { min: 1.0, name: 'COLD', color: 0x6b6f74, emis: 0.0 },
  { min: 3.0, name: 'WARM', color: 0x7a2c10, emis: 0.20 },
  { min: 8.0, name: 'HOT', color: 0xff6a12, emis: 0.58 },
  { min: 16.0, name: 'SEARING', color: 0xffc44d, emis: 0.98 },
  { min: 30.0, name: 'SANCTIFIED', color: 0xfff6e0, emis: 1.55 },
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

/**
 * 탄창 기준점은 **급탄구(feed lips)** 다 — 총에 물리는 그 지점.
 * 용량에 따라 탄창 길이가 달라지므로, 중심이 아니라 위쪽 끝을 고정해야
 * 어떤 용량이든 수신부 아래에 정확히 물린다.
 */
const MAG_HOME = new THREE.Vector3(0, -0.105, -0.178)
/**
 * 탄창 '제시' 자세 — 총 **왼쪽 옆**으로 빼낸다.
 * 탄창은 총 아래에 있어서, 카메라가 뒤에서 보는 구도에서는 몸체에 가린다.
 * 옆으로 빼야 삽탄이 실제로 보인다.
 */
const MAG_PRESENT = new THREE.Vector3(-0.165, -0.020, -0.255)
const ROUND_GEO = new THREE.CylinderGeometry(0.0115, 0.0115, 0.052, 8, 1, false)
ROUND_GEO.rotateX(Math.PI / 2)

/** 탄창 앞뒤 경사 (실총의 레이크). 급탄구 기준으로 기울인다 */
const MAG_RAKE = 0.10

/**
 * 용량 → 탄창 형상.
 * 탄창은 이 게임에서 **규칙 변경자**다 — 용량이 곧 한 탄창 안의 곱셈 횟수다.
 * 그 규칙이 총을 봤을 때 바로 읽혀야 하므로, 용량마다 실루엣을 바꾼다:
 *   1~2발 = 짧고 뭉툭한 블록 / 3~7발 = 스틱 / 8발 이상 = 드럼.
 */
function magShape(cap: number): { h: number; drum: boolean; stubby: boolean } {
  const c = Math.max(1, Math.min(12, Math.round(cap)))
  return {
    h: Math.max(0.070, Math.min(0.300, 0.050 + c * 0.028)),
    drum: c >= 8,
    stubby: c <= 2,
  }
}

/**
 * 탄창 지오메트리. y=0 이 급탄구, 아래로 h 만큼 내려간다.
 * **앞면이 열린 채널**이다 — 막힌 상자로 만들면 안에 든 탄이 보이지 않아
 * 삽탄 연출이 통째로 헛돈다. 양 옆판 + 뒷판 + 바닥 + 밑판으로 만든다.
 */
function buildMagGeometry(cap: number): THREE.BufferGeometry {
  const { h, drum, stubby } = magShape(cap)
  const w = 0.068 // 내폭
  const t = 0.009 // 판 두께
  const parts: THREE.BufferGeometry[] = [
    box(t, h, 0.100, -(w + t) / 2, -h / 2, 0),            // 좌측판
    box(t, h, 0.100, (w + t) / 2, -h / 2, 0),             // 우측판
    box(w + t, h, 0.010, 0, -h / 2, -0.045),              // 뒷판
    box(w + t, 0.013, 0.100, 0, -h + 0.0065, 0),          // 바닥 (팔로워)
    box(w + t + 0.006, 0.014, 0.106, 0, -h - 0.008, 0.008), // 밑판
  ]
  if (drum) {
    // 드럼 — 옆으로 튀어나온 원반. 8발 이상은 실루엣부터 다르다.
    //   **채널 뒤쪽**에 붙인다 — 앞에 두면 삽탄된 탄을 가려서 FILO 연출이 안 보인다.
    parts.push(cyl(0.084, 0.084, 0.050, 12, 0, -h * 0.74, -0.050, 0, 0, HALF_PI))
    parts.push(cyl(0.032, 0.032, 0.058, 8, 0, -h * 0.74, -0.050, 0, 0, HALF_PI))
    parts.push(box(0.020, h * 0.45, 0.020, 0, -h * 0.36, -0.048))
  }
  if (stubby) {
    // 1~2발 — 짧은 대신 두꺼운 블록. "이건 한두 발짜리다"가 바로 읽힌다.
    parts.push(box(w + 0.034, 0.022, 0.118, 0, -h * 0.55, 0))
    parts.push(box(0.016, 0.030, 0.016, 0, -h - 0.020, 0.030))
  }
  const merged = mergeGeometries(parts)!
  for (const g of parts) g.dispose()
  return merged
}

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
  /** 분리/결합 애니메이션을 받는 노드 (급탄구가 원점) */
  private readonly magRig = new THREE.Group()
  /** 정적 레이크를 담는 안쪽 노드 — 탄창 본체와 탄이 모두 여기 들어간다 */
  private readonly magTilt = new THREE.Group()
  private magMesh: THREE.Mesh
  private magCap = 5
  private magH = magShape(5).h
  /** 재장전 중 탄창에 들어가는 실제 탄 메시들 */
  private readonly roundMeshes: THREE.Mesh[] = []
  private readonly roundHome: THREE.Vector3[] = []
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
  /** 재장전 연출이 직접 구동할 때 true — 자동 보간을 끈다 */
  private boltDriven = false
  private posePresent = 0
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
    // 탄창은 **분리되는 부품**이다. 재장전 연출에서 총에서 빼내 카메라 앞으로
    // 가져오고, 탄을 넣고, 다시 물린다. 그래서 자기 피벗을 가진 그룹으로 만든다.
    // (지오메트리를 원점 기준으로 만들고 그룹을 제자리에 놓는다)
    this.magMesh = new THREE.Mesh(buildMagGeometry(5), this.steelMat)
    this.magTilt.rotation.x = MAG_RAKE
    this.magTilt.add(this.magMesh)
    this.magRig.position.copy(MAG_HOME)
    this.magRig.add(this.magTilt)
    this.parts.add(this.magRig)

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
      // 단계 경계 통과 — **총 자체가** 한 번 크게 달아오른다.
      // 예전에는 화면 전체를 흰색 오버레이로 덮었는데, 그건 조명이 아니라 눈속임이라
      // 어디서 무슨 일이 났는지 알려주지 않는다. 발광은 총에서 난다.
      this.stagePulse = 1
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

  /** 구버전 호환 — 3D 재장전은 beginReload/setMagPresent/... 를 쓴다 */
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
    if (!this.boltDriven) {
      this.boltZ += (this.boltTarget - this.boltZ) * Math.min(1, d * 22)
      this.boltMesh.position.z = this.boltZ
    }

    // --- 온도 램프 ---
    this.heatShown += (this.heat - this.heatShown) * Math.min(1, d * 6)
    this.stagePulse *= Math.exp(-d / 0.13)
    this.applyHeatMaterial(this.heatShown, this.stagePulse)
    // 아지랑이. 시작점을 8 → 12 로, 폭을 22 → 30 으로 늘렸다.
    //   적이 검은색이 된 뒤로는 화면 흐림이 곧 "적이 안 보임" 이다. 중간 온도(17 근처)
    //   에서 0.41 이나 걸려 복도와 적이 통째로 뿌옇게 지워지고 있었다.
    //   극단적인 온도에서만 강하게 걸리도록 곡선을 뒤로 밀었다.
    this.fx.heatDistortion(THREE.MathUtils.clamp((this.heatShown - 12) / 30, 0, 1))

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
    // v2: 재장전은 시퀀서가 정규화 진행도로 직접 구동한다 (updateReload 는 유휴 복귀만).
    if (this.reloadT < 0) return
    this.reloadT += d
    if (this.reloadT > 2.4) this.reloadT = -1
  }

  // =========================================================================
  // 3D 재장전 — 벅샷 룰렛처럼 전부 3D 로 보여준다
  //   ① 탄창을 총에서 빼 카메라 앞으로  ② 탄을 하나씩 밀어 넣고(FILO)
  //   ③ 탄창을 다시 물리고             ④ 장전손잡이를 당겼다 놓는다
  // =========================================================================

  /**
   * 탄창 용량이 바뀌면 모델을 갈아 끼운다.
   * 용량은 이 게임의 규칙 변경자이므로 총만 봐도 몇 발짜리인지 읽혀야 한다.
   */
  setMagazineCap(cap: number): void {
    const c = Math.max(1, Math.min(12, Math.round(cap) || 1))
    if (c === this.magCap) return
    this.magCap = c
    this.magH = magShape(c).h
    const old = this.magMesh
    this.magTilt.remove(old)
    old.geometry.dispose()
    this.magMesh = new THREE.Mesh(buildMagGeometry(c), this.steelMat)
    this.magTilt.add(this.magMesh)
  }

  /** 재장전 시작 — 넣을 탄의 색을 순서대로 받는다 (index 0 = 가장 먼저 발사될 탄) */
  beginReload(colors: readonly number[]): void {
    this.clearRounds()
    this.reloadT = 0
    this.boltDriven = true
    this.boltLocked = true
    this.onSound('reload.start')

    const n = Math.max(1, colors.length)
    // 탄창 안 적재 위치: 아래부터 쌓인다. 마지막에 넣은 탄(=발사 순서 0)이 맨 위.
    // 위치는 **현재 탄창 모델의 안쪽 높이**에서 뽑는다 — 2발짜리에 5발이 겹쳐
    // 튀어나오면 용량을 실루엣으로 읽게 만든 의미가 없어진다.
    const inner = Math.max(0.03, this.magH - 0.030)
    const top = -0.020
    const gap = Math.min(0.026, inner / n)
    for (let i = 0; i < colors.length; i += 1) {
      const mat = new THREE.MeshStandardMaterial({
        color: colors[i],
        roughness: 0.42,
        metalness: 0.75,
        emissive: new THREE.Color(colors[i]).multiplyScalar(0.18),
      })
      const m = new THREE.Mesh(ROUND_GEO, mat)
      m.layers.set(1)
      m.visible = false
      this.magTilt.add(m)
      this.roundMeshes.push(m)
      this.roundHome.push(new THREE.Vector3(0, top - i * gap, 0.020))
    }
  }

  /** 총을 옆으로 돌려 눕히는 '들여다보기' 자세. 재장전 내내 유지된다 */
  private setGunPose(p: number): void {
    const q = THREE.MathUtils.clamp(p, 0, 1)
    this.posePresent = q
    this.parts.position.y = -0.055 * q
    this.parts.rotation.x = -0.018 + 0.13 * q
    this.parts.rotation.y = 0.38 * q
  }

  /** 탄창 위치. 0 = 총에 물린 상태, 1 = 총 왼쪽으로 빼낸 제시 자세 */
  private setMagOffset(p: number): void {
    const q = THREE.MathUtils.clamp(p, 0, 1)
    this.magRig.position.lerpVectors(MAG_HOME, MAG_PRESENT, q)
    this.magRig.rotation.x = -0.55 * q
    this.magRig.rotation.z = 0.42 * q
  }

  /** 0 = 총에 물린 상태, 1 = 탄창을 빼 든 제시 자세 (총 자세도 함께 움직인다) */
  setMagPresent(t: number): void {
    this.setGunPose(t)
    this.setMagOffset(t)
  }

  /**
   * i 번째(발사 순서) 탄의 삽탄 진행도.
   * 시퀀서는 **마지막 탄부터** 이 함수를 부른다 — 먼저 넣은 탄이 아래에 깔린다.
   */
  setRoundInsert(i: number, t: number): void {
    const m = this.roundMeshes[i]
    const home = this.roundHome[i]
    if (m === undefined || home === undefined) return
    const p = THREE.MathUtils.clamp(t, 0, 1)
    m.visible = p > 0.001
    // 왼쪽 바깥에서 밀어 넣는다 (탄창이 총 왼쪽에 있으므로)
    const fromX = -0.125
    const fromZ = 0.055
    m.position.set(
      home.x + fromX * (1 - p),
      home.y + 0.035 * (1 - p) * (1 - p),
      home.z + fromZ * (1 - p),
    )
    m.rotation.z = 0.5 * (1 - p)
  }

  /**
   * 1 = 탄창이 완전히 물림.
   * **총 자세는 그대로 둔다** — 이어지는 장전손잡이 동작을 옆에서 봐야 읽힌다.
   */
  setMagSeat(t: number): void {
    const p = THREE.MathUtils.clamp(t, 0, 1)
    this.setMagOffset(1 - p)
    if (p >= 1) {
      this.magRig.position.copy(MAG_HOME)
      this.magRig.rotation.set(0, 0, 0)
      this.recoilNode.position.y = -0.010
      this.onSound('mag.seat')
    }
  }

  /** 0 = 전진, 1 = 완전 후퇴. 시퀀서가 당겼다 놓는다 */
  setChargingHandle(t: number): void {
    const p = THREE.MathUtils.clamp(t, 0, 1)
    this.boltDriven = true
    this.boltZ = 0.078 * p
    this.boltMesh.position.z = this.boltZ
    this.boltTarget = this.boltZ
  }

  /** 재장전 종료 — 탄 메시를 치우고 자동 보간을 되돌린다 */
  endReload(): void {
    this.clearRounds()
    this.setGunPose(0)
    this.boltDriven = false
    this.boltLocked = false
    this.boltTarget = 0
    this.reloadT = -1
    this.magRig.position.copy(MAG_HOME)
    this.magRig.rotation.set(0, 0, 0)
    this.parts.position.y = 0
    this.parts.rotation.x = -0.018
    this.parts.rotation.y = 0
    this.onSound('bolt.forward')
    this.kick(0.3)
  }

  private clearRounds(): void {
    for (const m of this.roundMeshes) {
      this.magTilt.remove(m)
      const mat = m.material
      if (mat instanceof THREE.Material) mat.dispose()
    }
    this.roundMeshes.length = 0
    this.roundHome.length = 0
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
    this.steelMat.emissiveIntensity = fullGlow * 0.38 + pulse * 0.22

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

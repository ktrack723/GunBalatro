// ============================================================================
// Scene.ts — 씬 그래프 / 카메라 / 조명 / 모드 전환
//   DOM UI 가 화면 아래(세로) 또는 오른쪽(가로)을 덮으므로,
//   카메라 절두체를 오프셋해서 "실제로 보이는 띠"의 중앙이 시선축이 되게 만든다.
//   조명은 손전등 SpotLight 1 + 머즐 PointLight 1 + 아주 약한 Ambient. 그림자 0.
// ============================================================================
import * as THREE from 'three'
import { Fx } from './Fx'
import { GunRig } from './GunRig'
import { EnemyRig } from './EnemyRig'
import { CorridorStreamer, type CorridorKind } from './CorridorStreamer'
import { RailCamera } from './RailCamera'

export type ViewMode = 'combat' | 'travel'

/** 안개 색 = 클리어 색. 복도 끝의 '구멍'이 안개와 이어지도록 맞춘다 */
export const FOG_COLOR = 0x06070a

const EYE = 1.62

export class GameScene {
  readonly root = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly fx: Fx
  readonly gun: GunRig
  readonly enemy: EnemyRig
  readonly corridor: CorridorStreamer
  /** 온레일 이동 컨트롤러 (travel 모드에서 카메라를 구동한다) */
  readonly rail: RailCamera
  readonly flashlight: THREE.SpotLight
  readonly ambient: THREE.AmbientLight
  private readonly viewLight: THREE.DirectionalLight

  private mode: ViewMode = 'combat'
  private t = 0
  private w = 1
  private h = 1
  /** DOM UI 가 덮는 비율 (세로=아래, 가로=오른쪽) */
  private coverBottom = 0.45
  private coverRight = 0.4
  /** 총 앵커: "보이는 영역" 기준 정규화 좌표 (-1..1). 캔버스 NDC 가 아니다 */
  private gunU = 0.26
  private gunV = -0.60
  private gunDist = 0.62
  /** 평소 자세 (setGunAnchor 가 정한 값). 재장전 때 여기서 중앙으로 옮겼다 되돌린다 */
  private baseU = 0.26
  private baseV = -0.60
  private baseDist = 0.62
  private inspectT = 0
  private visW = 1
  private visH = 0.55
  private readonly _lt = new THREE.Vector3()

  constructor(renderer: THREE.WebGLRenderer) {
    this.root.background = null
    this.root.fog = new THREE.FogExp2(FOG_COLOR, 0.046)

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 90)
    this.camera.rotation.order = 'YXZ'
    this.camera.position.set(0, EYE, 0.25)
    this.root.add(this.camera)

    // --- 조명 (동적 2개 예산: 손전등 + Fx 머즐) ---
    // 앰비언트는 '어둠이 예산'이라는 원칙을 지키되, 복도 형태가 아예 안 읽히면
    // 이동 구간이 검은 화면이 된다. 실기 캡처 기준으로 최소치를 올렸다.
    this.ambient = new THREE.AmbientLight(0x2b3340, 0.62)
    this.root.add(this.ambient)

    this.flashlight = new THREE.SpotLight(0xffe7c6, 34, 30, THREE.MathUtils.degToRad(38), 0.72, 1.55)
    this.flashlight.castShadow = false
    this.flashlight.position.set(0.06, -0.10, 0)
    this.flashlight.target.position.set(0, -0.02, -6)
    this.camera.add(this.flashlight)
    this.camera.add(this.flashlight.target)

    // --- 리그 ---
    this.fx = new Fx(this.root)
    this.gun = new GunRig(this.fx)
    // 총은 뷰모델 레이어(1)에 둔다. Renderer 가 깊이를 지우고 따로 그려
    // 복도 지오메트리를 뚫고 들어가는 것을 막는다.
    this.gun.object.traverse((o) => o.layers.set(1))

    // 뷰모델(총) 전용 조명.
    //   손전등은 카메라에 붙은 스포트라이트라 감쇠가 있다. 총을 재장전 연출로
    //   카메라 앞까지 끌어오면 거리가 0.5m 밖까지 줄어 **완전히 하얗게 날아간다**.
    //   그래서 월드 조명(layer 0)과 뷰모델 조명(layer 1)을 분리한다.
    //   방향광이라 거리와 무관하게 노출이 일정하다.
    this.viewLight = new THREE.DirectionalLight(0xffe6c8, 3.1)
    this.viewLight.position.set(0.45, 0.9, 0.55)
    this.viewLight.layers.set(1)
    this.viewLight.target.layers.set(1)
    this.camera.add(this.viewLight)
    this.camera.add(this.viewLight.target)
    // 카메라 정면 필 — 총을 뒤에서 볼 때 새까맣게 되지 않게 한다
    const viewFill = new THREE.DirectionalLight(0xbcd0e4, 1.25)
    viewFill.position.set(-0.35, 0.15, 1)
    viewFill.layers.set(1)
    viewFill.target.layers.set(1)
    this.camera.add(viewFill)
    this.camera.add(viewFill.target)

    this.flashlight.layers.set(0)
    this.flashlight.target.layers.set(0)
    this.ambient.layers.enableAll()
    this.camera.add(this.gun.object)

    this.enemy = new EnemyRig()
    this.root.add(this.enemy.object)

    const maxAniso = renderer.capabilities.getMaxAnisotropy()
    this.corridor = new CorridorStreamer(this.root, 1)
    this.corridor.setAnisotropy(Math.min(4, maxAniso))

    this.rail = new RailCamera(1)
    this.setMode('combat')
  }

  // -------------------------------------------------------------------------
  setMode(mode: ViewMode): void {
    this.mode = mode
    if (mode === 'combat') {
      this.enemy.setVisible(true)
      this.gun.setLowered(false)
      this.corridor.hideDoors()
      this.camera.position.set(0, EYE, 0.25)
      this.camera.rotation.set(0, 0, 0)
    } else {
      this.enemy.setVisible(false)
      this.gun.setLowered(true)
    }
  }

  getMode(): ViewMode {
    return this.mode
  }

  /** 이동 구간 시작 — 복도를 새 시드로 조립하고 레일을 태운다 (첫 진입) */
  startTravel(seed: number, kind: CorridorKind, seconds: number, hint: string | null = null): void {
    this.corridor.setHint(hint)
    this.corridor.rebuild(seed, kind)
    this.corridor.setOriginZ(0)
    this.camera.position.set(0, 1.62, 0)
    this.rail.reset(seed)
    this.rail.start(seconds)
    this.setMode('travel')
  }

  /**
   * 이동 구간 **이어달리기** — 카메라를 원점으로 되돌리지 않는다.
   * 복도를 카메라 앞으로 옮기고(트레드밀) 레일을 현재 위치에서 다시 깔아
   * 문을 지나 다음 복도로 들어가는 동안 화면이 끊기지 않게 한다.
   */
  continueTravel(seed: number, kind: CorridorKind, seconds: number, hint: string | null = null): void {
    const x0 = this.camera.position.x
    const z0 = this.camera.position.z
    this.corridor.setHint(hint)
    this.corridor.rebuild(seed, kind)
    this.corridor.setOriginZ(z0)
    this.rail.resetFrom(seed, x0, z0)
    this.rail.start(seconds)
    this.setMode('travel')
  }

  /** UI 가 덮는 비율을 알려준다 (세로: 아래 45%, 가로: 오른쪽 40%) */
  setViewportInsets(bottomFrac: number, rightFrac: number): void {
    this.coverBottom = THREE.MathUtils.clamp(bottomFrac, 0, 0.8)
    this.coverRight = THREE.MathUtils.clamp(rightFrac, 0, 0.8)
    this.resize(this.w, this.h)
  }

  /**
   * 총 화면 위치 미세조정.
   * u,v 는 "UI 에 가려지지 않는 영역"의 정규화 좌표 (-1..1, v 는 위가 +1).
   * 세로/가로에서 같은 값이 같은 구도를 만든다.
   */
  setGunAnchor(u: number, v: number, dist: number): void {
    this.baseU = u
    this.baseV = v
    this.baseDist = dist
    this.applyInspect()
    this.layoutGun()
  }

  /** 처치 연출용 미세 줌 (§2.4). 1 이 기본 */
  setZoom(z: number): void {
    this.camera.zoom = THREE.MathUtils.clamp(z, 0.5, 3)
    this.camera.updateProjectionMatrix()
  }

  // -------------------------------------------------------------------------
  resize(w: number, h: number): void {
    this.w = Math.max(1, w)
    this.h = Math.max(1, h)
    const portrait = this.h >= this.w
    // 방향에 따라 기본 인셋을 고른다 (UI 가 명시적으로 알려주면 그 값이 우선)
    const b = portrait ? this.coverBottom : 0
    const r = portrait ? 0 : this.coverRight
    const visW = Math.max(0.2, 1 - r)
    const visH = Math.max(0.2, 1 - b)
    this.visW = visW
    this.visH = visH
    const cx = visW * 0.5
    const cy = visH * 0.5
    const kx = 2 * Math.max(cx, 1 - cx) + 0.02
    const ky = 2 * Math.max(cy, 1 - cy) + 0.02
    const fullW = kx * this.w
    const fullH = ky * this.h

    // 보이는 띠 기준 수평 화각 → 전체 절두체 화각으로 환산
    const hFovVis = THREE.MathUtils.degToRad(portrait ? 62 : 66)
    const tanH = Math.tan(hFovVis * 0.5) * (kx / visW)
    const aspect = fullW / fullH
    const fovDeg = THREE.MathUtils.clamp(
      THREE.MathUtils.radToDeg(2 * Math.atan(tanH / aspect)),
      15,
      158,
    )

    this.camera.aspect = aspect
    this.camera.fov = fovDeg
    this.camera.setViewOffset(
      fullW,
      fullH,
      fullW * 0.5 - cx * this.w,
      fullH * 0.5 - cy * this.h,
      this.w,
      this.h,
    )
    this.camera.updateProjectionMatrix()
    this.layoutGun()
    this.fx.resize(this.w, this.h)
  }

  /**
   * 보이는 영역 좌표(u,v) → 캔버스 NDC → 카메라 로컬 좌표.
   * 절두체 오프셋이 걸려 있어도 정확하다:
   *   ndcY = (e5*y + e9*z) / -z,  z = -d  →  y = d*(ndcY + e9)/e5
   */
  /**
   * 재장전 '들여다보기' 자세. 0 = 평소(구석), 1 = 화면 중앙으로 끌어와 크게.
   * 전투 중 총은 시야를 가리지 않게 구석에 있는데, 재장전은 **보여줘야 하는 연출**이라
   * 그동안만 카메라 앞으로 가져온다 (벅샷 룰렛이 총을 들어올리는 것과 같은 이유).
   */
  setInspect(t: number): void {
    this.inspectT = THREE.MathUtils.clamp(t, 0, 1)
    this.applyInspect()
  }

  private applyInspect(): void {
    const t = this.inspectT
    const e = t * t * (3 - 2 * t) // smoothstep
    this.gunU = this.baseU + (0.06 - this.baseU) * e
    this.gunV = this.baseV + (-0.24 - this.baseV) * e
    this.gunDist = this.baseDist + (0.56 - this.baseDist) * e
    this.layoutGun()
  }

  private layoutGun(): void {
    const ndcX = this.visW * (this.gunU + 1) - 1
    const ndcY = 1 - this.visH * (1 - this.gunV)
    const e = this.camera.projectionMatrix.elements
    const d = this.gunDist
    const e0 = e[0] || 1
    const e5 = e[5] || 1
    const x = (d * (ndcX + (e[8] ?? 0))) / e0
    const y = (d * (ndcY + (e[9] ?? 0))) / e5
    this.gun.layout(x, y, -d)
  }

  // -------------------------------------------------------------------------
  update(dt: number): void {
    const d = Math.min(dt, 0.05)
    this.t += d

    if (this.mode === 'travel') {
      this.rail.update(d, this.camera)
      this.corridor.update(d, this.rail.progress)
    } else {
      // 전투: 제자리 호흡 스웨이 (카메라 기본 자세를 매 프레임 확정한다)
      const s = this.t
      this.camera.position.set(
        Math.sin(s * 0.62) * 0.012,
        EYE + Math.sin(s * 1.05) * 0.009,
        0.25,
      )
      this.camera.rotation.set(
        Math.sin(s * 0.83 + 0.4) * 0.004,
        Math.sin(s * 0.51) * 0.006,
        Math.sin(s * 0.37) * 0.003,
      )
      this.corridor.update(d, 0)
    }

    // 손전등이 걸음/호흡에 맞춰 흔들린다 (카메라 로컬)
    this._lt.set(
      Math.sin(this.t * (this.mode === 'travel' ? 2.1 : 0.7)) * 0.55,
      -0.02 + Math.sin(this.t * 1.3) * 0.25,
      -6,
    )
    this.flashlight.target.position.copy(this._lt)

    this.gun.update(d)
    // 동적으로 붙은 자식(스파크 등)도 뷰모델 레이어에 유지한다
    this.gun.object.traverse((o) => { if (o.layers.mask !== 2) o.layers.set(1) })
    this.enemy.update(d)

    // ※ Fx 는 반드시 마지막. 셰이크/반동을 확정된 카메라 자세 위에 가산한다.
    this.fx.update(d, this.camera)
    this.camera.updateMatrixWorld(true)
  }

  dispose(): void {
    this.gun.dispose()
    this.enemy.dispose()
    this.corridor.dispose()
    this.fx.dispose()
    this.flashlight.dispose()
    this.ambient.dispose()
    this.root.clear()
  }
}

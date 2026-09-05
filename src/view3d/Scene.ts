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
import { CORRIDOR_LENGTH, CorridorStreamer, type CorridorKind } from './CorridorStreamer'
import { RailCamera } from './RailCamera'
import { BIOMES, DEFAULT_BIOME, type Biome } from './Biome'
import type { RegionId } from '../core/data/regions'

export type ViewMode = 'combat' | 'travel'

/** 안개 색 = 클리어 색. 복도 끝의 '구멍'이 안개와 이어지도록 맞춘다 */
export const FOG_COLOR = 0x06070a

const EYE = 1.62

/** 급브레이크가 잦아드는 데 걸리는 시간(초) */
const BRAKE_DUR = 1.7

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
  private readonly renderer: THREE.WebGLRenderer
  private biome: Biome = DEFAULT_BIOME

  private mode: ViewMode = 'combat'
  private t = 0
  private w = 1
  private h = 1
  /** DOM UI 가 덮는 비율 — **현재 적용값** (세로=아래, 가로=오른쪽) */
  private coverBottom = 0.45
  private coverRight = 0.4
  /** 같은 값의 목표. 이동→전투처럼 크게 바뀔 때만 여기로 천천히 따라간다 */
  private coverBottomTo = 0.45
  private coverRightTo = 0.4
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
    this.renderer = renderer
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
    this.applyFlashlightMode('combat')

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
  /**
   * 손전등 모드.
   *   적을 **검게** 만들었으므로 이제 손전등이 곧 정보 채널이다 — 빛이 닿는 만큼만 보인다.
   *   그런데 이동용으로 튜닝된 손전등(감쇠 1.55·사거리 30)은 20m 밖에 광량이
   *   거의 0 이라 전투 거리에서 적이 아예 안 보인다.
   *   전투에서는 "빛을 적에게 겨눈다"가 실제 행동이므로, 그때만 원뿔을 좁히고
   *   감쇠를 낮춰 **멀리 뻗는 빔**으로 바꾼다. 복도 이동은 넓고 짧은 원래 값을 쓴다.
   */
  private applyFlashlightMode(mode: ViewMode): void {
    const f = this.flashlight
    // 세기는 지역이 정한다 — 형광등이 켜진 곳에서 손전등은 있으나 마나 하다
    f.color.setHex(this.biome.torch.color)
    if (mode === 'combat') {
      f.intensity = this.biome.torch.combat
      f.distance = 60
      f.decay = 1.12
      f.angle = THREE.MathUtils.degToRad(35)
      f.penumbra = 0.86
    } else {
      f.intensity = this.biome.torch.travel
      f.distance = 30
      f.decay = 1.55
      f.angle = THREE.MathUtils.degToRad(38)
      f.penumbra = 0.72
    }
  }

  /**
   * 지역을 바꾼다 — 안개·앰비언트·손전등·복도 팔레트가 한 번에 따라간다.
   *   복도는 **다시 조립**되어야 하므로 이 호출만으로는 색이 바뀌지 않는다.
   *   다음 continueTravel 이 새 팔레트로 조립한다 (구간 경계에서만 바뀐다 —
   *   걷는 도중에 벽 색이 갈리면 그건 컷이다).
   */
  setBiome(id: RegionId): void {
    const b = BIOMES[id] ?? DEFAULT_BIOME
    if (b === this.biome) return
    this.biome = b
    const fog = this.root.fog
    if (fog instanceof THREE.FogExp2) {
      fog.color.setHex(b.fog.color)
      fog.density = b.fog.density
    }
    // 복도 끝의 '구멍' 이 안개와 이어지려면 클리어 색도 같이 가야 한다
    this.renderer.setClearColor(b.fog.color, 1)
    this.ambient.color.setHex(b.ambient.color)
    this.ambient.intensity = b.ambient.intensity
    this.applyFlashlightMode(this.mode)
  }

  get biomeId(): RegionId {
    return this.biome.id
  }

  setMode(mode: ViewMode): void {
    const was = this.mode
    this.mode = mode
    this.applyFlashlightMode(mode)
    if (mode === 'combat') {
      this.enemy.setVisible(true)
      this.rail.setSprint(0)
      this.gun.setLowered(false)
      this.corridor.hideDoors()
      // ★ 컷 없음. 예전에는 여기서 카메라를 (0, EYE, 0.25) 로, 복도를 원점으로
      //   되돌려서 복도 끝에 서 있던 플레이어가 한 프레임에 다른 복도 앞으로
      //   순간이동했다. 지금은 **걸어온 자리에 그대로 서서** 적을 맞는다:
      //   전투 기준점(anchor)을 지금 카메라 자리로 잡고, 적은 그 앞에 세우며,
      //   복도는 손대지 않는다. 카메라 자세만 0.45초에 걸쳐 전투 스웨이로 섞는다.
      if (was !== 'combat' || !this.anchored) {
        this.anchor.set(this.camera.position.x, 0, this.camera.position.z)
        this.blendFrom.copy(this.camera.position)
        this.blendRot.copy(this.camera.rotation)
        this.blend = 0
        this.anchored = true
      }
      // 미리 세워 둔 적도 여기서 anchor 에 다시 맞춘다. anchor.z 는 레일 끝점과
      // 정확히 같고(z 에는 보행 흔들림이 없다) x 만 보폭만큼 몇 cm 어긋나므로
      // 20m 밖에서는 1px 수준이다. 대신 프레임이 밀려 레일이 끝까지 못 간
      // 예외 상황에서도 **규칙상의 거리**가 어긋나지 않는다.
      this.enemy.object.position.set(this.anchor.x, 0, this.anchor.z)
    } else {
      // 이동 구간이라도 이 구간 끝에서 만날 적을 미리 세워 뒀다면 계속 보여 준다.
      this.enemy.setVisible(this.staged)
      this.gun.setLowered(true)
    }
  }

  /**
   * 전투 진입 — 복도에서 걸음을 **멈추는 순간**이다.
   *   컷도 페이드도 없다. 걸어온 자리에 그대로 선 채로 적이 나타나고,
   *   카메라가 급브레이크를 밟는다(뒤로 밀리고 위로 들렸다가 자세를 고쳐잡는다).
   *   총은 반쯤 내린 이동 자세에서 조금 늦게 올라온다 — 놀란 다음에 꺼내는 순서다.
   */
  enterCombat(): void {
    this.setMode('combat')
    this.staged = false
    this.gun.setLowered(true)
    this.gunUpIn = 0.24
    this.startleT = 0
  }

  private startleT = -1
  private gunUpIn = -1
  /** 이동 구간 끝에서 만날 적을 미리 세워 뒀는가 */
  private staged = false
  private readonly _end = new THREE.Vector3()

  /**
   * 이동 구간이 끝나는 자리에 적을 **미리** 세운다.
   *   적은 전투가 시작될 때 생기는 것이 아니라, 복도 저편에 처음부터 서 있다.
   *   달려가는 동안 안광이 안개 속에서 점점 커지고, 마지막에 실루엣이 드러난다.
   *   그래서 급브레이크는 "적이 나타나서" 밟는 것이 아니라 **적을 봤기 때문에**
   *   밟는 것이 된다 — 그게 원래의 순서다.
   *
   *   레일 끝점 = 전투 진입 시 anchor 이므로 자리가 정확히 맞고, 전투 시작에서
   *   같은 인자로 spawn 해도 EnemyRig 가 무시하므로 생물이 바뀌지 않는다.
   */
  stageEnemyAhead(
    bodyCount: number,
    archetypeId: string,
    variantSeed: number,
    startDist: number,
    bossId: string | null = null,
  ): void {
    this.enemy.spawn(bodyCount, archetypeId, variantSeed, bossId)
    this.rail.endPoint(this._end)
    this.enemy.object.position.set(this._end.x, 0, this._end.z)
    this.enemy.setDistance(startDist, startDist, false)
    this.enemy.setVisible(true)
    this.staged = true
    // 적을 보러 달려간다 — 접근성 설정이 흔들림을 줄였으면 보폭도 같이 줄인다
    this.rail.setSprint(this.fx.shakeScale)
  }

  /** 전투 기준점 — 복도 위 '지금 서 있는 자리'. 적·스웨이·손전등이 여기 기준이다 */
  private readonly anchor = new THREE.Vector3(0, 0, 0)
  private anchored = false
  private readonly blendFrom = new THREE.Vector3()
  private readonly blendRot = new THREE.Euler()
  private blend = 1
  private readonly _bp = new THREE.Vector3()
  private readonly _bq = new THREE.Quaternion()
  private readonly _tq = new THREE.Quaternion()

  getMode(): ViewMode {
    return this.mode
  }

  /** 이동 구간 시작 — 복도를 새 시드로 조립하고 레일을 태운다 (첫 진입) */
  startTravel(seed: number, kind: CorridorKind, seconds: number, hint: string | null = null): void {
    // 첫 진입도 이어달리기와 같다 — 카메라를 원점으로 되돌리면 전투 자리에서
    // 다음 복도로 넘어갈 때 한 프레임 컷이 생긴다. z 는 구간마다 −46m 씩 깊어지지만
    // 수백 구간이어도 부동소수 정밀도에는 한참 여유가 있다.
    this.continueTravel(seed, kind, seconds, hint)
  }

  /**
   * 이동 구간 **이어달리기** — 카메라를 원점으로 되돌리지 않는다.
   * 복도를 카메라 앞으로 옮기고(트레드밀) 레일을 현재 위치에서 다시 깔아
   * 문을 지나 다음 복도로 들어가는 동안 화면이 끊기지 않게 한다.
   */
  continueTravel(seed: number, kind: CorridorKind, seconds: number, hint: string | null = null): void {
    const x0 = this.camera.position.x
    const z0 = this.camera.position.z
    this.staged = false
    this.corridor.setHint(hint)
    this.corridor.rebuild(seed, kind, this.biome)
    this.corridor.setOriginZ(z0)
    this.rail.resetFrom(seed, x0, z0)
    this.rail.start(seconds)
    this.setMode('travel')
  }

  /**
   * UI 가 덮는 비율을 알려준다 (세로: 아래 45%, 가로: 오른쪽 40%).
   *
   * animate=true 면 **0.25초에 걸쳐** 옮긴다. 이동 구간은 인셋이 0 이라 시선축이
   * 화면 한가운데지만 전투는 위쪽 55% 띠의 한가운데다 — 한 프레임에 바꾸면
   * 복도(와 이제는 이미 보이는 적)가 화면 높이의 22% 만큼 위로 튄다.
   * 적이 전투 시작에 생겨나던 때는 그 점프가 안 보였지만, 미리 세워 둔 지금은 보인다.
   */
  setViewportInsets(bottomFrac: number, rightFrac: number, animate = false): void {
    const b = THREE.MathUtils.clamp(bottomFrac, 0, 0.8)
    const r = THREE.MathUtils.clamp(rightFrac, 0, 0.8)
    this.coverBottomTo = b
    this.coverRightTo = r
    if (animate) return
    this.coverBottom = b
    this.coverRight = r
    this.resize(this.w, this.h)
  }

  /** 인셋 보간 — 목표에 닿을 때까지만 절두체를 다시 만든다 */
  private tickInsets(dt: number): void {
    const db = this.coverBottomTo - this.coverBottom
    const dr = this.coverRightTo - this.coverRight
    if (Math.abs(db) < 1e-4 && Math.abs(dr) < 1e-4) {
      if (db !== 0 || dr !== 0) {
        this.coverBottom = this.coverBottomTo
        this.coverRight = this.coverRightTo
        this.resize(this.w, this.h)
      }
      return
    }
    const k = 1 - Math.exp(-dt / 0.085)
    this.coverBottom += db * k
    this.coverRight += dr * k
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

  /**
   * 조준 자세 (0 = 지향 사격, 1 = 조준선 정렬).
   *   총을 화면 가운데로 올려 가늠자/스코프가 적과 한 줄이 되게 한다.
   *   재장전이 끝난 뒤 **마지막 동작**이 이것이고, 그 다음에야 쏜다.
   */
  setAim(t: number): void {
    this.aimT = THREE.MathUtils.clamp(t, 0, 1)
    this.applyInspect()
  }

  private aimT = 0

  private applyInspect(): void {
    const ss = (x: number): number => x * x * (3 - 2 * x)
    const e = ss(this.inspectT)
    const a = ss(this.aimT)
    // 지향 → 조준 → 검사 순으로 덮어쓴다 (재장전 중에는 검사 자세가 이긴다)
    // 조준: 총을 화면 **가운데 아래**로 놓는다. 가늠자/스코프는 모델 위쪽(y≈+0.08)에
    //   있으므로, 총 원점을 중앙보다 낮게 두어야 조준선이 화면 한가운데에 온다.
    //   거리를 base 보다 멀리 잡는 이유는 가까이 당기면 총이 화면 절반을 먹어
    //   적이 통째로 가려지기 때문이다 (실측: dist 0.42 에서 26m 적이 안 보였다).
    let u = this.baseU + (0.0 - this.baseU) * a
    let v = this.baseV + (-0.275 - this.baseV) * a
    let dist = this.baseDist + (0.72 - this.baseDist) * a
    u += (0.06 - u) * e
    v += (-0.24 - v) * e
    dist += (0.56 - dist) * e
    this.gunU = u
    this.gunV = v
    this.gunDist = dist
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
    // raw = 캡 없는 실제 프레임 시간 (동결 카운트다운용, 폭주 방지로 0.25 만 막는다)
    // real = 물리·애니메이션용 캡
    const raw = Math.max(0, Math.min(dt, 0.25))
    const real = Math.min(raw, 0.05)
    // 히트스톱: 착탄 프레임을 붙잡는 동안 **월드 시간만** 멈춘다.
    const d = this.fx.consumeFreeze(raw, real)
    this.t += d
    this.tickInsets(real)

    if (this.mode === 'travel') {
      this.rail.update(d, this.camera)
      this.corridor.update(d, this.rail.progress)
    } else {
      // 전투: 제자리 호흡 스웨이 — 기준점(anchor) 주변에서 숨 쉰다.
      const s = this.t
      this._bp.set(
        this.anchor.x + Math.sin(s * 0.62) * 0.012,
        EYE + Math.sin(s * 1.05) * 0.009,
        this.anchor.z + Math.sin(s * 0.41) * 0.01,
      )
      this.camera.rotation.set(
        Math.sin(s * 0.83 + 0.4) * 0.004,
        Math.sin(s * 0.51) * 0.006,
        Math.sin(s * 0.37) * 0.003,
      )
      if (this.blend < 1) {
        // 걸어오던 자세(보행 흔들림 포함)에서 전투 자세로 부드럽게 넘어간다
        this.blend = Math.min(1, this.blend + real / 0.45)
        const k = this.blend * this.blend * (3 - 2 * this.blend)
        this._tq.setFromEuler(this.camera.rotation)
        this._bq.setFromEuler(this.blendRot)
        this._bq.slerp(this._tq, k)
        this.camera.quaternion.copy(this._bq)
        this.camera.position.lerpVectors(this.blendFrom, this._bp, k)
      } else {
        this.camera.position.copy(this._bp)
      }

      // 급브레이크는 **블렌드 뒤에** 얹는다. 블렌드 안에 넣었더니 lerp 계수 k 가
      //   0 에서 시작해 충격이 통째로 깎였다 — 설계값 0.30m 가 화면에서 0.048m 였다.
      //
      //   v2: 짧은 진동(0.9초·감쇠 5.2·주파수 8~13)은 "덜컹" 하고 끝나 버려서
      //   **달려오다 멈췄다**가 아니라 그냥 화면이 떨린 것으로 읽혔다.
      //   급제동은 진동이 아니라 **관성**이다: 한 번 크게 쏠렸다가 반대로 넘어가고,
      //   그게 서너 번 줄어들며 자세를 되찾는다. 그래서
      //     · 지속시간 0.9 → 1.7초, 감쇠 5.2 → 1.85 (왕복이 3~4번 보인다)
      //     · 진폭 앞뒤 0.34 → 0.62m, 좌우 0 → 0.34m (좌우가 핵심이다.
      //       달리다 서면 몸은 앞뒤로 흔들리는 게 아니라 옆으로 넘어간다)
      //     · 주파수 8.5~13 → 4.6~7.6 (느릴수록 '무게'가 붙는다)
      //   흔들림 설정(강/약/끔)을 그대로 곱한다 — 끄면 아무 일도 일어나지 않는다.
      if (this.startleT >= 0) {
        this.startleT += real
        const t = this.startleT
        const m = this.fx.shakeScale
        if (t > BRAKE_DUR || m <= 0) {
          this.startleT = -1
        } else {
          const onset = 1 - Math.exp(-t * 30) // 충격은 즉시 걸린다 (급제동)
          const a = m * onset * Math.exp(-t * 1.85)
          // 앞뒤: 멈추는 순간 뒤로 밀렸다가 앞으로 되쏠리기를 반복한다
          this.camera.position.z += 0.62 * a * Math.cos(t * 6.6)
          // 좌우: 발을 짚으며 몸이 크게 왔다갔다한다
          this.camera.position.x += 0.34 * a * Math.sin(t * 4.6 + 0.35)
          this.camera.position.y += 0.13 * a * Math.cos(t * 7.6 + 0.5) - 0.04 * a
          this.camera.rotateX(0.16 * a * Math.cos(t * 6.6 + 0.4))
          this.camera.rotateY(0.135 * a * Math.sin(t * 4.6))
          this.camera.rotateZ(0.155 * a * Math.sin(t * 4.0 + 1.0))
        }
      }
      if (this.gunUpIn >= 0) {
        this.gunUpIn -= real
        if (this.gunUpIn < 0) this.gun.setLowered(false)
      }
      // 복도 스트리밍은 카메라가 복도 안 어디쯤인지로 계속 굴린다 (트레드밀 유지)
      const prog = (this.corridor.originZ - this.camera.position.z) / CORRIDOR_LENGTH
      this.corridor.update(d, THREE.MathUtils.clamp(prog, 0, 1))
    }

    // 손전등이 걸음/호흡에 맞춰 흔들린다 (카메라 로컬)
    if (this.mode === 'combat') {
      // 전투에서는 **적을 겨눈다**. 적이 검은색이므로 빔이 닿는 것 자체가 정보다.
      // 고정 타깃(-6m)이면 20m 밖의 적은 원뿔 밖으로 나가 아무것도 안 보인다.
      const ez = this.enemy.bodyZ - this.camera.position.z
      const ey = 1.05 - this.camera.position.y
      const wob = Math.abs(ez) * 0.02
      this._lt.set(
        Math.sin(this.t * 0.7) * wob,
        ey + Math.sin(this.t * 1.3) * wob * 0.5,
        ez,
      )
    } else {
      this._lt.set(
        Math.sin(this.t * 2.1) * 0.55,
        -0.02 + Math.sin(this.t * 1.3) * 0.25,
        -6,
      )
    }
    this.flashlight.target.position.copy(this._lt)

    // 안광은 안개를 안 타므로(EnemyRig) 감쇠에 쓸 **실제 거리**를 여기서 넣는다.
    // 이동 중에는 복도 저편(50~70m), 전투에서는 규칙상의 거리다.
    this.enemy.setViewDist(Math.abs(this.camera.position.z - this.enemy.bodyZ))

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

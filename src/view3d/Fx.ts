// ============================================================================
// Fx.ts — 머즐 플래시 / 트레이서 / 파티클 / 화면 효과 / 카메라 셰이크
//   PRESENTATION.md §2.2 타임라인의 "화면·총구·트레이서·카메라" 레이어를 담당한다.
//   모든 오브젝트는 풀링. 프레임 중 신규 할당 0 을 목표로 한다.
// ============================================================================
import * as THREE from 'three'
import { PostPass, makeViewRng, type ViewRng } from './postShader'

// --- 파티클 셰이더 (텍스처 없이 원형 스프라이트) -----------------------------
const P_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3  aColor;
uniform float uPixelRatio;
varying vec3  vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(-mv.z, 0.15)) * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}
`
const P_FRAG = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float m = 1.0 - smoothstep(0.16, 0.5, d);
  if (m <= 0.004 || vAlpha <= 0.004) discard;
  gl_FragColor = vec4(vColor * m, vAlpha * m);
}
`

const MAX_PARTICLES = 256
const TRACER_POOL = 8
const FLASH_POOL = 3

interface TracerSlot {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  from: THREE.Vector3
  to: THREE.Vector3
  t: number
  active: boolean
}

interface FlashSlot {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  t: number
  active: boolean
  baseScale: number
}

/** 총구 플래시용 절차 텍스처 (3프레임 중 1장). 에셋 파일 없이 캔버스로 만든다. */
function makeFlashTexture(rng: ViewRng, size = 96): THREE.Texture {
  if (typeof document === 'undefined') return new THREE.Texture()
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')
  if (!g) return new THREE.Texture()
  const c = size / 2
  g.clearRect(0, 0, size, size)
  // 중심 코어
  const core = g.createRadialGradient(c, c, 0, c, c, c * 0.55)
  core.addColorStop(0, 'rgba(255,255,246,1)')
  core.addColorStop(0.35, 'rgba(255,214,130,0.85)')
  core.addColorStop(1, 'rgba(255,120,20,0)')
  g.fillStyle = core
  g.fillRect(0, 0, size, size)
  // 불규칙한 화염 갈래
  const spikes = 5 + rng.int(4)
  g.globalCompositeOperation = 'lighter'
  for (let i = 0; i < spikes; i++) {
    const a = rng.range(0, Math.PI * 2)
    const len = c * rng.range(0.55, 0.98)
    const w = rng.range(0.10, 0.30)
    g.beginPath()
    g.moveTo(c, c)
    g.lineTo(c + Math.cos(a - w) * len * 0.5, c + Math.sin(a - w) * len * 0.5)
    g.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len)
    g.lineTo(c + Math.cos(a + w) * len * 0.5, c + Math.sin(a + w) * len * 0.5)
    g.closePath()
    g.fillStyle = 'rgba(255,186,84,0.55)'
    g.fill()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export class Fx {
  readonly post = new PostPass()
  /** 동적 광원 2개 중 하나 (다른 하나는 손전등). TECH.md §3 예산 준수 */
  readonly muzzleLight: THREE.PointLight

  private readonly root: THREE.Scene
  private readonly rng: ViewRng = makeViewRng(0xfeed01)
  private readonly group = new THREE.Group()

  // --- 화면 효과 상태 ---
  private flash = 0
  private flashTau = 0.06
  private aber = 0
  private aberTau = 0.06
  private heatTarget = 0
  private heat = 0
  private time = 0

  // --- 접근성 강도 ---
  private flashI = 1
  private shakeI = 1
  private distortion = true
  private distortionQ = true

  // --- 셰이크 / 반동 ---
  private shakeAmp = 0 // rad
  private shakeTau = 0.08
  private recoilPitch = 0 // rad
  private recoilPush = 0 // m
  private recoilTau = 0.09
  private readonly nPhase: number[]

  // --- 풀 ---
  private readonly tracers: TracerSlot[] = []
  private readonly flashes: FlashSlot[] = []
  private muzzleT = 1

  // --- 파티클 ---
  private readonly pts: THREE.Points
  private readonly pMat: THREE.ShaderMaterial
  private readonly pGeo: THREE.BufferGeometry
  private readonly pPos: Float32Array
  private readonly pCol: Float32Array
  private readonly pSize: Float32Array
  private readonly pAlpha: Float32Array
  private readonly pVel: Float32Array
  private readonly pLife: Float32Array
  private readonly pMax: Float32Array
  private readonly pGrav: Float32Array
  private readonly pDrag: Float32Array
  private pHead = 0
  private budget = MAX_PARTICLES

  private readonly _v0 = new THREE.Vector3()
  private readonly _v1 = new THREE.Vector3()
  private readonly _v2 = new THREE.Vector3()
  private readonly _m = new THREE.Matrix4()
  private readonly _q = new THREE.Quaternion()
  private readonly _ax = new THREE.Vector3()
  private readonly _ay = new THREE.Vector3()
  private readonly _az = new THREE.Vector3()

  constructor(root: THREE.Scene) {
    this.root = root
    this.group.matrixAutoUpdate = false
    root.add(this.group)

    this.nPhase = [
      this.rng.range(0, 100),
      this.rng.range(0, 100),
      this.rng.range(0, 100),
    ]

    // 머즐 점광 (PRESENTATION §2.2 t=20 강도 9 → t=100 소멸)
    this.muzzleLight = new THREE.PointLight(0xffb15a, 0, 9, 1.7)
    this.muzzleLight.castShadow = false
    root.add(this.muzzleLight)

    // 트레이서 풀
    const tGeo = new THREE.PlaneGeometry(1, 1)
    for (let i = 0; i < TRACER_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      })
      const mesh = new THREE.Mesh(tGeo, mat)
      mesh.frustumCulled = false
      mesh.visible = false
      mesh.renderOrder = 20
      this.group.add(mesh)
      this.tracers.push({
        mesh,
        mat,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        t: 0,
        active: false,
      })
    }

    // 머즐 플래시 풀 (3프레임 = 서로 다른 텍스처 3장. 머티리얼 재컴파일 회피)
    const fGeo = new THREE.PlaneGeometry(1, 1)
    for (let i = 0; i < FLASH_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: makeFlashTexture(this.rng),
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      })
      const mesh = new THREE.Mesh(fGeo, mat)
      mesh.frustumCulled = false
      mesh.visible = false
      mesh.renderOrder = 21
      this.group.add(mesh)
      this.flashes.push({ mesh, mat, t: 0, active: false, baseScale: 1 })
    }

    // 파티클 (Points 1개, 최대 256 — TECH.md §3)
    this.pPos = new Float32Array(MAX_PARTICLES * 3)
    this.pCol = new Float32Array(MAX_PARTICLES * 3)
    this.pSize = new Float32Array(MAX_PARTICLES)
    this.pAlpha = new Float32Array(MAX_PARTICLES)
    this.pVel = new Float32Array(MAX_PARTICLES * 3)
    this.pLife = new Float32Array(MAX_PARTICLES)
    this.pMax = new Float32Array(MAX_PARTICLES)
    this.pGrav = new Float32Array(MAX_PARTICLES)
    this.pDrag = new Float32Array(MAX_PARTICLES)
    this.pGeo = new THREE.BufferGeometry()
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3))
    this.pGeo.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3))
    this.pGeo.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1))
    this.pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.pAlpha, 1))
    this.pGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.pMat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: 1 } },
      vertexShader: P_VERT,
      fragmentShader: P_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    })
    this.pMat.toneMapped = false
    this.pts = new THREE.Points(this.pGeo, this.pMat)
    this.pts.frustumCulled = false
    this.pts.renderOrder = 18
    this.group.add(this.pts)
  }

  // -------------------------------------------------------------------------
  // 설정
  // -------------------------------------------------------------------------
  /** 접근성: 번쩍임/흔들림 강도 (1=강, 0.3=약, 0=끔) */
  setIntensity(flash: number, shake: number): void {
    this.flashI = THREE.MathUtils.clamp(flash, 0, 1)
    this.shakeI = THREE.MathUtils.clamp(shake, 0, 1)
    if (this.flashI === 0) this.flash = 0
    if (this.shakeI === 0) {
      this.shakeAmp = 0
      this.recoilPitch = 0
      this.recoilPush = 0
    }
  }

  private get distOn(): boolean {
    return this.distortion && this.distortionQ
  }

  /** 접근성: 색수차·왜곡 끔 */
  setDistortionEnabled(on: boolean): void {
    this.distortion = on
    if (!this.distOn) {
      this.aber = 0
      this.heat = 0
      this.heatTarget = 0
      this.post.uniforms.uAber.value = 0
      this.post.uniforms.uHeat.value = 0
    }
  }

  /** 품질 강등(저사양)에서 왜곡을 끈다. 접근성 설정과 AND 로 합쳐진다 */
  setDistortionQuality(on: boolean): void {
    this.distortionQ = on
    if (!this.distOn) {
      this.aber = 0
      this.heat = 0
      this.heatTarget = 0
      this.post.uniforms.uAber.value = 0
      this.post.uniforms.uHeat.value = 0
    }
  }

  /** 품질 강등 시 파티클 예산 (고 256 / 중 96 / 저 0) */
  setParticleBudget(n: number): void {
    this.budget = THREE.MathUtils.clamp(Math.floor(n), 0, MAX_PARTICLES)
    if (this.budget === 0) {
      for (let i = 0; i < MAX_PARTICLES; i++) {
        this.pLife[i] = 0
        this.pAlpha[i] = 0
      }
    }
  }

  setPixelRatio(r: number): void {
    this.pMat.uniforms.uPixelRatio.value = r
  }

  setVignette(v: number): void {
    this.post.uniforms.uVignette.value = v
  }

  setTint(r: number, g: number, b: number): void {
    this.post.uniforms.uTint.value.setRGB(r, g, b)
  }

  // -------------------------------------------------------------------------
  // 연출 트리거
  // -------------------------------------------------------------------------
  muzzleFlash(pos: THREE.Vector3): void {
    this.muzzleLight.position.copy(pos)
    this.muzzleLight.intensity = 9 * (0.35 + 0.65 * this.flashI)
    this.muzzleT = 0
    const slot = this.flashes[this.rng.int(FLASH_POOL)]
    if (!slot) return
    slot.active = true
    slot.t = 0
    slot.baseScale = this.rng.range(0.30, 0.42)
    slot.mesh.position.copy(pos)
    slot.mesh.rotation.z = this.rng.range(0, Math.PI * 2)
    slot.mesh.visible = true
    slot.mesh.scale.setScalar(slot.baseScale)
    slot.mat.opacity = 1
  }

  /** 총구 → 흉부. 90ms 동안 길이 0→100%, 이후 60ms 페이드 (§2.2) */
  tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    let slot = this.tracers.find((t) => !t.active)
    if (!slot) slot = this.tracers[0]
    if (!slot) return
    slot.active = true
    slot.t = 0
    slot.from.copy(from)
    slot.to.copy(to)
    slot.mat.color.setHex(color)
    slot.mat.opacity = 1
    slot.mesh.visible = true
  }

  /** 피격 스파크. §2.2 t=120 은 12개, 처치 연출(§2.4)은 40개로 호출한다 */
  impact(pos: THREE.Vector3, color: number, count = 12): void {
    const c = new THREE.Color(color)
    for (let i = 0; i < count; i++) {
      this.emit(
        pos,
        this.rng.range(1.4, 4.6),
        c,
        this.rng.range(0.020, 0.055),
        this.rng.range(0.22, 0.5),
        -5.5,
        2.2,
      )
    }
  }

  /** 탄창 종료 시 총구 흰 연기 (§2.3 t=0) */
  smoke(pos: THREE.Vector3): void {
    const c = new THREE.Color(0x9aa2a8)
    for (let i = 0; i < 10; i++) {
      this.emit(pos, this.rng.range(0.25, 0.8), c, this.rng.range(0.05, 0.12), this.rng.range(0.7, 1.4), 0.55, 1.4)
    }
  }

  /** 백열 이상에서 총이 뿌리는 불티 (GunRig 가 호출) */
  spark(pos: THREE.Vector3, color: number): void {
    this.emit(pos, this.rng.range(0.5, 1.6), new THREE.Color(color), this.rng.range(0.012, 0.03), this.rng.range(0.35, 0.8), -3.2, 1.6)
  }

  screenFlash(alpha: number, decayMs: number): void {
    if (this.flashI <= 0) return
    // 접근성 "약": α 축소 + 지속 2배 (PRESENTATION §6)
    const soft = this.flashI < 0.99
    const a = alpha * this.flashI
    const d = (decayMs * (soft ? 2 : 1)) / 1000
    if (a > this.flash) this.flash = a
    this.flashTau = Math.max(0.016, d / 3)
  }

  aberration(amount: number, decayMs: number): void {
    if (!this.distOn) return
    const a = amount * (0.4 + 0.6 * this.flashI)
    if (a > this.aber) this.aber = a
    this.aberTau = Math.max(0.016, decayMs / 3000)
  }

  /** 0..1. 온도 8 이상에서 화면 가장자리 왜곡 (§2.2 t=250) */
  heatDistortion(v01: number): void {
    this.heatTarget = this.distOn ? THREE.MathUtils.clamp(v01, 0, 1) : 0
  }

  shake(amplitudeDeg: number, decayMs: number): void {
    if (this.shakeI <= 0) return
    const a = THREE.MathUtils.degToRad(amplitudeDeg) * this.shakeI
    if (a > this.shakeAmp) this.shakeAmp = a
    this.shakeTau = Math.max(0.02, decayMs / 3000)
  }

  /** 사격 킥: 카메라 pitch(도) + 후퇴(m). §2.2 t=0 */
  recoil(pitchDeg: number, pushM: number, decayMs: number): void {
    const s = 0.35 + 0.65 * this.shakeI
    this.recoilPitch = Math.max(this.recoilPitch, THREE.MathUtils.degToRad(Math.abs(pitchDeg)) * s)
    this.recoilPush = Math.max(this.recoilPush, pushM * s)
    this.recoilTau = Math.max(0.02, decayMs / 3000)
  }

  /** 즉사 연출용 롤 (PRESENTATION §2.5 t=250) */
  setRoll(deg: number): void {
    this.rollTarget = THREE.MathUtils.degToRad(deg)
  }
  private rollTarget = 0
  private roll = 0

  clearScreenEffects(): void {
    this.flash = 0
    this.aber = 0
    this.heat = 0
    this.heatTarget = 0
    this.shakeAmp = 0
    this.recoilPitch = 0
    this.recoilPush = 0
    this.rollTarget = 0
    this.roll = 0
  }

  // -------------------------------------------------------------------------
  // 파티클 방출
  // -------------------------------------------------------------------------
  private emit(
    pos: THREE.Vector3,
    speed: number,
    color: THREE.Color,
    size: number,
    life: number,
    gravity: number,
    drag: number,
  ): void {
    if (this.budget <= 0) return
    const i = this.pHead
    this.pHead = (this.pHead + 1) % this.budget
    const i3 = i * 3
    this.pPos[i3] = pos.x
    this.pPos[i3 + 1] = pos.y
    this.pPos[i3 + 2] = pos.z
    // 구면 균등 방향
    const u = this.rng.range(-1, 1)
    const th = this.rng.range(0, Math.PI * 2)
    const s = Math.sqrt(Math.max(0, 1 - u * u))
    this.pVel[i3] = Math.cos(th) * s * speed
    this.pVel[i3 + 1] = u * speed * 0.8 + speed * 0.25
    this.pVel[i3 + 2] = Math.sin(th) * s * speed
    this.pCol[i3] = color.r
    this.pCol[i3 + 1] = color.g
    this.pCol[i3 + 2] = color.b
    this.pSize[i] = size
    this.pAlpha[i] = 1
    this.pLife[i] = life
    this.pMax[i] = life
    this.pGrav[i] = gravity
    this.pDrag[i] = drag
  }

  // -------------------------------------------------------------------------
  // 매 프레임
  //   ※ 카메라 기본 자세(RailCamera / 아이들 스웨이)를 확정한 뒤 마지막에 호출할 것.
  //     셰이크·반동을 그 위에 가산으로 얹는다.
  // -------------------------------------------------------------------------
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    const d = Math.min(dt, 0.05)
    this.time += d

    // --- 화면 효과 감쇠 ---
    this.flash *= Math.exp(-d / this.flashTau)
    if (this.flash < 0.002) this.flash = 0
    this.aber *= Math.exp(-d / this.aberTau)
    if (this.aber < 0.002) this.aber = 0
    this.heat += (this.heatTarget - this.heat) * Math.min(1, d * 4.5)

    const u = this.post.uniforms
    u.uFlash.value = this.flash
    u.uAber.value = this.aber
    u.uHeat.value = this.heat
    u.uTime.value = this.time

    // --- 머즐 라이트 ---
    if (this.muzzleT < 1) {
      this.muzzleT = Math.min(1, this.muzzleT + d / 0.1)
      this.muzzleLight.intensity *= Math.exp(-d / 0.028)
      if (this.muzzleT >= 1) this.muzzleLight.intensity = 0
    }

    this.updateFlashes(d, camera)
    this.updateTracers(d, camera)
    this.updateParticles(d)
    this.applyCamera(d, camera)
  }

  private updateFlashes(d: number, camera: THREE.PerspectiveCamera): void {
    for (const f of this.flashes) {
      if (!f.active) continue
      f.t += d
      const p = f.t / 0.1
      if (p >= 1) {
        f.active = false
        f.mesh.visible = false
        continue
      }
      // 빌보드 (롤 유지)
      const roll = f.mesh.rotation.z
      f.mesh.quaternion.copy(camera.quaternion)
      f.mesh.rotateZ(roll)
      f.mesh.scale.setScalar(f.baseScale * (0.75 + p * 0.85))
      f.mat.opacity = (1 - p) * (0.45 + 0.55 * this.flashI)
    }
  }

  private updateTracers(d: number, camera: THREE.PerspectiveCamera): void {
    for (const t of this.tracers) {
      if (!t.active) continue
      t.t += d
      const grow = Math.min(1, t.t / 0.09) // 90ms 신장
      const fade = t.t <= 0.09 ? 1 : 1 - Math.min(1, (t.t - 0.09) / 0.06) // 60ms 페이드
      if (fade <= 0) {
        t.active = false
        t.mesh.visible = false
        continue
      }
      const dir = this._v0.subVectors(t.to, t.from)
      const full = dir.length()
      if (full < 1e-4) {
        t.active = false
        t.mesh.visible = false
        continue
      }
      dir.multiplyScalar(1 / full)
      const len = full * grow
      const mid = this._v1.copy(t.from).addScaledVector(dir, len * 0.5)
      // dir 을 로컬 X 축에, 화면을 향하도록 Y 축을 잡는다
      const toCam = this._v2.copy(camera.position).sub(mid).normalize()
      const yAxis = this._ay.crossVectors(toCam, dir)
      if (yAxis.lengthSq() < 1e-8) yAxis.set(0, 1, 0)
      yAxis.normalize()
      const zAxis = this._az.crossVectors(dir, yAxis)
      this._m.makeBasis(this._ax.copy(dir), yAxis, zAxis)
      this._q.setFromRotationMatrix(this._m)
      t.mesh.quaternion.copy(this._q)
      t.mesh.position.copy(mid)
      // 굵기 2.5px 감각 — 거리에 따라 살짝 굵게
      const w = 0.016 + full * 0.0012
      t.mesh.scale.set(len, w, 1)
      t.mat.opacity = fade
    }
  }

  private updateParticles(d: number): void {
    let any = false
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.pLife[i]! <= 0) continue
      any = true
      const i3 = i * 3
      const life = this.pLife[i]! - d
      this.pLife[i] = life
      if (life <= 0) {
        this.pAlpha[i] = 0
        this.pSize[i] = 0
        continue
      }
      const drag = Math.max(0, 1 - this.pDrag[i]! * d)
      this.pVel[i3] = this.pVel[i3]! * drag
      this.pVel[i3 + 1] = this.pVel[i3 + 1]! * drag + this.pGrav[i]! * d
      this.pVel[i3 + 2] = this.pVel[i3 + 2]! * drag
      this.pPos[i3] = this.pPos[i3]! + this.pVel[i3]! * d
      this.pPos[i3 + 1] = this.pPos[i3 + 1]! + this.pVel[i3 + 1]! * d
      this.pPos[i3 + 2] = this.pPos[i3 + 2]! + this.pVel[i3 + 2]! * d
      this.pAlpha[i] = Math.max(0, life / Math.max(0.001, this.pMax[i]!))
    }
    if (any) {
      const g = this.pGeo.attributes
      ;(g.position as THREE.BufferAttribute).needsUpdate = true
      ;(g.aAlpha as THREE.BufferAttribute).needsUpdate = true
      ;(g.aSize as THREE.BufferAttribute).needsUpdate = true
      ;(g.aColor as THREE.BufferAttribute).needsUpdate = true
    }
  }

  private applyCamera(d: number, camera: THREE.PerspectiveCamera): void {
    // 셰이크: 위상이 다른 사인 3개의 합 (펄린 대용, 결정론적)
    if (this.shakeAmp > 0.00005) {
      const t = this.time
      const a = this.shakeAmp
      const n0 = Math.sin(t * 41.3 + this.nPhase[0]!) * 0.6 + Math.sin(t * 17.7 + this.nPhase[1]!) * 0.4
      const n1 = Math.sin(t * 37.1 + this.nPhase[1]!) * 0.6 + Math.sin(t * 13.3 + this.nPhase[2]!) * 0.4
      const n2 = Math.sin(t * 29.9 + this.nPhase[2]!) * 0.6 + Math.sin(t * 11.1 + this.nPhase[0]!) * 0.4
      camera.rotateX(n0 * a)
      camera.rotateY(n1 * a)
      camera.rotateZ(n2 * a * 0.55)
      this.shakeAmp *= Math.exp(-d / this.shakeTau)
      if (this.shakeAmp < 0.00005) this.shakeAmp = 0
    }
    // 반동
    if (this.recoilPitch > 0.00005 || this.recoilPush > 0.00005) {
      camera.rotateX(this.recoilPitch)
      camera.translateZ(this.recoilPush)
      const k = Math.exp(-d / this.recoilTau)
      this.recoilPitch *= k
      this.recoilPush *= k
      if (this.recoilPitch < 0.00005) this.recoilPitch = 0
      if (this.recoilPush < 0.00005) this.recoilPush = 0
    }
    // 롤 (즉사 연출)
    if (Math.abs(this.rollTarget - this.roll) > 0.0005) {
      this.roll += (this.rollTarget - this.roll) * Math.min(1, d * 5)
    }
    if (Math.abs(this.roll) > 0.0005) camera.rotateZ(this.roll)
  }

  resize(w: number, h: number): void {
    this.post.setSize(w, h)
  }

  dispose(): void {
    for (const t of this.tracers) {
      t.mat.dispose()
      t.mesh.geometry.dispose()
    }
    for (const f of this.flashes) {
      f.mat.map?.dispose()
      f.mat.dispose()
      f.mesh.geometry.dispose()
    }
    this.pGeo.dispose()
    this.pMat.dispose()
    this.post.dispose()
    this.root.remove(this.group)
    this.root.remove(this.muzzleLight)
  }
}

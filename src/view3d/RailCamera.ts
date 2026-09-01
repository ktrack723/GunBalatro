// ============================================================================
// RailCamera.ts — 온레일 자동 이동 (PRESENTATION.md §5)
//   카트뮬-롬 스플라인 + 보행 사인파(상하 0.04m/2.1Hz, 좌우 0.02m/1.05Hz).
//   홀드=2배속, 더블탭=스킵은 입력 레이어가 setSpeedMul / skip 으로 넘긴다.
// ============================================================================
import * as THREE from 'three'
import { CORRIDOR_LENGTH } from './CorridorStreamer'
import { makeViewRng } from './postShader'

const EYE = 1.62

export class RailCamera {
  private curve: THREE.CatmullRomCurve3
  private duration = 10
  private p = 0
  private running = false
  private done = false
  private speedMul = 1
  private skipRate = 0
  private walkT = 0

  private readonly _pos = new THREE.Vector3()
  private readonly _look = new THREE.Vector3()
  private readonly _up = new THREE.Vector3(0, 1, 0)

  constructor(seed = 1) {
    this.curve = this.makeCurve(seed)
  }

  private makeCurve(seed: number): THREE.CatmullRomCurve3 {
    const rng = makeViewRng(seed ^ 0x7a11)
    const pts: THREE.Vector3[] = []
    const n = 6
    for (let i = 0; i <= n; i++) {
      const t = i / n
      // 양 끝은 복도 중앙, 중간은 좌우로 완만하게 흔들린다
      const edge = Math.sin(t * Math.PI)
      pts.push(
        new THREE.Vector3(
          rng.range(-0.34, 0.34) * edge,
          EYE + rng.range(-0.03, 0.03) * edge,
          -t * CORRIDOR_LENGTH,
        ),
      )
    }
    return new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5)
  }

  /** 경로 재생성 (다음 구간). start() 전에 호출 */
  reset(seed = 1): void {
    this.curve = this.makeCurve(seed)
    this.p = 0
    this.running = false
    this.done = false
    this.speedMul = 1
    this.skipRate = 0
  }

  start(seconds: number): void {
    this.duration = Math.max(0.5, seconds)
    this.p = 0
    this.running = true
    this.done = false
    this.speedMul = 1
    this.skipRate = 0
  }

  /** 홀드 시 2배속 */
  setSpeedMul(m: number): void {
    this.speedMul = THREE.MathUtils.clamp(m, 0.25, 4)
  }

  /** 더블탭 스킵 — 0.45초 안에 끝까지 밀어붙인다 (순간이동은 방향감각을 깬다) */
  skip(): void {
    if (this.done) return
    this.skipRate = Math.max(this.skipRate, (1 - this.p) / 0.45)
  }

  get progress(): number {
    return this.p
  }

  get finished(): boolean {
    return this.done
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    const d = Math.min(dt, 0.05)
    if (this.running && !this.done) {
      const rate = Math.max(this.speedMul / this.duration, this.skipRate)
      this.p += d * rate
      if (this.p >= 1) {
        this.p = 1
        this.done = true
        this.running = false
      }
      this.walkT += d * Math.max(1, this.speedMul) * (this.skipRate > 0 ? 2 : 1)
    }

    const t = THREE.MathUtils.clamp(this.p, 0, 1)
    this.curve.getPointAt(t, this._pos)
    // 시선: 조금 앞을 본다
    this.curve.getPointAt(Math.min(1, t + 0.035), this._look)
    if (t >= 1) this._look.set(this._pos.x, this._pos.y, this._pos.z - 2)

    // 보행 사인파 (PRESENTATION §5)
    const bobY = Math.sin(this.walkT * Math.PI * 2 * 2.1) * 0.04
    const bobX = Math.sin(this.walkT * Math.PI * 2 * 1.05) * 0.02
    camera.position.set(this._pos.x + bobX, this._pos.y + bobY, this._pos.z)

    this._look.y += bobY * 0.35
    camera.up.copy(this._up)
    camera.lookAt(this._look)
    // 머리 흔들림 (yaw/roll)
    camera.rotateZ(Math.sin(this.walkT * Math.PI * 2 * 1.05 + 0.7) * 0.021)
    camera.rotateY(Math.sin(this.walkT * Math.PI * 2 * 0.52) * 0.016)
    camera.rotateX(Math.sin(this.walkT * Math.PI * 2 * 2.1 + 1.3) * 0.008)
  }
}

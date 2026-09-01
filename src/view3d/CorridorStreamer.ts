// ============================================================================
// CorridorStreamer.ts — 모듈러 복도. 오브젝트 풀 + 변주 지오메트리 4종.
//   벽/천장/바닥/소품을 세그먼트 1개당 지오메트리 1장으로 병합해 드로우콜을 아낀다.
//   머티리얼은 전부 공유(정점 색으로 변주). 텍스처는 캔버스 절차 생성 1장.
//   광원을 쓰지 않는다 — 문틈 빛은 emissive 평면이다 (동적 광원 2개 예산 유지).
// ============================================================================
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { makeViewRng, type ViewRng } from './postShader'

export type CorridorKind = 'corridor' | 'stair' | 'office' | 'pipe' | 'garage' | 'chapel'

/** 온레일 구간의 총 주행 거리 (m). RailCamera 가 이 값을 그대로 쓴다 */
export const CORRIDOR_LENGTH = 46
const SEG_LEN = 4
const SEG_COUNT = 9
const VARIANTS = 4
const BEHIND = 6
const HW = 1.6 // 복도 반폭
const CH = 3.0 // 천장 높이

/** 위험도별 문틈 빛 (PRESENTATION §5) */
const THREAT_COLOR: Record<number, number> = { 1: 0xcfe0f0, 2: 0xffa53c, 3: 0xff4a52 }

// --- 지오메트리 헬퍼 ---------------------------------------------------------
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
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

function uvScale(g: THREE.BufferGeometry, s: number): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute | undefined
  if (!uv) return g
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * s, uv.getY(i) * s)
  }
  uv.needsUpdate = true
  return g
}

function bx(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  hex: number, uvs = 1,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  uvScale(g, uvs)
  if (rx) g.rotateX(rx)
  if (ry) g.rotateY(ry)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return paint(g, hex)
}

function cy(
  r: number, h: number, seg: number,
  x: number, y: number, z: number,
  hex: number, rx = 0, rz = 0,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, true)
  if (rx) g.rotateX(rx)
  if (rz) g.rotateZ(rz)
  g.translate(x, y, z)
  return paint(g, hex)
}

/** 얼룩/노이즈 텍스처 (에셋 파일 없이 캔버스로 생성) */
function makeGrimeTexture(rng: ViewRng, size = 256): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')
  if (!g) return null
  g.fillStyle = '#8d8d8a'
  g.fillRect(0, 0, size, size)
  // 미세 노이즈
  const img = g.getImageData(0, 0, size, size)
  const px = img.data
  for (let i = 0; i < px.length; i += 4) {
    const n = (rng.next() - 0.5) * 46
    px[i] = THREE.MathUtils.clamp(px[i]! + n, 0, 255)
    px[i + 1] = THREE.MathUtils.clamp(px[i + 1]! + n, 0, 255)
    px[i + 2] = THREE.MathUtils.clamp(px[i + 2]! + n * 0.9, 0, 255)
  }
  g.putImageData(img, 0, 0)
  // 습기 얼룩
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, size)
    const y = rng.range(0, size)
    const r = rng.range(8, 54)
    const grd = g.createRadialGradient(x, y, 0, x, y, r)
    const a = rng.range(0.05, 0.22)
    grd.addColorStop(0, `rgba(40,44,40,${a})`)
    grd.addColorStop(1, 'rgba(40,44,40,0)')
    g.fillStyle = grd
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  // 흘러내린 자국
  g.strokeStyle = 'rgba(30,26,24,0.20)'
  for (let i = 0; i < 20; i++) {
    const x = rng.range(0, size)
    g.lineWidth = rng.range(0.7, 2.6)
    g.beginPath()
    g.moveTo(x, rng.range(0, size * 0.4))
    g.lineTo(x + rng.range(-4, 4), rng.range(size * 0.5, size))
    g.stroke()
  }
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export class CorridorStreamer {
  private readonly scene: THREE.Scene
  private readonly group = new THREE.Group()
  private readonly mat: THREE.MeshStandardMaterial
  private readonly tex: THREE.Texture | null

  private readonly segs: THREE.Mesh[] = []
  private readonly slot: number[] = []
  private variants: THREE.BufferGeometry[] = []
  private kind: CorridorKind = 'corridor'
  private seed: number
  private hint: string | null = null

  // 문
  private readonly doorGroup = new THREE.Group()
  private readonly doorSeam: THREE.Mesh[] = []
  private readonly doorGlow: THREE.Mesh[] = []
  private readonly doorMark: THREE.Mesh[][] = []
  private readonly seamMat: THREE.MeshBasicMaterial[] = []
  private readonly glowMat: THREE.MeshBasicMaterial[] = []
  private doorFlickT = 0

  constructor(scene: THREE.Scene, seed: number) {
    this.scene = scene
    this.seed = seed
    const rng = makeViewRng(seed ^ 0x51ce)
    this.tex = makeGrimeTexture(rng)
    if (this.tex) this.tex.repeat.set(1, 1)
    this.mat = new THREE.MeshStandardMaterial({
      map: this.tex,
      vertexColors: true,
      roughness: 0.94,
      metalness: 0.06,
    })
    scene.add(this.group)

    for (let i = 0; i < SEG_COUNT; i++) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.mat)
      m.frustumCulled = true
      m.matrixAutoUpdate = false
      this.segs.push(m)
      this.slot.push(-99999)
      this.group.add(m)
    }
    this.buildDoors()
    this.rebuild(seed, 'corridor')
  }

  // -------------------------------------------------------------------------
  /** 텍스처 비등방성 (Renderer 능력치에 맞춰 GameScene 이 지정) */
  setAnisotropy(a: number): void {
    if (this.tex) {
      this.tex.anisotropy = Math.max(1, Math.floor(a))
      this.tex.needsUpdate = true
    }
  }

  /** 다음 적 예고 데칼용 힌트 (아키타입 id). rebuild 전에 지정한다 */
  setHint(archetypeId: string | null): void {
    this.hint = archetypeId
  }

  rebuild(seed: number, kind: CorridorKind): void {
    this.seed = seed
    this.kind = kind
    for (const g of this.variants) g.dispose()
    this.variants = []
    for (let v = 0; v < VARIANTS; v++) {
      this.variants.push(this.buildSegment(makeViewRng((seed ^ 0x1000193) + v * 7919), v))
    }
    for (let i = 0; i < SEG_COUNT; i++) this.slot[i] = -99999
    this.update(0, 0)
  }

  // -------------------------------------------------------------------------
  private buildSegment(rng: ViewRng, variant: number): THREE.BufferGeometry {
    const g: THREE.BufferGeometry[] = []
    const H = SEG_LEN / 2

    // --- 기본 껍데기 ---
    g.push(bx(HW * 2, 0.12, SEG_LEN, 0, -0.06, 0, 0x3c3f42, 2.2))          // 바닥
    g.push(bx(HW * 2, 0.12, SEG_LEN, 0, CH + 0.06, 0, 0x26282b, 2.0))      // 천장
    g.push(bx(0.16, CH, SEG_LEN, -HW - 0.08, CH / 2, 0, 0x4a483f, 2.4))    // 좌벽
    g.push(bx(0.16, CH, SEG_LEN, HW + 0.08, CH / 2, 0, 0x4a483f, 2.4))     // 우벽
    g.push(bx(0.05, 0.26, SEG_LEN, -HW + 0.02, 0.13, 0, 0x33322c, 1.4))
    g.push(bx(0.05, 0.26, SEG_LEN, HW - 0.02, 0.13, 0, 0x33322c, 1.4))

    // --- 종류별 소품 ---
    switch (this.kind) {
      case 'corridor': {
        for (let i = 0; i < 2; i++) {
          const z = rng.range(-H, H)
          g.push(cy(0.055, SEG_LEN, 6, -HW + 0.22 + i * 0.14, CH - 0.28, 0, 0x59544a, Math.PI / 2))
          if (rng.next() < 0.5) g.push(bx(0.30, 0.06, 0.30, rng.range(-HW + .5, HW - .5), 0.03, z, 0x2f3033, 1))
        }
        g.push(bx(0.10, 0.55, 0.10, HW - 0.25, 0.28, rng.range(-H, H), 0x4a3c30, 1))
        if (rng.next() < 0.45) {
          g.push(bx(1.1, 0.9, 0.09, rng.range(-0.6, 0.6), 0.45, rng.range(-H, H), 0x5a4b3a, 1, 0, 0, rng.range(-0.5, 0.5)))
        }
        break
      }
      case 'stair': {
        for (let i = 0; i < 8; i++) {
          const z = H - i * 0.5 - 0.25
          g.push(bx(HW * 1.7, 0.16, 0.5, 0, 0.08 + i * 0.17, z, 0x45443f, 1.2))
        }
        g.push(cy(0.045, SEG_LEN, 6, -HW + 0.25, 1.15, 0, 0x6b6255, Math.PI / 2))
        g.push(bx(0.12, 1.2, 0.12, -HW + 0.25, 0.6, -H + 0.4, 0x53504a, 1))
        g.push(bx(0.12, 1.2, 0.12, -HW + 0.25, 1.2, H - 0.4, 0x53504a, 1))
        break
      }
      case 'office': {
        for (let i = 0; i < 2; i++) {
          const x = rng.sign() * rng.range(0.75, 1.15)
          const z = rng.range(-H + 0.6, H - 0.6)
          g.push(bx(0.95, 0.06, 0.62, x, 0.72, z, 0x6a5a44, 1))
          g.push(bx(0.07, 0.72, 0.07, x - 0.4, 0.36, z - 0.24, 0x3b3a37, 1))
          g.push(bx(0.07, 0.72, 0.07, x + 0.4, 0.36, z + 0.24, 0x3b3a37, 1))
        }
        g.push(bx(0.06, 1.5, 1.6, -HW + 0.2, 0.75, rng.range(-H, H), 0x4d5145, 1.4))
        g.push(bx(0.55, 0.06, 0.55, rng.range(-0.6, 0.6), 0.42, rng.range(-H, H), 0x54453a, 1, rng.range(-0.6, 0.6)))
        if (variant % 2 === 0) g.push(bx(1.1, 0.04, 1.1, rng.range(-0.7, 0.7), CH - 0.02, rng.range(-H, H), 0x1b1c1e, 1))
        break
      }
      case 'pipe': {
        for (let i = 0; i < 5; i++) {
          const y = 0.5 + i * 0.5
          const s = i % 2 === 0 ? -1 : 1
          g.push(cy(rng.range(0.05, 0.11), SEG_LEN, 6, s * (HW - 0.24), y, 0, 0x5d5347, Math.PI / 2))
        }
        g.push(cy(0.20, 0.12, 8, HW - 0.34, 1.5, rng.range(-H, H), 0x6d5b3c, 0, Math.PI / 2))
        g.push(bx(HW * 1.9, 0.02, SEG_LEN * 0.9, 0, 0.015, 0, 0x1d2426, 2))  // 물 고임
        break
      }
      case 'garage': {
        g.push(bx(0.14, CH * 0.8, SEG_LEN * 0.85, -HW - 0.02, CH * 0.45, 0, 0x63594a, 3.2))
        if (variant % 2 === 0) {
          g.push(bx(1.7, 0.6, 3.0, rng.range(-0.4, 0.4), 0.42, rng.range(-H, H), 0x4a2f2c, 1))
          g.push(bx(1.4, 0.5, 1.3, 0, 0.92, 0.2, 0x35393d, 1))
          g.push(cy(0.30, 0.20, 8, -0.85, 0.30, -1.0, 0x1e1f21, 0, Math.PI / 2))
          g.push(cy(0.30, 0.20, 8, 0.85, 0.30, -1.0, 0x1e1f21, 0, Math.PI / 2))
        }
        g.push(bx(0.5, 0.9, 0.5, HW - 0.4, 0.45, rng.range(-H, H), 0x554b3c, 1))
        break
      }
      case 'chapel': {
        for (let i = 0; i < 2; i++) {
          const z = -H + 1 + i * 2
          g.push(cy(0.20, CH, 8, -HW + 0.32, CH / 2, z, 0x6a6558))
          g.push(cy(0.20, CH, 8, HW - 0.32, CH / 2, z, 0x6a6558))
          g.push(bx(0.5, 0.18, 0.5, -HW + 0.32, CH - 0.1, z, 0x77705f, 1))
          g.push(bx(0.5, 0.18, 0.5, HW - 0.32, CH - 0.1, z, 0x77705f, 1))
          g.push(bx(1.5, 0.10, 0.36, 0, 0.46, z + 0.6, 0x4a3a2a, 1))
          g.push(bx(1.5, 0.42, 0.10, 0, 0.66, z + 0.44, 0x4a3a2a, 1))
        }
        g.push(bx(0.9, 0.10, 0.10, 0, CH - 0.5, 0, 0x8a7a4a, 1))
        g.push(bx(0.10, 0.9, 0.10, 0, CH - 0.5, 0, 0x8a7a4a, 1))
        break
      }
    }

    // --- 다음 적 예고 데칼 (PRESENTATION §5) ---
    this.pushHintDecals(g, rng, H)

    const merged = mergeGeometries(g)
    for (const x of g) x.dispose()
    return merged ?? new THREE.BufferGeometry()
  }

  private pushHintDecals(g: THREE.BufferGeometry[], rng: ViewRng, H: number): void {
    if (!this.hint || rng.next() < 0.45) return
    const blood = 0x39100f
    const side = rng.sign()
    switch (this.hint) {
      case 'runner': // 길게 끌린 자국
        g.push(bx(0.03, 0.10, 2.6, side * (HW - 0.022), rng.range(0.5, 1.4), rng.range(-1, 1), blood, 1, 0, 0, rng.range(-0.15, 0.15)))
        break
      case 'bloat': // 넓은 얼룩
        g.push(bx(1.5, 0.02, 1.5, rng.range(-0.5, 0.5), 0.02, rng.range(-H, H), blood, 1))
        break
      case 'horde': // 다수의 손자국
        for (let i = 0; i < 6; i++) {
          g.push(bx(0.03, 0.16, 0.13, side * (HW - 0.022), rng.range(0.7, 1.7), rng.range(-H, H), blood, 1))
        }
        break
      case 'crawler':
        g.push(bx(0.9, 0.02, 0.35, rng.range(-0.6, 0.6), 0.02, rng.range(-H, H), blood, 1))
        break
      default: // shambler — 벽에 문지른 자국
        g.push(bx(0.03, 0.4, 0.6, side * (HW - 0.022), rng.range(0.8, 1.5), rng.range(-H, H), blood, 1))
    }
  }

  // -------------------------------------------------------------------------
  // 갈림길 문 2개
  // -------------------------------------------------------------------------
  private buildDoors(): void {
    this.doorGroup.visible = false
    this.doorGroup.position.z = -(CORRIDOR_LENGTH + 2.4)
    this.scene.add(this.doorGroup)

    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -0.86 : 0.86
      // 문틀 + 문짝 (공유 머티리얼)
      const frame = mergeGeometries([
        bx(0.10, 2.30, 0.14, sx - 0.44, 1.15, 0, 0x55524a, 1),
        bx(0.10, 2.30, 0.14, sx + 0.44, 1.15, 0, 0x55524a, 1),
        bx(0.98, 0.12, 0.14, sx, 2.30, 0, 0x55524a, 1),
        bx(0.80, 2.22, 0.08, sx, 1.11, -0.05, 0x312f2b, 1),
        bx(0.16, 0.05, 0.06, sx + 0.28, 1.05, 0.03, 0x8a7642, 1),
      ])
      if (frame) {
        const m = new THREE.Mesh(frame, this.mat)
        this.doorGroup.add(m)
      }
      // 문틈 빛 (emissive 평면 — PointLight 를 쓰지 않는다)
      const seamMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      })
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      })
      this.seamMat.push(seamMat)
      this.glowMat.push(glowMat)

      const seamGeo = mergeGeometries([
        new THREE.PlaneGeometry(0.035, 2.2).translate(sx - 0.405, 1.11, 0.05),
        new THREE.PlaneGeometry(0.035, 2.2).translate(sx + 0.405, 1.11, 0.05),
        new THREE.PlaneGeometry(0.85, 0.035).translate(sx, 2.22, 0.05),
        new THREE.PlaneGeometry(0.85, 0.05).translate(sx, 0.03, 0.06),
      ])
      if (seamGeo) {
        const seam = new THREE.Mesh(seamGeo, seamMat)
        seam.renderOrder = 8
        this.doorGroup.add(seam)
        this.doorSeam.push(seam)
      }
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.9), glowMat)
      glow.position.set(sx, 1.2, 0.09)
      glow.renderOrder = 7
      this.doorGroup.add(glow)
      this.doorGlow.push(glow)

      // 스프레이 표식 ◆ (위험도 개수)
      const marks: THREE.Mesh[] = []
      for (let k = 0; k < 3; k++) {
        const mk = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), seamMat)
        mk.position.set(sx - 0.22 + k * 0.22, 2.52, 0.02)
        mk.rotation.z = Math.PI / 4
        mk.renderOrder = 8
        mk.visible = false
        this.doorGroup.add(mk)
        marks.push(mk)
      }
      this.doorMark.push(marks)
    }
  }

  /** 갈림길 문 2개를 복도 끝에 세운다 */
  showDoors(threats: [number, number]): void {
    this.doorGroup.visible = true
    for (let i = 0; i < 2; i++) {
      const t = THREE.MathUtils.clamp(Math.round(threats[i] ?? 1), 1, 3)
      const hex = THREAT_COLOR[t] ?? THREAT_COLOR[1]!
      this.seamMat[i]?.color.setHex(hex)
      this.glowMat[i]?.color.setHex(hex)
      const marks = this.doorMark[i]
      if (marks) for (let k = 0; k < marks.length; k++) marks[k]!.visible = k < t
    }
  }

  hideDoors(): void {
    this.doorGroup.visible = false
  }

  get doorZ(): number {
    return this.doorGroup.position.z
  }

  // -------------------------------------------------------------------------
  update(dt: number, camProgress: number): void {
    const camZ = -THREE.MathUtils.clamp(camProgress, 0, 1) * CORRIDOR_LENGTH
    const base = Math.floor((-camZ - BEHIND) / SEG_LEN)
    for (let j = 0; j < SEG_COUNT; j++) {
      const s = base + j
      if (this.slot[j] === s) continue
      this.slot[j] = s
      const mesh = this.segs[j]!
      const v = this.variants[((s % VARIANTS) + VARIANTS) % VARIANTS]
      if (v) mesh.geometry = v
      mesh.position.set(0, 0, -s * SEG_LEN)
      mesh.updateMatrix()
    }
    // 문틈 빛 깜빡임 (결정론적 사인 합성)
    if (this.doorGroup.visible) {
      this.doorFlickT += dt
      const f = 0.82 + Math.sin(this.doorFlickT * 6.1) * 0.06 + Math.sin(this.doorFlickT * 13.7) * 0.04
      for (let i = 0; i < this.seamMat.length; i++) {
        this.seamMat[i]!.opacity = f
        this.glowMat[i]!.opacity = 0.10 + (f - 0.8) * 0.5 + 0.06
      }
    }
  }

  dispose(): void {
    for (const g of this.variants) g.dispose()
    this.variants = []
    for (const m of this.doorSeam) m.geometry.dispose()
    for (const m of this.doorGlow) m.geometry.dispose()
    for (const arr of this.doorMark) for (const m of arr) m.geometry.dispose()
    for (const m of this.seamMat) m.dispose()
    for (const m of this.glowMat) m.dispose()
    this.doorGroup.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose()
    })
    this.mat.dispose()
    this.tex?.dispose()
    this.scene.remove(this.group)
    this.scene.remove(this.doorGroup)
  }
}

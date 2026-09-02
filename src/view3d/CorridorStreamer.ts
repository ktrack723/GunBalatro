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

/** 덩어리 (살·알집·고치). 구를 눌러 유기적인 형태를 만든다 */
function sp(
  r: number, sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  hex: number,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, 7, 5)
  g.scale(sx, sy, sz)
  g.translate(x, y, z)
  return paint(g, hex)
}

/** 두 점을 잇는 가는 기둥 (힘줄·철근·거미줄 가닥) */
function strut(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r: number, hex: number, seg = 4,
): THREE.BufferGeometry {
  const dx = x1 - x0
  const dy = y1 - y0
  const dz = z1 - z0
  const len = Math.hypot(dx, dy, dz) || 0.001
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, false)
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dx, dy, dz).normalize(),
  )
  g.applyQuaternion(q)
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  return paint(g, hex)
}

// --- 동선 보호 ---------------------------------------------------------------
/**
 * 카메라는 복도 중앙을 ±0.36m 안에서 흔들리며 직진한다 (RailCamera).
 * 그 띠 안에 서 있는 기물은 **플레이어가 뚫고 지나간다** — 실기에서 책상과 차량이
 * 그렇게 통과됐다. 그래서 바닥(2cm)·천장(2.0m 위) 외의 기물은 이 반경 밖에만 놓는다.
 */
const KEEP = 0.86
/** 통행 가능한 머리 높이 — 매달린 것은 이 위에만 둔다 */
const HEAD = 2.05

/** 좌우 중 한쪽, 통로 밖의 x. half 는 기물의 반폭(그만큼 더 밀어낸다) */
function sideX(rng: ViewRng, near: number, far: number, half = 0): number {
  const a = Math.max(KEEP + half, Math.min(near, far))
  const b = Math.max(a, Math.max(near, far))
  return rng.sign() * rng.range(a, b)
}

// --- 기괴한 기물 어휘 ---------------------------------------------------------
const FLESH = 0x3a1d1c
const FLESH_D = 0x24100f
const SAC = 0x5b5a3e
const BONE = 0x8f8a76
const SINEW = 0x4a3230

/** 벽에 자라난 살덩이 군집 */
function growth(g: THREE.BufferGeometry[], rng: ViewRng, H: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const s = rng.sign()
    const x = s * (HW - 0.05)
    const y = rng.range(0.2, 2.3)
    const z = rng.range(-H, H)
    const r = rng.range(0.14, 0.30)
    g.push(sp(r, 0.55, 1.0, 1.25, x, y, z, i % 2 === 0 ? FLESH : FLESH_D))
    g.push(sp(r * 0.6, 0.5, 0.9, 1.0, x, y + r * 0.9, z + r * 0.5, FLESH_D))
  }
}

/** 알집 — 벽·바닥 모서리에 뭉쳐 있다 */
function eggSacs(g: THREE.BufferGeometry[], rng: ViewRng, H: number, n: number): void {
  const s = rng.sign()
  const cz = rng.range(-H + 0.5, H - 0.5)
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.09, 0.19)
    g.push(sp(
      r, 1, 1.15, 1,
      s * (HW - rng.range(0.10, 0.34)),
      rng.range(0.06, 0.9),
      cz + rng.range(-0.7, 0.7),
      SAC,
    ))
  }
}

/** 천장에 매달린 고치. 머리 위(HEAD)보다 아래로 내려오지 않는다 */
function cocoon(g: THREE.BufferGeometry[], rng: ViewRng, H: number, centered: boolean): void {
  const x = centered ? rng.range(-0.5, 0.5) : sideX(rng, 0.9, HW - 0.35, 0.2)
  const z = rng.range(-H + 0.4, H - 0.4)
  const bottom = centered ? HEAD + 0.10 : rng.range(1.2, 1.9)
  const len = rng.range(0.5, 0.85)
  const top = Math.min(CH - 0.1, bottom + len)
  const mid = (bottom + top) / 2
  g.push(strut(x, top, z, x, CH, z, 0.018, SINEW))
  g.push(sp(len * 0.34, 0.62, 1.0, 0.62, x, mid, z, SAC))
  g.push(sp(len * 0.22, 0.7, 0.9, 0.7, x, bottom + len * 0.16, z, FLESH_D))
}

/** 천장에서 늘어진 힘줄 가닥 — 얇아서 지나가도 되지만 머리 위에서 멈춘다 */
function sinewCurtain(g: THREE.BufferGeometry[], rng: ViewRng, H: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const x = rng.range(-1.2, 1.2)
    const z = rng.range(-H, H)
    const bottom = rng.range(HEAD, CH - 0.35)
    g.push(strut(x, bottom, z, x + rng.range(-0.06, 0.06), CH, z, rng.range(0.008, 0.018), SINEW))
  }
}

/** 벽에 꿰인 것 — 철근이 벽에서 튀어나오고 덩어리가 걸려 있다 */
function impaled(g: THREE.BufferGeometry[], rng: ViewRng, H: number): void {
  const s = rng.sign()
  const z = rng.range(-H + 0.5, H - 0.5)
  const y = rng.range(1.0, 1.9)
  const x0 = s * (HW - 0.02)
  const x1 = s * (HW - 0.62)
  g.push(strut(x0, y, z, x1, y - 0.16, z, 0.026, 0x4c4a44))
  g.push(sp(0.22, 0.68, 1.15, 0.62, s * (HW - 0.42), y - 0.22, z, FLESH))
  g.push(strut(s * (HW - 0.40), y - 0.45, z, s * (HW - 0.30), y - 0.95, z, 0.035, FLESH_D))
}

/** 벽 밑동의 뼈 무더기 */
function bonePile(g: THREE.BufferGeometry[], rng: ViewRng, H: number): void {
  const s = rng.sign()
  const cz = rng.range(-H + 0.6, H - 0.6)
  const cx = s * rng.range(KEEP + 0.25, HW - 0.25)
  g.push(sp(0.42, 1.25, 0.42, 1.0, cx, 0.10, cz, 0x2a2724))
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, Math.PI)
    const l = rng.range(0.16, 0.34)
    g.push(strut(
      cx + Math.cos(a) * 0.2, rng.range(0.06, 0.26), cz + Math.sin(a) * 0.2,
      cx + Math.cos(a) * (0.2 + l), rng.range(0.10, 0.34), cz + Math.sin(a) * (0.2 + l),
      rng.range(0.015, 0.030), BONE, 4,
    ))
  }
}

/** 벽에 남은 갈퀴 자국 3줄 */
function clawMarks(g: THREE.BufferGeometry[], rng: ViewRng, H: number): void {
  const s = rng.sign()
  const y = rng.range(0.7, 2.0)
  const z = rng.range(-H, H)
  for (let i = 0; i < 3; i++) {
    g.push(bx(
      0.03, rng.range(0.5, 0.9), 0.035,
      s * (HW - 0.02), y + i * 0.001, z + (i - 1) * 0.11,
      0x140909, 1, 0, 0, rng.range(-0.3, 0.3),
    ))
  }
}

/** 모서리를 가로지르는 막 — 벽과 천장 사이에만 친다 */
function membrane(g: THREE.BufferGeometry[], rng: ViewRng, H: number): void {
  const s = rng.sign()
  const z = rng.range(-H + 0.8, H - 0.8)
  const p = new THREE.PlaneGeometry(1.25, 1.25)
  p.rotateY(-s * Math.PI / 4)
  p.translate(s * (HW - 0.42), CH - 0.5, z)
  g.push(paint(p, 0x4b4838))
  for (let i = 0; i < 3; i++) {
    g.push(strut(
      s * (HW - 0.04), CH - 0.05, z + rng.range(-0.5, 0.5),
      s * (HW - 0.80), CH - rng.range(0.7, 1.1), z + rng.range(-0.5, 0.5),
      0.010, SAC, 3,
    ))
  }
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
    //   전부 KEEP(±0.86m) 밖, 또는 바닥(2cm)·머리 위(HEAD)에만 놓는다.
    //   가운데 서 있는 기물은 카메라가 그대로 통과해 버린다.
    switch (this.kind) {
      case 'corridor': {
        for (let i = 0; i < 2; i++) {
          g.push(cy(0.055, SEG_LEN, 6, -HW + 0.22 + i * 0.14, CH - 0.28, 0, 0x59544a, Math.PI / 2))
        }
        growth(g, rng, H, 2)
        clawMarks(g, rng, H)
        sinewCurtain(g, rng, H, 3)
        if (rng.next() < 0.55) bonePile(g, rng, H)
        // 바닥에 끌린 자국 (2cm — 밟고 지나가도 되는 유일한 것)
        g.push(bx(0.5, 0.02, rng.range(1.4, 2.6), rng.range(-0.9, 0.9), 0.012, rng.range(-H, H), 0x2a1211, 1))
        break
      }
      case 'stair': {
        // 계단은 **통로를 가로막지 않는다**. 카메라는 평지를 직진하므로,
        // 진행선 위에 계단을 놓으면 카메라와 총이 그대로 뚫고 지나간다.
        // 옆으로 난 계단참(위층으로 올라가는 길)으로 그려 지나쳐 보게 한다.
        // 모든 구간에 계단이 있으면 복도가 계단으로 도배된다 — 일부 구간에만 둔다
        if (variant % 3 !== 0) break
        const side = variant % 2 === 0 ? 1 : -1
        const wallX = side * (HW - 0.06)
        for (let i = 0; i < 7; i++) {
          // x 는 벽 쪽으로만, z 는 한 칸 안쪽에 모아 둔다
          const step = 0.42
          g.push(
            bx(0.95, 0.14, step, wallX - side * 0.5, 0.1 + i * 0.19, H - 1.2 - i * step, 0x45443f, 1.2),
          )
        }
        // 계단참 난간
        g.push(cy(0.05, 2.6, 6, wallX - side * 0.95, 1.15, H - 2.4, 0x6b6255, 0.42, 0))
        g.push(bx(0.1, 1.1, 0.1, wallX - side * 0.95, 0.55, H - 1.2, 0x53504a, 1))
        g.push(bx(0.1, 1.1, 0.1, wallX - side * 0.95, 1.15, H - 3.4, 0x53504a, 1))
        // 위층으로 뚫린 어두운 개구부 (계단이 어디로 가는지 읽히게)
        g.push(bx(1.5, 0.02, 2.2, wallX - side * 0.6, CH - 0.01, H - 2.3, 0x07080a, 1))
        cocoon(g, rng, H, false)
        bonePile(g, rng, H)
        break
      }
      // 사무실이 아니라 **둥지**다. 벽과 천장이 알집과 막으로 덮여 있다.
      case 'office': {
        eggSacs(g, rng, H, 7)
        membrane(g, rng, H)
        growth(g, rng, H, 2)
        if (variant % 2 === 0) cocoon(g, rng, H, true)
        // 바닥에 깔린 점액 막 (2cm)
        g.push(bx(HW * 1.7, 0.02, SEG_LEN * 0.8, 0, 0.014, 0, 0x2b2a1c, 2))
        break
      }
      // 배관실 — 관에 꿰인 것들이 매달려 있다
      case 'pipe': {
        for (let i = 0; i < 5; i++) {
          const y = 0.5 + i * 0.5
          const s = i % 2 === 0 ? -1 : 1
          g.push(cy(rng.range(0.05, 0.11), SEG_LEN, 6, s * (HW - 0.24), y, 0, 0x5d5347, Math.PI / 2))
        }
        g.push(cy(0.20, 0.12, 8, HW - 0.34, 1.5, rng.range(-H, H), 0x6d5b3c, 0, Math.PI / 2))
        g.push(bx(HW * 1.9, 0.02, SEG_LEN * 0.9, 0, 0.015, 0, 0x1d2426, 2))  // 물 고임
        impaled(g, rng, H)
        growth(g, rng, H, 1)
        sinewCurtain(g, rng, H, 4)
        break
      }
      // 차고 — 차량은 벽에 처박혀 있다. 통로 한가운데 두면 그대로 통과된다.
      case 'garage': {
        g.push(bx(0.14, CH * 0.8, SEG_LEN * 0.85, -HW - 0.02, CH * 0.45, 0, 0x63594a, 3.2))
        if (variant % 2 === 0) {
          const s = variant % 4 === 0 ? 1 : -1
          const cx = s * 1.32
          g.push(bx(0.90, 0.62, 3.0, cx, 0.44, rng.range(-0.4, 0.4), 0x4a2f2c, 1, 0, 0, s * 0.22))
          g.push(bx(0.80, 0.52, 1.3, cx + s * 0.06, 0.94, 0.2, 0x35393d, 1, 0, 0, s * 0.22))
          g.push(cy(0.30, 0.20, 8, cx - s * 0.42, 0.30, -1.0, 0x1e1f21, 0, Math.PI / 2))
          g.push(cy(0.30, 0.20, 8, cx - s * 0.42, 0.30, 1.0, 0x1e1f21, 0, Math.PI / 2))
        }
        bonePile(g, rng, H)
        clawMarks(g, rng, H)
        impaled(g, rng, H)
        break
      }
      // 예배당 — 기둥은 벽에 붙이고, 시체는 천장에 매단다 (신도석은 통로를 막았다)
      case 'chapel': {
        for (let i = 0; i < 2; i++) {
          const z = -H + 1 + i * 2
          g.push(cy(0.20, CH, 8, -HW + 0.32, CH / 2, z, 0x6a6558))
          g.push(cy(0.20, CH, 8, HW - 0.32, CH / 2, z, 0x6a6558))
          g.push(bx(0.5, 0.18, 0.5, -HW + 0.32, CH - 0.1, z, 0x77705f, 1))
          g.push(bx(0.5, 0.18, 0.5, HW - 0.32, CH - 0.1, z, 0x77705f, 1))
          // 부서진 신도석 — 벽 쪽으로 밀려 쌓여 있다
          const s = i === 0 ? 1 : -1
          g.push(bx(0.62, 0.10, 1.5, s * 1.22, 0.46, z + 0.6, 0x4a3a2a, 1, 0, s * 0.3, 0))
          g.push(bx(0.62, 0.42, 0.10, s * 1.22, 0.66, z + 0.0, 0x4a3a2a, 1))
        }
        // 성물 — 통로 위에 매달려 있다
        g.push(bx(0.9, 0.10, 0.10, 0, CH - 0.45, 0, 0x8a7a4a, 1))
        g.push(bx(0.10, 0.9, 0.10, 0, CH - 0.45, 0, 0x8a7a4a, 1))
        cocoon(g, rng, H, true)
        cocoon(g, rng, H, false)
        membrane(g, rng, H)
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

  /**
   * 복도 전체를 z 방향으로 옮긴다 (트레드밀).
   * 카메라를 원점으로 되돌리는 대신 복도를 카메라 앞으로 옮기면
   * 구간이 바뀌어도 화면이 끊기지 않는다.
   */
  setOriginZ(z: number): void {
    this.group.position.z = z
    this.doorGroup.position.z = z
  }

  get originZ(): number {
    return this.group.position.z
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

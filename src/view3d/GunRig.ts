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
/** 화면에 동시에 떠 있을 수 있는 탄피 수 (한 탄창 최대 12발이라 넉넉하다) */
const CASING_POOL = 10
const CASING_LIFE = 0.85

/**
 * 재장전 중 총을 옆으로 트는 각도. **완전히 옆으로 눕히지 않는다** — 0.62rad(36°)
 * 은 총을 거의 직각으로 세워서, 탄창이 화면 밖으로 밀려나고 삽탄이 안 보였다.
 * 볼 면이 드러날 만큼만 살짝 튼다.
 */
const CANT_YAW = 0.30
const CANT_ROLL = 0.18
const CANT_SHIFT = 0.024

const MAG_HOME = new THREE.Vector3(0, -0.105, -0.178)
/**
 * 탄창 '제시' 자세 — 총 **왼쪽 옆**으로 빼낸다.
 * 탄창은 총 아래에 있어서, 카메라가 뒤에서 보는 구도에서는 몸체에 가린다.
 * 옆으로 빼야 삽탄이 실제로 보인다.
 */
// −0.355 는 총이 **오른쪽**으로 눕던 시절의 값이다. 그때는 왼쪽으로 크게 빼야
// 몸체 뒤에서 나왔지만, 이제는 총이 왼쪽으로 돌아 탄창실이 이미 카메라를 향한다.
// 같은 값을 유지하면 탄창이 화면 왼쪽 밖으로 나간다 (실측 화면 x = -68px).
// 회전이 하던 일을 회전에 맡기고, 옆으로 미는 양은 줄인다.
const MAG_PRESENT = new THREE.Vector3(-0.145, 0.010, -0.315)
const ROUND_GEO = new THREE.CylinderGeometry(0.0115, 0.0115, 0.052, 8, 1, false)
ROUND_GEO.rotateX(Math.PI / 2)
/**
 * 탄 끝의 은색 띠 — **플레이어를 보는 쪽** 끄트머리에만 얇고 짧게 두른다.
 * 단색 원기둥은 색만 다른 막대로 읽혀서 어느 쪽이 앞인지, 무엇이 장전됐는지가 안 보인다.
 */
const ROUND_TIP_GEO = new THREE.CylinderGeometry(0.0122, 0.0122, 0.009, 8, 1, false)
ROUND_TIP_GEO.rotateX(Math.PI / 2)
ROUND_TIP_GEO.translate(0, 0, 0.0225)
const TIP_MAT = new THREE.MeshStandardMaterial({
  color: 0xd8dde3, roughness: 0.28, metalness: 0.9,
})

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

/** 부드러운 방사형 글로우 텍스처 — 가장자리 알파 0 */
function makeGlowTexture(size = 128): THREE.Texture | null {
  if (typeof document === 'undefined') return null
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const g = cv.getContext('2d')
  if (!g) return null
  const c = size / 2
  const grad = g.createRadialGradient(c, c, 0, c, c, c)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.28, 'rgba(255,255,255,0.55)')
  grad.addColorStop(0.62, 'rgba(255,255,255,0.12)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const t = new THREE.CanvasTexture(cv)
  t.colorSpace = THREE.SRGBColorSpace
  return t
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
  private lowerX = 0
  private lowerRz = 0
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
    // 텍스처 없는 additive 평면은 **테두리가 선 직사각형**으로 보였다 — 반동 펄스가
    // 매 발 불투명도를 올려서 쏠 때마다 총 위에 납작한 네모가 떴다. 방사형 알파로
    // 가장자리를 0 까지 죽인다.
    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xff9a3c, transparent: true, opacity: 0, map: makeGlowTexture(),
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false,
    })

    // --- 강철부 (수신부·개머리·손잡이·광학) ---
    //   볼터 실루엣: **짧고 두껍다.** 총열이 길면 화면 절반이 관이 되고 실루엣이
    //   소총으로 읽힌다. 수신부를 키우고 총열을 0.47 → 0.34 로 줄여 앞이 뭉툭해진다.
    const steel: THREE.BufferGeometry[] = [
      box(0.118, 0.128, 0.36, 0, -0.060, -0.19),   // 수신부 — 두껍게
      box(0.072, 0.026, 0.30, 0, 0.004, -0.20),    // 상부 레일
      box(0.104, 0.132, 0.20, 0, -0.092, 0.10),    // 개머리
      box(0.070, 0.044, 0.15, 0, -0.024, 0.065),
      box(0.056, 0.140, 0.070, 0, -0.162, -0.028, 0.30), // 손잡이
      box(0.036, 0.016, 0.078, 0, -0.130, -0.098),
      box(0.066, 0.058, 0.115, 0, 0.036, -0.118),  // 광학 블록
      box(0.074, 0.015, 0.032, 0, 0.060, -0.172),
      box(0.015, 0.050, 0.015, 0, 0.028, -0.500),  // 가늠쇠 (총열 단축에 맞춰 앞으로)
      box(0.038, 0.038, 0.055, 0, -0.070, 0.010),
    ]
    // --- 총열부 (온도 램프 대상) ---
    const hot: THREE.BufferGeometry[] = [
      cyl(0.031, 0.031, 0.34, 10, 0, -0.028, -0.460, HALF_PI),  // 총열 (짧고 굵게)
      box(0.098, 0.098, 0.24, 0, -0.028, -0.380),                // 총열 덮개
      cyl(0.050, 0.044, 0.082, 10, 0, -0.028, -0.648, HALF_PI),  // 소염기
      box(0.072, 0.012, 0.032, 0, 0.008, -0.655),
      box(0.012, 0.072, 0.032, 0, -0.028, -0.655),
    ]
    for (let i = 0; i < 5; i++) {
      hot.push(box(0.102, 0.012, 0.018, 0, 0.012, -0.300 - i * 0.030))
    }
    // --- 황동 장식 (제국식 각인) ---
    const brass: THREE.BufferGeometry[] = [
      box(0.122, 0.016, 0.020, 0, -0.020, -0.040),
      box(0.024, 0.056, 0.012, 0, -0.062, -0.352),
      box(0.076, 0.012, 0.010, 0, -0.030, 0.170),
      box(0.016, 0.016, 0.016, 0, -0.010, -0.290, 0, 0, Math.PI / 4),
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
    this.glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.30), this.glowMat)
    this.glowMesh.position.set(0, -0.028, -0.44)
    this.glowMesh.renderOrder = 12
    this.parts.add(this.glowMesh)

    // --- 조준 장치 ---------------------------------------------------------
    //   부착물에 광학이 있으면 **스코프**, 없으면 **아이언사이트**. 둘 중 하나만 뜬다.
    //   조준 자세(ADS)에서 이 선을 적에게 맞추는 것이 사격 전 마지막 동작이다.
    const sightMat = new THREE.MeshStandardMaterial({
      color: 0x9aa2ab, roughness: 0.35, metalness: 0.85,
    })
    //   아이언사이트도 **가늘게**. 노치 사이가 뚫려 있어야 그 틈으로 적이 보인다.
    //   **떠 있으면 안 된다.** 조준선 높이(y≈0.078)는 수신부보다 한참 위인데,
    //   앞쪽 가늠쇠가 있는 z=-0.560 에서 총열 윗면은 y≈0.003 밖에 안 된다. 그냥 두면
    //   가늠쇠가 공중에 뜬다 — 그래서 총열을 물는 **밴드**와 거기서 올라오는 **기둥**을
    //   세워 총몸까지 이어 붙인다. 뒤쪽 가늠자는 광학 블록(윗면 y=0.065) 위에 얹힌다.
    const iron: THREE.BufferGeometry[] = [
      // 가늠자 — 뒤쪽 노치 (좌우 기둥 + 아래 다리). 다리가 광학 블록 위에 앉는다
      box(0.007, 0.026, 0.010, -0.024, 0.078, -0.150),
      box(0.007, 0.026, 0.010, 0.024, 0.078, -0.150),
      box(0.055, 0.007, 0.010, 0, 0.066, -0.150),
      box(0.030, 0.014, 0.020, 0, 0.059, -0.150),   // 가늠자 받침 — 블록에 물린다
      // 가늠쇠 받침 — 총열을 감싸는 밴드와 거기서 솟는 기둥 (뜨지 않게 하는 부분)
      box(0.074, 0.074, 0.028, 0, -0.028, -0.560),
      box(0.022, 0.062, 0.018, 0, 0.036, -0.560),
      // 가늠쇠 — 앞쪽 기둥과 보호 날개 (날개는 바깥으로 벌린다)
      box(0.006, 0.034, 0.010, 0, 0.082, -0.560),
      box(0.005, 0.026, 0.008, -0.022, 0.078, -0.560),
      box(0.005, 0.026, 0.008, 0.022, 0.078, -0.560),
      box(0.048, 0.007, 0.010, 0, 0.068, -0.560),   // 날개 밑동을 기둥에 묶는다
    ]
    this.ironGroup.add(new THREE.Mesh(mergeGeometries(iron)!, sightMat))
    for (const g of iron) g.dispose()
    this.parts.add(this.ironGroup)

    // 경통을 **속이 빈 링 두 개 + 가는 레일**로 만든다.
    //   막힌 원기둥은 조준선 한가운데에 은색 벽을 세우는 것과 같아서 적이 통째로
    //   가려졌다 (실측 스크린샷). 링만 남기면 가운데가 뚫려 적이 그대로 보이고,
    //   '스코프를 통해 본다' 는 그림은 링 두 개로 충분히 읽힌다.
    const ring = (r: number, t: number, z: number): THREE.BufferGeometry => {
      const g = new THREE.TorusGeometry(r, t, 6, 18)
      g.translate(0, 0.086, z)
      return g
    }
    const scope: THREE.BufferGeometry[] = [
      ring(0.030, 0.0055, -0.128), // 접안 링
      ring(0.032, 0.0060, -0.300), // 대물 링
      box(0.008, 0.008, 0.175, -0.028, 0.086, -0.214), // 좌 레일
      box(0.008, 0.008, 0.175, 0.028, 0.086, -0.214),  // 우 레일
      box(0.008, 0.008, 0.175, 0, 0.114, -0.214),      // 상 레일
      box(0.026, 0.030, 0.030, 0, 0.058, -0.200),      // 마운트
    ]
    this.scopeGroup.add(new THREE.Mesh(mergeGeometries(scope)!, sightMat))
    for (const g of scope) g.dispose()
    // 레티클 — 접안부 안쪽의 십자선. 가산 블렌딩이라 어두워도 보인다.
    const retMat = new THREE.MeshBasicMaterial({
      color: 0xff4436, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false,
    })
    // 레티클도 십자를 **가운데를 비우고** 그린다 — 정중앙에 점을 찍으면 그 점이
    //   적의 급소를 덮는다. 바깥쪽 네 토막만 남긴다.
    const ret: THREE.BufferGeometry[] = [
      box(0.011, 0.0018, 0.001, -0.014, 0.086, -0.140),
      box(0.011, 0.0018, 0.001, 0.014, 0.086, -0.140),
      box(0.0018, 0.011, 0.001, 0, 0.100, -0.140),
      box(0.0018, 0.011, 0.001, 0, 0.072, -0.140),
    ]
    const retMesh = new THREE.Mesh(mergeGeometries(ret)!, retMat)
    retMesh.renderOrder = 14
    for (const g of ret) g.dispose()
    this.scopeGroup.add(retMesh)
    this.parts.add(this.scopeGroup)
    this.scopeGroup.visible = false

    this.muzzleObj.position.set(0, -0.028, -0.700)
    this.parts.add(this.muzzleObj)

    this.recoilNode.add(this.parts)
    this.sway.add(this.recoilNode)
    this.object.add(this.sway)

    // --- 탄피 배출 ---------------------------------------------------------
    //   총 자체(sway/recoil)에는 붙이지 않는다. 배출된 탄피는 총과 함께 흔들리는
    //   부품이 아니라 **떨어져 나간 물체**다 — 뷰모델 공간(object)에 두고 자체
    //   물리로 날린다. 레이어 1 을 직접 박아 둔다: Scene 은 생성 시점에 한 번만
    //   traverse 로 레이어를 칠하므로, 나중에 만든 메시는 칠해지지 않는다.
    // 탄피는 **탄과 같은 크기**다 (ROUND_GEO 와 동일 치수)
    const caseGeo = cyl(0.0115, 0.0115, 0.052, 8, 0, 0, 0, 0, 0, HALF_PI)
    for (let i = 0; i < CASING_POOL; i += 1) {
      const m = new THREE.Mesh(caseGeo, this.brassMat)
      m.visible = false
      m.frustumCulled = false
      m.layers.set(1)
      this.object.add(m)
      this.casings.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), t: -1 })
    }
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
  /**
   * 발사 반동. 탄이 날아가는 선을 지운 뒤로 "쐈다" 를 알리는 건 이 튐 하나뿐이다 —
   * 그래서 크게 준다. 총구가 위로 크게 들리고 몸이 뒤로 밀린다.
   */
  kick(strength: number): void {
    const s = THREE.MathUtils.clamp(strength, 0, 2.5)
    this.kickVX += 13.5 * s
    this.kickVZ += 4.2 * s
  }

  /**
   * 재장전 중 총을 어느 쪽으로 돌릴지. **-1 = 왼쪽, 0 = 정면, +1 = 오른쪽.**
   *   동작마다 봐야 할 면이 다르다 — 탄창은 총 **왼쪽**에서 빠지고, 장전손잡이는
   *   **오른쪽**에 있다. 한 방향으로 고정해 두면 둘 중 하나는 총몸에 가려진다.
   *   그래서 시퀀서가 단계마다 이 값을 돌려 가며 볼 면을 카메라로 내민다.
   *   (+1 일 때 총구가 오른쪽으로 가고 오른쪽 면이 카메라를 본다.)
   */
  setCant(a: number): void {
    this.inspectCant = THREE.MathUtils.clamp(a, -1, 1)
  }

  private inspectCant = 0

  private readonly ironGroup = new THREE.Group()
  private readonly scopeGroup = new THREE.Group()

  /**
   * 광학 부착물이 달렸는가. 달렸으면 스코프, 아니면 아이언사이트가 보인다.
   * 조준 자세에서 플레이어가 적과 맞추는 그 선이다.
   */
  setOptic(has: boolean): void {
    this.scopeGroup.visible = has
    this.ironGroup.visible = !has
  }

  /** 배출된 탄피 (뷰모델 공간에서 자체 물리로 난다) */
  private readonly casings: Array<{
    mesh: THREE.Mesh
    vel: THREE.Vector3
    spin: THREE.Vector3
    t: number
  }> = []

  /**
   * 탄피를 한 발 배출한다. 오른쪽 위·뒤로 튀어 나가 돌면서 떨어진다.
   * 배출구는 노리쇠 오른쪽(x +0.075) 이다.
   */
  ejectCasing(): void {
    const slot = this.casings.find((c) => c.t < 0) ?? this.casings[0]
    if (slot === undefined) return
    slot.t = 0
    slot.mesh.position.set(0.075, -0.012, -0.232)
    slot.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3)
    slot.mesh.visible = true
    slot.mesh.scale.setScalar(1)
    slot.vel.set(0.86 + Math.random() * 0.34, 0.70 + Math.random() * 0.26, 0.34 + Math.random() * 0.24)
    slot.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 22,
      (Math.random() - 0.5) * 30,
    )
  }

  private updateCasings(d: number): void {
    for (const c of this.casings) {
      if (c.t < 0) continue
      c.t += d
      if (c.t > CASING_LIFE) {
        c.t = -1
        c.mesh.visible = false
        continue
      }
      c.vel.y -= 2.6 * d // 뷰모델 공간이라 중력도 '보기 좋은' 값으로 줄인다
      c.mesh.position.addScaledVector(c.vel, d)
      c.mesh.rotation.x += c.spin.x * d
      c.mesh.rotation.y += c.spin.y * d
      c.mesh.rotation.z += c.spin.z * d
      // 마지막 25% 는 줄여서 사라지게 (알파 없이도 자연스럽게 빠진다)
      const k = c.t / CASING_LIFE
      if (k > 0.75) c.mesh.scale.setScalar(Math.max(0.01, 1 - (k - 0.75) / 0.25))
    }
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
    this.updateCasings(d)

    // --- 반동 스프링 (임계 감쇠에 가깝게) ---
    const k = 460, c = 27
    this.kickVX += (-k * this.kickX - c * this.kickVX) * d
    this.kickX += this.kickVX * d
    this.kickVZ += (-k * this.kickZ - c * this.kickVZ) * d
    this.kickZ += this.kickVZ * d
    // 검사 자세 — 요(yaw) 로 볼 면을 카메라로 돌리고, 롤로 눕힌다. 부호가 방향이다.
    //   반동은 rotation.x / position.y·z 만 쓰므로 여기서 y·z·x 를 써도 겹치지 않는다.
    const cant = this.inspectCant
    this.recoilNode.rotation.y = -CANT_YAW * cant
    this.recoilNode.rotation.z = CANT_ROLL * cant
    this.recoilNode.position.x = CANT_SHIFT * cant
    // 스프링이 강하게 감쇠돼 kickX 자체는 0.33 언저리까지밖에 안 간다 —
    //   계수를 키워 **눈에 보이는 각도**로 만든다 (실측 0.038rad = 2° → 0.14rad = 8°).
    this.recoilNode.rotation.x = this.kickX * 0.42
    this.recoilNode.position.z = this.kickZ * 0.055
    this.recoilNode.position.y = this.kickX * 0.075

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
    //   이동 중에는 총을 **반쯤 내린다**. 0.55rad(31°) 는 화면에서 거의 안 내려간 것처럼
    //   보였다 — 총구를 바닥으로 더 눕히고, 아래·오른쪽으로 빼서 시야를 비운다.
    //   전투로 넘어올 때 이 자세에서 올라오는 것이 곧 '총을 꺼내는' 동작이다.
    const targetRx = this.lowered ? 0.82 : 0
    const targetY = this.lowered ? -0.24 : 0
    const targetX = this.lowered ? 0.055 : 0
    const targetRz = this.lowered ? -0.16 : 0
    const poseK = Math.min(1, d * 5)
    this.sway.rotation.x += (targetRx - this.sway.rotation.x) * poseK
    this.sway.position.y += (targetY - this.sway.position.y) * poseK
    this.lowerX += (targetX - this.lowerX) * poseK
    this.lowerRz += (targetRz - this.lowerRz) * poseK

    // --- 호흡 / 보행 스웨이 ---
    const bf = this.lowered ? 2.1 : 0.62
    const amp = this.lowered ? 1 : 0.4
    this.sway.position.x = this.lowerX + Math.sin(this.t * bf * Math.PI) * 0.006 * amp
    this.sway.rotation.z = this.lowerRz + Math.sin(this.t * bf * Math.PI * 0.5) * 0.012 * amp

    // --- 16 이상: 미세 떨림 / 30 이상: 스파크 ---
    //   온도가 붙으면 총이 **손에서 논다.** 임계를 16 → 9 로 내리고 진폭을 4배로.
    //   이게 '뜨겁다' 를 화면에서 읽는 유일한 촉각 신호다.
    const hs = this.heatShown
    if (hs >= 9) {
      const j = THREE.MathUtils.clamp((hs - 9) / 16, 0, 1) * 0.011 + 0.0028
      this.parts.position.x = Math.sin(this.t * 71) * j + Math.sin(this.t * 137) * j * 0.4
      this.parts.position.y = Math.sin(this.t * 83 + 1.7) * j + Math.sin(this.t * 151) * j * 0.35
      this.parts.rotation.z = 0.048 + Math.sin(this.t * 63) * j * 2.2
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
      const tip = new THREE.Mesh(ROUND_TIP_GEO, TIP_MAT)
      tip.layers.set(1)
      m.add(tip)
      this.magTilt.add(m)
      this.roundMeshes.push(m)
      this.roundHome.push(new THREE.Vector3(0, top - i * gap, 0.020))
    }
  }

  /**
   * 탄창을 빼 들 때의 몸통 기울임. **요(yaw) 는 여기서 건드리지 않는다** —
   * 총이 어느 쪽을 보는지는 setCant 하나가 정해야 단계마다 돌려 세울 수 있다.
   * (예전에는 여기서 +0.38 을 더해 좌우가 서로 상쇄됐다.)
   */
  private setGunPose(p: number): void {
    const q = THREE.MathUtils.clamp(p, 0, 1)
    this.posePresent = q
    this.parts.position.y = -0.055 * q
    this.parts.rotation.x = -0.018 + 0.13 * q
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
    if (t > 0) this.magSeated = false
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
      // **가장자리에서만** 운다. 시퀀서의 step 은 트윈이 t=1 에 닿은 뒤 fn(1) 을
      //   한 번 더 부르므로, 매번 울리면 장착음이 같은 프레임에 두 번 겹친다.
      if (!this.magSeated) {
        this.magSeated = true
        this.onSound('mag.seat')
      }
    }
  }

  /** 탄창이 물려 있는가 — 장착음을 한 번만 내기 위한 상태 */
  private magSeated = true

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

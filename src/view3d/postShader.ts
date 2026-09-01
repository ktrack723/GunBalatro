// ============================================================================
// postShader.ts — 풀스크린 포스트 합성 (EffectComposer 미사용)
//   TECH.md §3.1: 플래시·색수차·비네트·열왜곡·웜그레이딩을 프래그먼트 하나로 처리한다.
//   렌더타깃 1장 + 쿼드 1장. 패스 왕복이 없으므로 모바일 대역폭을 먹지 않는다.
//   view 레이어 전용 시드 PRNG 도 여기(의존성 없는 최하위 모듈)에 둔다.
// ============================================================================
import * as THREE from 'three'

// ---------------------------------------------------------------------------
// 연출 전용 PRNG — core/rng 와 절대 공유하지 않는다.
// 게임 로직 rng 스트림을 건드리면 결정론적 리플레이가 깨지기 때문에 별도 스트림을 쓴다.
// ---------------------------------------------------------------------------
export interface ViewRng {
  /** [0,1) */
  next(): number
  /** [a,b) 실수 */
  range(a: number, b: number): number
  /** [0,n) 정수 */
  int(n: number): number
  /** -1 또는 +1 */
  sign(): number
  pick<T>(arr: readonly T[]): T
}

/** mulberry32. core/rng.ts 와 알고리즘은 같지만 스트림은 완전히 분리되어 있다. */
export function makeViewRng(seed: number): ViewRng {
  let s = (seed >>> 0) || 0x9e3779b9
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (n) => Math.floor(next() * n),
    sign: () => (next() < 0.5 ? -1 : 1),
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T,
  }
}

/** 문자열 → 시드. 아키타입 id 등으로 결정론적 연출 변주를 만들 때 쓴다. */
export function viewSeedOf(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// 유니폼
// ---------------------------------------------------------------------------
export interface PostUniforms {
  uTex: { value: THREE.Texture | null }
  /** 0..1 백색 플래시 (additive) */
  uFlash: { value: number }
  /** 0..1 색수차 */
  uAber: { value: number }
  /** 0..1 가장자리 열왜곡 + 웜 그레이딩 */
  uHeat: { value: number }
  /** 0..1 비네트 */
  uVignette: { value: number }
  /** 전역 색조 (기본 1,1,1) */
  uTint: { value: THREE.Color }
  uTime: { value: number }
  uRes: { value: THREE.Vector2 }
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uFlash;
uniform float uAber;
uniform float uHeat;
uniform float uVignette;
uniform float uTime;
uniform vec3  uTint;
uniform vec2  uRes;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 선형 → sRGB (RT 는 선형으로 받아두고 여기서 한 번만 인코딩한다)
vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(0.4166667)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec2 uv = vUv;
  vec2 ar = vec2(max(uRes.x / max(uRes.y, 1.0), 0.0001), 1.0);
  vec2 c  = (uv - 0.5) * ar;
  float r = length(c) / length(0.5 * ar);      // 0=중앙 1=모서리
  float edge = smoothstep(0.35, 1.0, r);

  // --- 열 왜곡: 가장자리에서만 UV 를 흔든다 (PRESENTATION §2.2 t=250) ---
  if (uHeat > 0.002) {
    float n1 = vnoise(uv * vec2(7.0, 19.0) + vec2(0.0, uTime * 1.7));
    float n2 = vnoise(uv * vec2(11.0, 27.0) - vec2(uTime * 0.8, uTime * 2.4));
    uv += (vec2(n1, n2) - 0.5) * (0.014 * uHeat * edge);
  }

  // --- 색수차: 반경 방향 R/B 분리 ---
  vec3 col;
  float ab = uAber * (0.0016 + 0.0075 * edge);
  if (ab > 0.00002) {
    vec2 dir = normalize(uv - 0.5 + vec2(1e-5));
    col.r = texture2D(uTex, uv + dir * ab).r;
    col.g = texture2D(uTex, uv).g;
    col.b = texture2D(uTex, uv - dir * ab).b;
  } else {
    col = texture2D(uTex, uv).rgb;
  }

  // --- 웜 그레이딩 (성화 단계에서 화면 전역이 달아오른다) ---
  vec3 warm = col * vec3(1.20, 0.94, 0.74) + vec3(0.035, 0.012, 0.0) * uHeat;
  col = mix(col, warm, clamp(uHeat, 0.0, 1.0) * 0.8);

  col *= uTint;

  // --- 비네트 (어둠이 예산이다) ---
  col *= 1.0 - uVignette * smoothstep(0.28, 1.06, r);

  // --- 백색 플래시 ---
  col += vec3(uFlash);

  // 8bit 출력 밴딩 완화용 미세 디더 (어두운 게임이라 필수)
  vec3 outc = lin2srgb(col);
  float dither = (hash12(gl_FragCoord.xy + vec2(uTime * 61.0)) - 0.5) / 255.0;
  gl_FragColor = vec4(outc + dither, 1.0);
}
`

/**
 * 렌더타깃 텍스처를 화면에 합성하는 단일 쿼드.
 * 씬 그래프와 독립된 자체 ortho 카메라를 들고 있다.
 */
export class PostPass {
  readonly uniforms: PostUniforms
  readonly material: THREE.ShaderMaterial
  private readonly quadScene = new THREE.Scene()
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly geo: THREE.PlaneGeometry
  private readonly mesh: THREE.Mesh

  constructor() {
    this.uniforms = {
      uTex: { value: null },
      uFlash: { value: 0 },
      uAber: { value: 0 },
      uHeat: { value: 0 },
      uVignette: { value: 0.42 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTime: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) },
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    })
    this.material.toneMapped = false
    this.geo = new THREE.PlaneGeometry(2, 2)
    this.mesh = new THREE.Mesh(this.geo, this.material)
    this.mesh.frustumCulled = false
    this.quadScene.add(this.mesh)
  }

  setSize(w: number, h: number): void {
    this.uniforms.uRes.value.set(w, h)
  }

  /** 화면(기본 프레임버퍼)에 합성한다. */
  render(renderer: THREE.WebGLRenderer, tex: THREE.Texture): void {
    this.uniforms.uTex.value = tex
    renderer.setRenderTarget(null)
    renderer.render(this.quadScene, this.quadCam)
  }

  dispose(): void {
    this.geo.dispose()
    this.material.dispose()
  }
}

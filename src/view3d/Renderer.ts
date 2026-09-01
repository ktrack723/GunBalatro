// ============================================================================
// Renderer.ts — WebGLRenderer 설정 / DPR 캡 / 리사이즈 / 적응형 품질 / 컨텍스트 복구
//   씬은 렌더타깃 1장에 그린 뒤 postShader 쿼드로 화면에 합성한다 (EffectComposer 금지).
//   render(dt) 안에서 scene.update(dt) 까지 처리하므로 호출부는 이것만 돌리면 된다.
// ============================================================================
import * as THREE from 'three'
import { GameScene, FOG_COLOR } from './Scene'

export type Quality = 'high' | 'mid' | 'low'

interface QualityPreset {
  dprCap: number
  particles: number
  distortion: boolean
  halfFloat: boolean
  samples: number
}

const PRESETS: Record<Quality, QualityPreset> = {
  // halfFloat 는 전 품질에서 켠다. 8bit 선형 RT 는 이 정도로 어두운 씬에서
  // 밴딩이 '벽에 붙은 얼룩'처럼 크게 드러나고(포스트의 1/255 디더로는 못 가린다),
  // three 는 렌더타깃 출력을 항상 선형으로 인코딩하므로 sRGB 저장으로 피할 수도 없다.
  // 강등 시 DPR 이 함께 내려가므로 대역폭은 high(=DPR2·16F) 기준보다 항상 작다.
  high: { dprCap: 2.0, particles: 256, distortion: true, halfFloat: true, samples: 0 },
  mid: { dprCap: 1.5, particles: 96, distortion: true, halfFloat: true, samples: 0 },
  low: { dprCap: 1.25, particles: 0, distortion: false, halfFloat: true, samples: 0 },
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: GameScene

  private readonly canvas: HTMLCanvasElement
  private rt: THREE.WebGLRenderTarget
  private q: Quality = 'high'
  private dpr = 1
  private lost = false

  // 적응형 품질 측정 (TECH.md §3.2)
  private frames = 0
  private acc = 0
  private autoDone = false
  // 씬 렌더 직후의 계측 (포스트 쿼드가 info 를 덮어쓰기 전 값)
  private lastCalls = 0
  private lastTris = 0

  private readonly onLost: (e: Event) => void
  private readonly onRestored: () => void
  private readonly onResize: () => void

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    })
    this.renderer.shadowMap.enabled = false // 실시간 그림자 0
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 0.98
    this.renderer.setClearColor(FOG_COLOR, 1)
    this.renderer.autoClear = true

    this.rt = this.makeTarget(PRESETS.high)
    this.scene = new GameScene(this.renderer)

    this.onLost = (e: Event) => {
      e.preventDefault()
      this.lost = true
    }
    this.onRestored = () => {
      this.lost = false
      // 컨텍스트가 새로 생겼으므로 렌더타깃을 다시 만든다
      this.rt.dispose()
      this.rt = this.makeTarget(PRESETS[this.q])
      this.resize()
    }
    this.onResize = () => this.resize()

    canvas.addEventListener('webglcontextlost', this.onLost, false)
    canvas.addEventListener('webglcontextrestored', this.onRestored, false)
    window.addEventListener('resize', this.onResize)
    window.addEventListener('orientationchange', this.onResize)
    window.visualViewport?.addEventListener('resize', this.onResize)
    window.visualViewport?.addEventListener('scroll', this.onResize)

    this.setQuality('high')
    this.resize()
  }

  private makeTarget(p: QualityPreset): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      // 어두운 씬이라 8bit 선형 저장은 밴딩이 눈에 띈다 → 고품질에서는 half-float
      type: p.halfFloat && this.supportsHalfFloat() ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      samples: p.samples,
    })
    rt.texture.colorSpace = THREE.NoColorSpace // 선형 저장 → post 에서 한 번만 인코딩
    rt.texture.generateMipmaps = false
    return rt
  }

  private supportsHalfFloat(): boolean {
    const gl = this.renderer.getContext()
    const isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext
    if (isGL2) return this.renderer.extensions.has('EXT_color_buffer_half_float') || this.renderer.extensions.has('EXT_color_buffer_float')
    return false
  }

  // -------------------------------------------------------------------------
  get quality(): Quality {
    return this.q
  }

  get contextLost(): boolean {
    return this.lost
  }

  /**
   * 개발 오버레이용 계측 (TECH.md §7).
   * renderer.info 는 render() 마다 초기화되므로 '씬 렌더 직후' 값을 따로 붙잡아 둔다
   * (그러지 않으면 포스트 쿼드 1드로우콜만 보인다).
   */
  get stats(): { calls: number; triangles: number; dpr: number; quality: Quality } {
    return { calls: this.lastCalls, triangles: this.lastTris, dpr: this.dpr, quality: this.q }
  }

  setQuality(q: Quality): void {
    this.q = q
    const p = PRESETS[q]
    const wantHalf = p.halfFloat && this.supportsHalfFloat()
    const isHalf = this.rt.texture.type === THREE.HalfFloatType
    if (wantHalf !== isHalf || this.rt.samples !== p.samples) {
      this.rt.dispose()
      this.rt = this.makeTarget(p)
    }
    this.scene.fx.setParticleBudget(p.particles)
    this.scene.fx.setDistortionQuality(p.distortion)
    this.resize()
  }

  /** 첫 120프레임 측정 후 자동 강등 (강등만 한다 — 정보는 하나도 사라지지 않는다) */
  autoQualityTick(dt: number): void {
    if (this.autoDone || this.lost) return
    this.frames++
    if (this.frames <= 20) return // 워밍업 (셰이더 컴파일 구간) 제외
    this.acc += Math.min(dt, 0.2)
    if (this.frames < 140) return
    this.autoDone = true
    const avgMs = (this.acc / (this.frames - 20)) * 1000
    if (avgMs > 24) this.setQuality('low')
    else if (avgMs > 17.5) this.setQuality('mid')
  }

  // -------------------------------------------------------------------------
  /** visualViewport / orientationchange 대응. DPR 은 2 로 캡 */
  resize(): void {
    const vv = window.visualViewport
    let w = this.canvas.clientWidth
    let h = this.canvas.clientHeight
    if (!w || !h) {
      w = Math.round(vv?.width ?? window.innerWidth)
      h = Math.round(vv?.height ?? window.innerHeight)
    }
    w = Math.max(1, Math.round(w))
    h = Math.max(1, Math.round(h))

    this.dpr = Math.min(window.devicePixelRatio || 1, PRESETS[this.q].dprCap)
    this.renderer.setPixelRatio(this.dpr)
    this.renderer.setSize(w, h, false)
    this.rt.setSize(Math.max(1, Math.floor(w * this.dpr)), Math.max(1, Math.floor(h * this.dpr)))
    this.scene.resize(w, h)
    this.scene.fx.setPixelRatio(this.dpr)
  }

  render(dt: number): void {
    if (this.lost) return
    const d = Math.min(Math.max(dt, 0), 0.05)
    this.scene.update(d)
    this.renderer.setRenderTarget(this.rt)
    this.renderer.render(this.scene.root, this.scene.camera) // autoClear 가 RT 를 지운다
    this.lastCalls = this.renderer.info.render.calls
    this.lastTris = this.renderer.info.render.triangles
    this.scene.fx.post.render(this.renderer, this.rt.texture)
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    window.removeEventListener('resize', this.onResize)
    window.removeEventListener('orientationchange', this.onResize)
    window.visualViewport?.removeEventListener('resize', this.onResize)
    window.visualViewport?.removeEventListener('scroll', this.onResize)
    this.scene.dispose()
    this.rt.dispose()
    this.renderer.dispose()
  }
}

// ============================================================================
// Biome.ts — 지역의 **그림**. core/data/regions.ts 가 규칙을 정하고 여기서 색을 준다.
//
// 왜 팔레트를 따로 빼는가:
//   복도 지오메트리는 색이 전부 리터럴로 박혀 있었다(0x4a483f 벽, 0x3c3f42 바닥 …).
//   지역마다 그걸 갈아 끼우려면 400줄을 세 벌 복사해야 했다 — 그러면 기물 하나를
//   고칠 때마다 세 곳을 고쳐야 한다.
//   그래서 **형태는 한 벌, 색은 재사상(remap)** 으로 간다. 소품 색은 원래 값의
//   상대 명암만 남기고 지역 팔레트 안으로 다시 깔린다. 벽·바닥·천장처럼 화면을
//   지배하는 면만 직접 지정한다.
//
// 그 결과 세 지역이 같은 복도를 쓰면서도 전혀 다른 장소로 읽힌다:
//   강철 하복부 — 차갑고 어둡다. 손전등이 정보의 전부다.
//   노란 층계   — 밝다. 형광등이 꺼지지 않고 그림자가 없다 (백룸).
//   붉은 성소   — 검붉고 뜨겁다. 벽이 살이다.
// ============================================================================
import type { RegionId } from '../core/data/regions'
import type { CorridorKind } from './CorridorStreamer'

/** 복도 껍데기 — 화면의 대부분을 차지하므로 직접 지정한다 */
export interface ShellPalette {
  floor: number
  ceil: number
  wall: number
  /** 걸레받이 / 몰딩 */
  trim: number
}

/**
 * 소품 재사상.
 *   원래 색에서 **상대 명암만** 가져오고 색상·채도·명도 범위는 여기가 정한다.
 *   hueVar 는 원래 색상환 위치를 얼마나 남길지다 — 0 이면 단색 지역, 1 이면 원본.
 */
export interface PropRemap {
  hue: number
  hueVar: number
  /** 원본 채도에 곱하는 값 */
  sat: number
  /**
   * 원본이 무채색이어도 최소한 이만큼은 물든다.
   *   sat 만 있으면 회색 기물(철판·콘크리트)이 재사상 뒤에도 회색으로 남는다 —
   *   실기에서 노란 층계에 회색 패널이 떠서 지역이 두 개로 보였다.
   */
  satAdd: number
  lo: number
  hi: number
}

export interface Biome {
  id: RegionId
  shell: ShellPalette
  prop: PropRemap
  fog: { color: number; density: number }
  ambient: { color: number; intensity: number }
  /** 손전등 — 밝은 지역에서는 약하게 (있으나 마나 한 것이 그 지역의 성격이다) */
  torch: { color: number; combat: number; travel: number }
  /**
   * 천장 형광등. 0 이면 없다.
   *   백룸의 정체는 노란 벽지가 아니라 **꺼지지 않는 형광등**이다 — 도망칠 어둠이
   *   없다는 것. 그래서 이건 색이 아니라 별도 발광 메시로 넣는다.
   */
  lamp: number
  /** 문틈 빛 세기 배율 */
  doorGlow: number
  /** 이 지역에서 뽑는 복도 종류 */
  kinds: readonly CorridorKind[]
}

// ---------------------------------------------------------------------------
const UNDERCROFT: Biome = {
  id: 'undercroft',
  shell: { floor: 0x373c41, ceil: 0x1f2428, wall: 0x424a50, trim: 0x2b3237 },
  prop: { hue: 203, hueVar: 0.55, sat: 0.5, satAdd: 0.1, lo: 0.06, hi: 0.44 },
  fog: { color: 0x06070a, density: 0.046 },
  ambient: { color: 0x2b3f56, intensity: 0.66 },
  torch: { color: 0xffe7c6, combat: 62, travel: 34 },
  lamp: 0,
  doorGlow: 1,
  kinds: ['corridor', 'stair', 'pipe', 'office', 'garage'],
}

/**
 * 노란 층계 — 백룸.
 *   벽지·카펫·천장타일이 전부 한 계열의 노랑이고, 명도 차가 아주 작다.
 *   그 '납작함' 이 방향 감각을 지운다. 안개는 옅고 **밝다** — 멀리가 안 보이는 게
 *   아니라 멀리도 똑같이 생겼다.
 */
const YELLOW: Biome = {
  id: 'yellow',
  shell: { floor: 0x8a7838, ceil: 0xd6cb92, wall: 0xc2ac41, trim: 0x8e7c2c },
  prop: { hue: 47, hueVar: 0.18, sat: 0.42, satAdd: 0.3, lo: 0.34, hi: 0.80 },
  fog: { color: 0xbcae74, density: 0.021 },
  ambient: { color: 0xfff0bc, intensity: 2.05 },
  torch: { color: 0xfff6dc, combat: 16, travel: 9 },
  lamp: 0xfffbe6,
  doorGlow: 0.55,
  kinds: ['office', 'corridor', 'stair', 'office', 'corridor'],
}

/**
 * 붉은 성소 — 만든 것이 아니다.
 *   명도 폭을 좁게, 아래로 눌러 둔다. 어두운데 **검지 않다** — 검은 것은 1지역이
 *   이미 가져갔으므로 여기는 '피가 고인 어둠' 이어야 구별된다.
 */
const SANCTUM: Biome = {
  id: 'sanctum',
  shell: { floor: 0x3d1416, ceil: 0x1d080a, wall: 0x5c1a1c, trim: 0x2e0d0f },
  prop: { hue: 3, hueVar: 0.22, sat: 0.6, satAdd: 0.34, lo: 0.07, hi: 0.42 },
  fog: { color: 0x120406, density: 0.055 },
  ambient: { color: 0x77202c, intensity: 0.92 },
  torch: { color: 0xffd0b0, combat: 58, travel: 30 },
  lamp: 0,
  doorGlow: 1.25,
  kinds: ['chapel', 'corridor', 'pipe', 'chapel', 'garage'],
}

export const BIOMES: Record<RegionId, Biome> = {
  undercroft: UNDERCROFT,
  yellow: YELLOW,
  sanctum: SANCTUM,
}

export const DEFAULT_BIOME = UNDERCROFT

// ---------------------------------------------------------------------------
// 재사상 — 원래 색의 상대 명암만 남기고 지역 팔레트로 다시 깐다
// ---------------------------------------------------------------------------
/** 원본 팔레트가 쓰는 명도 상한. 이 값으로 정규화해 지역의 [lo,hi] 로 편다 */
const SRC_LIGHT_TOP = 0.56

function rgbToHsl(hex: number): [number, number, number] {
  const r = ((hex >> 16) & 255) / 255
  const g = ((hex >> 8) & 255) / 255
  const b = (hex & 255) / 255
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  if (mx === mn) return [0, 0, l]
  const d = mx - mn
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
  let h = 0
  if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (mx === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h * 360, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t
  if (x < 0) x += 1
  if (x > 1) x -= 1
  if (x < 1 / 6) return p + (q - p) * 6 * x
  if (x < 1 / 2) return q
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): number {
  const hh = (((h % 360) + 360) % 360) / 360
  if (s <= 0) {
    const v = Math.round(l * 255)
    return (v << 16) | (v << 8) | v
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const r = Math.round(hue2rgb(p, q, hh + 1 / 3) * 255)
  const g = Math.round(hue2rgb(p, q, hh) * 255)
  const b = Math.round(hue2rgb(p, q, hh - 1 / 3) * 255)
  return (r << 16) | (g << 8) | b
}

/**
 * 소품 색 하나를 지역 팔레트로 옮긴다.
 *   ① 명도: 원본의 상대 밝기를 [lo,hi] 로 편다 — 어디가 밝고 어두운지는 지킨다.
 *   ② 색상: 지역 기준 색상에서 원본 색상 편차만큼만 흔든다 (hueVar).
 *   ③ 채도: 지역이 정한다.
 */
export function remapProp(hex: number, b: Biome): number {
  const [h, s, l] = rgbToHsl(hex)
  const t = Math.min(1, Math.max(0, l / SRC_LIGHT_TOP))
  const nl = b.prop.lo + t * (b.prop.hi - b.prop.lo)
  // 원본 색상은 대부분 20~60도(녹/황토)에 몰려 있다. 그 중심에서의 편차만 남긴다
  const dev = ((h - 40 + 540) % 360) - 180
  const nh = b.prop.hue + dev * b.prop.hueVar
  const ns = Math.min(1, s * b.prop.sat + b.prop.satAdd)
  return hslToRgb(nh, Math.max(0, ns), nl)
}

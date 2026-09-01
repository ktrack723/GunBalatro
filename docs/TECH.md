# 기술 설계 — three.js / iOS Safari / GitHub Pages

---

## 1. 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 언어 | **TypeScript** | 카드/부착물 효과가 유니온 타입 + discriminated union으로 안전하게 표현됨 |
| 번들러 | **Vite** | 정적 빌드, `base` 옵션으로 GitHub Pages 하위 경로 대응 |
| 3D | **three.js (r16x, WebGL2)** | 요구사항 |
| UI | **순수 DOM + CSS** (프레임워크 없음) | iOS에서 텍스트/버튼 렌더링·접근성이 캔버스 UI보다 압도적으로 우수. 번들 크기 절감 |
| 상태 | 자체 유한상태기계 + 불변 스냅샷 | 되돌리기·리플레이·저장이 전부 공짜로 따라옴 |
| 애니메이션 | 자체 tween (rAF 기반) | GSAP 등 외부 의존 불필요. 타임라인이 §PRESENTATION 표와 1:1 |
| 오디오 | WebAudio API | iOS 무음 스위치/자동재생 정책 직접 제어 필요 |
| 테스트 | Vitest | **전투 시뮬레이터는 렌더링 없이 헤드리스로 검증** |

> **UI를 DOM으로 하는 것이 이 프로젝트의 가장 중요한 기술 결정이다.**
> 트레이/탄창/툴팁은 전부 DOM. 3D 캔버스는 그 뒤에 깔린다.
> 덕분에 폰트 렌더링, safe-area, VoiceOver, 텍스트 선택 방지, 드래그 제스처가 전부 표준 웹 방식으로 해결된다.

---

## 2. 아키텍처 — 규칙과 렌더링의 완전 분리

```
src/
├─ core/                     ← 순수 로직. three.js·DOM 의존 0
│  ├─ rng.ts                 mulberry32 시드 RNG (결정론적 리플레이)
│  ├─ types.ts               Ammo, Attachment, Magazine, Enemy, RunState
│  ├─ data/
│  │   ├─ ammo.ts            §BALANCE §1 표를 그대로 코드화
│  │   ├─ attachments.ts     56종 정의 (효과는 순수 함수)
│  │   ├─ magazines.ts       10종
│  │   ├─ enemies.ts         아키타입 5 + 패시브 10
│  │   └─ events.ts          이벤트 6종
│  ├─ pipeline.ts            ★ 데미지 파이프라인 7스텝 (GDD §4)
│  ├─ combat.ts              전투 상태기계 (장전/사격/배출/승패)
│  ├─ run.ts                 섹터·노드·갈림길·보상 생성
│  └─ economy.ts             탄피 수입/지출
│
├─ view3d/                   ← three.js
│  ├─ Renderer.ts            WebGLRenderer 설정, DPR 캡, 리사이즈
│  ├─ CorridorStreamer.ts    모듈러 복도 조립 + 오브젝트 풀
│  ├─ RailCamera.ts          스플라인 이동 + 보행 노이즈
│  ├─ GunRig.ts              총 모델, 반동, 온도 이미시브 램프
│  ├─ EnemyRig.ts            좀비 인스턴스, 거리→위치 매핑, 히트 리액션
│  ├─ Fx.ts                  머즐 플래시, 트레이서, 스파크, 풀스크린 플래시 쿼드
│  └─ Shake.ts               카메라 셰이크
│
├─ ui/                       ← DOM
│  ├─ Hud.ts                 HP·거리·온도 게이지
│  ├─ Tray.ts                트레이 카드 + 탭/드래그 제스처
│  ├─ MagazineStrip.ts       장전 슬롯 + 실시간 예상 피해
│  ├─ Screens/               타이틀·보상방·정비소·이벤트·결과
│  └─ Settings.ts            접근성 옵션
│
├─ sequencer/
│  └─ FireSequence.ts        ★ PRESENTATION §2 타임라인을 그대로 구현
│                              core가 만든 "이벤트 로그"를 재생만 한다
└─ main.ts
```

### 2.1 핵심 원칙: `core`는 렌더링을 모른다

`combat.fire(magazine)` 은 즉시 전체 결과를 계산하고 **이벤트 로그 배열**을 반환한다.

```ts
type FireEvent =
  | { t: 'shot';     index: number; ammo: Ammo; dmg: number; heatBefore: number;
      heatAfter: number; damage: number; triggered: AttachmentId[] }
  | { t: 'knockback'; meters: number }
  | { t: 'notConsumed'; index: number }
  | { t: 'enemyDead';  overkill: number }
  | { t: 'magEnd';     heatCarried: number }
```

`FireSequence`는 이 로그를 받아 **연출로 번역**할 뿐이다. 이 분리의 이득:

1. **헤드리스 밸런싱** — 10만 판 시뮬레이션을 브라우저 없이 Node에서 초 단위로 돌린다.
2. **연출 속도 ×1/×2/×3/즉시**가 로직에 전혀 영향을 주지 않는다.
3. **실시간 예상 피해**(PRESENTATION §4)를 같은 함수로 계산하므로 예측과 실제가 절대 어긋나지 않는다.
4. 앱이 백그라운드로 가도 전투 결과가 이미 확정되어 있어 상태 꼬임이 없다.

### 2.2 부착물 효과의 표현

GDD §7.2의 "동사 8 × 조건 11" 문법을 그대로 데이터로 쓴다.

```ts
interface Attachment {
  id: string; slot: 'barrel'|'handguard'|'optic'|'stock'|'rail';
  rarity: 'common'|'uncommon'|'rare'|'relic';
  hooks: {
    onFire?:   (ctx: FireCtx) => void;   // dmg/heat 가산
    onAfterShot?: (ctx: FireCtx) => void;
    onMagStart?: (ctx: MagCtx) => void;
    onCombatStart?: (ctx: CombatCtx) => void;
    onCombatEnd?: (ctx: CombatCtx) => void;
  };
  text: string;   // 툴팁. 반드시 한 줄
}
```

훅은 5개뿐이고 전부 **동기 · 부작용은 ctx에만**. 새 부착물 추가 = 데이터 한 덩어리 추가.

---

## 3. 성능 예산 (기준: iPhone 12 / Safari / 60fps)

| 항목 | 예산 | 근거 |
|---|---|---|
| 드로우 콜 | **≤ 60** | 어두운 씬이라 대부분 컬링됨. 복도 모듈은 머티리얼 병합 |
| 삼각형 | **≤ 45,000** | 복도 25k + 좀비 6k×2 + 총 8k |
| 텍스처 | **≤ 1024²**, 총 12MB (KTX2/Basis 압축) | iOS 메모리 한계 |
| 실시간 그림자 | **0** | 전부 베이크 + 손전등 원뿔 페이크 |
| 동적 광원 | **2** (손전등 1 + 머즐 플래시 1) | 나머지는 emissive |
| 포스트프로세싱 | **없음** | EffectComposer 대신 **풀스크린 쿼드 1장**으로 플래시·색수차·비네트·열왜곡을 한 셰이더에 통합 |
| DPR | **min(devicePixelRatio, 2)**, 저사양 감지 시 1.5 | 픽셀 수가 iOS GPU의 1차 병목 |
| 파티클 | Points 1개 인스턴스, 최대 256 | 개별 Mesh 금지 |
| 번들 (gzip) | **≤ 900KB** (three.js ~600KB 포함) | 3G에서도 5초 내 |
| 에셋 총량 | **≤ 15MB** | GitHub Pages 소프트 한계 대비 여유 |

### 3.1 단일 포스트 셰이더

플래시 · 색수차 · 비네트 · 열 왜곡 · 웜 그레이딩을 **하나의 프래그먼트 셰이더 uniform 5개**로 처리한다.
EffectComposer 체인(패스마다 풀스크린 렌더타깃 왕복)은 모바일 GPU 대역폭을 그대로 잡아먹으므로 쓰지 않는다.

```glsl
uniform float uFlash;    // 0..1  백색 플래시
uniform float uAber;     // 0..1  색수차
uniform float uHeat;     // 0..1  가장자리 열왜곡 + 웜 그레이딩
uniform float uVignette;
uniform vec3  uTint;
```

### 3.2 적응형 품질

첫 120프레임의 평균 프레임타임을 측정해 3단계로 자동 강등한다.
`고: DPR 2 + 파티클 256 + 열왜곡` → `중: DPR 1.5 + 파티클 96` → `저: DPR 1.25 + 파티클 0 + 열왜곡 off`.
수동 오버라이드 가능. **강등되어도 게임 정보는 하나도 사라지지 않는다** (연출 강도만 변함).

### 3.3 로딩 은폐

온레일 이동 8~15초 동안 다음 전투의 좀비 지오메트리/텍스처를 스트리밍한다.
초기 로드는 **타이틀 화면에 필요한 것만**(< 2MB), 나머지는 첫 이동 구간에서 프리페치.

---

## 4. iOS Safari 세로 모드 대응 (필수 체크리스트)

| 이슈 | 대응 |
|---|---|
| 주소창 개폐로 `100vh`가 튐 | **`100dvh`** 사용 + `visualViewport` resize 리스너로 캔버스 재계산 |
| 노치·홈 인디케이터 | 루트에 `env(safe-area-inset-*)` 패딩, `viewport-fit=cover` |
| 당겨서 새로고침 / 바운스 | `body { overscroll-behavior: none; }`, 게임 루트에 `touch-action: none` |
| 더블탭 확대 | `<meta name="viewport" ... user-scalable=no>` + `touch-action: manipulation` |
| 텍스트 선택 / 롱프레스 메뉴 | `-webkit-user-select: none; -webkit-touch-callout: none;` |
| 오디오 자동재생 차단 | 첫 **터치 이벤트 핸들러 안에서** `AudioContext.resume()` — 타이틀 "시작" 탭 시 |
| 무음 스위치로 소리 안 남 | WebAudio는 무음 스위치 영향을 받음. 설정에 안내 문구 노출 |
| 백그라운드 진입 시 컨텍스트 손실 | `visibilitychange` → rAF 정지 + 상태 저장. 복귀 시 WebGL 컨텍스트 복구 핸들러 |
| 저전력 모드 시 30fps 캡 | 프레임타임 기준 적응형 품질이 자동 대응 |
| 홈 화면 추가(PWA) | `manifest.json` + `apple-touch-icon` + `display: standalone` |
| 세로↔가로 회전 | 레이아웃 2종 모두 지원. 회전 시 3D 씬 유지, DOM만 재배치 |
| 햅틱 | `navigator.vibrate`는 iOS 미지원 → **Web Haptics 미지원 시 무시** (조용히 실패, 안내 없음) |
| iOS 15 이하 | WebGL2 미지원 기기 대비 `WebGL1 폴백` 또는 안내 화면 |

### 4.1 터치 제스처 규칙

- 모든 탭 타겟 **최소 44×44pt** (iOS HIG).
- 드래그(탄 순서 재배치)는 `pointerdown/move/up` + `setPointerCapture`. 8px 임계값 넘어야 드래그로 판정.
- **하단 12pt 영역에는 조작 요소를 두지 않는다** (홈 인디케이터 스와이프 충돌).
- 3D 뷰포트는 전투 중 터치를 받지 않는다 (오조작 방지). 이동 구간에서만 홀드=가속 / 더블탭=스킵.

---

## 5. 저장 · 시드

```ts
// localStorage 키
'gb.run'      : RunState 스냅샷 (노드 단위 저장, JSON ≈ 4KB)
'gb.meta'     : 해금·성전 등급·통계
'gb.settings' : 접근성/연출 옵션
```

- **노드 단위 저장**: 전투 도중 저장하지 않는다. 앱이 죽으면 그 전투 시작 시점으로 복구.
  (전투 중 저장을 허용하면 "죽기 직전에 앱 종료" 악용이 가능하다.)
- **시드 런**: URL 해시 `#seed=XXXX` 로 동일한 런 재현. 모든 무작위는 `mulberry32(seed)` 단일 스트림에서 나온다.
  → 친구와 같은 판 경쟁, 버그 재현, 리플레이가 전부 공짜.
- 스키마 버전 필드 포함. 버전 불일치 시 진행 중 런만 폐기하고 메타는 마이그레이션.

---

## 6. GitHub Pages 배포

### 6.1 Vite 설정

```ts
// vite.config.ts
export default defineConfig({
  base: '/GunBalatro/',            // 프로젝트 페이지 하위 경로
  build: { target: 'es2020', assetsInlineLimit: 4096,
           rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
})
```

### 6.2 Actions 워크플로 (`.github/workflows/deploy.yml`)

```yaml
name: Deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run test        # 헤드리스 밸런스 시뮬 포함
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    runs-on: ubuntu-latest
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

### 6.3 정적 호스팅 제약과 대응

| 제약 | 대응 |
|---|---|
| 서버 없음 | 전부 클라이언트. 랭킹은 초기 범위 밖 (필요 시 나중에 외부 API) |
| SPA 라우팅 | 라우팅을 쓰지 않는다. 단일 페이지 + 해시 파라미터만 |
| 캐시 | Vite 해시 파일명. `index.html`만 `no-cache` |
| COOP/COEP 헤더 불가 | SharedArrayBuffer / 멀티스레드 사용 불가 → 애초에 필요 없게 설계 |
| 대용량 에셋 | 15MB 이내 유지. 리포 용량 문제 시 릴리스 에셋 + fetch도 가능 |

---

## 7. 테스트 전략

| 종류 | 대상 | 도구 |
|---|---|---|
| 단위 | `pipeline.ts` 7스텝 순서, 부착물 56종 각각의 훅 | Vitest |
| 회귀 | BALANCE §7 시뮬레이션 4건이 **표의 값과 정확히 일치**하는지 | Vitest 스냅샷 |
| 몬테카를로 | 시드 10,000개 × 자동 플레이 봇 → 섹터별 생존률 곡선 | Node 스크립트 |
| 성능 | 프레임타임 히스토그램, 드로우콜 카운터 (개발 오버레이) | 자체 계측 |
| 실기 | iPhone SE(작은 화면) / iPhone 15 Pro / iPad 세로 | 수동 |

### 자동 플레이 봇
탄창 배열은 **모든 순열이 아니라 휴리스틱**(온도 획득 오름차순 → 데미지 내림차순 꼬리)으로 평가한다.
CAP 8이면 8! = 40,320이라 전수 탐색도 가능하지만, 봇은 **"평범한 플레이어"를 모사해야** 밸런싱에 의미가 있다.
→ 봇 2종: `greedy`(휴리스틱) / `optimal`(전수). 두 곡선의 간격이 곧 **숙련도가 벌어주는 여유**이며,
이 간격이 섹터가 올라갈수록 커져야 한다. (커지지 않으면 게임에 배울 것이 없다는 뜻)

---

## 8. 개발 마일스톤

| M | 목표 | 산출물 | 완료 기준 |
|---|---|---|---|
| **M0** | 규칙 검증 | `core/` 전체 + Node 시뮬레이터, 렌더링 없음 | BALANCE §7 4건 일치, 봇 생존률 곡선 확보 |
| **M1** | 전투 플레이어블 | DOM UI + 최소 3D(총·좀비·단색 복도) | 한 전투를 폰에서 끝까지 플레이 |
| **M2** | 연출 | FireSequence 전체 타임라인, 온도 램프, 셰이더 | PRESENTATION §2 표대로 동작 |
| **M3** | 런 구조 | 섹터·갈림길·보상방·정비소·이벤트·저장 | 섹터 8까지 완주 가능 |
| **M4** | 콘텐츠 | 부착물 56 + 탄창 10 + 패시브 10 전부 | 전 항목 단위 테스트 통과 |
| **M5** | 최적화·접근성 | 적응형 품질, 접근성 옵션, PWA | iPhone 12에서 60fps, 광과민성 옵션 검증 |
| **M6** | 밸런싱 | 몬테카를로 기반 수치 조정, 성전 등급 8단계 | 등급1 승률 ~35%, 등급8 승률 ~3% |

> **M0을 먼저 하는 것이 이 프로젝트의 핵심 전략이다.**
> 이 게임의 재미는 전적으로 수학에서 나온다. 3D를 먼저 만들면 재미없는 수학을 예쁘게 포장하게 된다.
> 렌더링 없이 텍스트로만 플레이해서 재미있어야, 그 위에 얹은 연출이 의미를 갖는다.

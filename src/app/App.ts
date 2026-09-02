// ============================================================================
// App.ts — 앱 상태기계
//   boot → title → [ travel → doors → travel → combat → reward ] × 노드 → result
//
//   이 파일이 core 를 호출하는 유일한 곳이다. 화면(ui/screens)·전투 UI(ui/CombatView)·
//   연출(sequencer)·3D(view3d) 를 잇기만 하고, 규칙은 하나도 다시 쓰지 않는다.
//   3D 가 없어도(WebGL 실패·저사양) 전 흐름이 그대로 돈다 — scene 은 전부 옵셔널이다.
// ============================================================================
import type {
  Round,
  SlotKind,
  CombatState,
  DoorOption,
  EnemyInstance,
  FireEvent,
  NodeKind,
  RunState,
  Threat,
} from '../core/types'
import {
  advanceNode,
  applyReward,
  armoryStock,
  consumeCombatMods,
  currentNode,
  enterDoor,
  newRun,
  reliquaryStock,
  rollDoors,
  rollRewards,
  runRng,
} from '../core/run'
import { fire, startCombat } from '../core/combat'
import { combatBrass, skipRewardBrass } from '../core/economy'
import { pickDerelict } from '../core/data/events'

import { hasSave, loadRun, saveRun } from '../ui/save'
import {
  distortIntensity,
  flashIntensity,
  haptic,
  shakeIntensity,
  speedFactor,
  subscribeSettings,
} from '../ui/settings'
import { toast } from '../ui/toast'
import { add, el, on } from '../ui/dom'
import { CombatView, showSwapSheet } from '../ui/CombatView'
import { showTitle } from '../ui/screens/TitleScreen'
import { showDoors } from '../ui/screens/DoorScreen'
import { showRewards } from '../ui/screens/RewardScreen'
import { showArmory } from '../ui/screens/ArmoryScreen'
import { showDerelict } from '../ui/screens/DerelictScreen'
import { deathCause, showResult } from '../ui/screens/ResultScreen'
import { showSettings } from '../ui/screens/SettingsScreen'
import { showLoadout } from '../ui/screens/LoadoutSheet'

import type { SeqDeps } from '../sequencer/FireSequence'
import { playEjectSequence, playFireSequence } from '../sequencer/FireSequence'
import { killTweens, setFxSeed } from '../sequencer/tween'

import type { GameRenderer } from '../view3d/Renderer'
import type { GameScene } from '../view3d/Scene'
import type { CorridorKind } from '../view3d/CorridorStreamer'
import { makeViewRng, viewSeedOf, type ViewRng } from '../view3d/postShader'

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 이동 구간 길이 (PRESENTATION §5) */
const TRAVEL_MIN = 8
const TRAVEL_MAX = 15
/** 문을 열고 들어가는 짧은 구간 */
const DOOR_TRAVEL = 3.6
/** 포스트 셰이더 비네트 기본값 (PostPass 생성자와 같은 값 — '어둠이 예산이다') */
const BASE_VIGNETTE = 0.42
/** 전투 노드에서 고를 복도 종류 (core 에 NodeKind→CorridorKind 매핑이 없어 view 가 정한다) */
const COMBAT_KINDS: readonly CorridorKind[] = ['corridor', 'stair', 'pipe', 'office', 'garage']

/** 사운드 훅 (아직 소리는 없다. 첫 터치에서 resume 만 해 둔다) */
export interface AudioHook {
  resume(): void
  play(id: string): void
}

export interface AppOptions {
  ui: HTMLElement
  canvas: HTMLCanvasElement
  renderer: GameRenderer | null
  audio: AudioHook
}

/** 마지막 이동 비용 — 즉사 사인 문장에 쓴다 */
interface LastMove {
  before: number
  cost: number
}

function lastMoveOf(events: readonly FireEvent[]): LastMove {
  let before = 0
  let cost = 0
  for (const ev of events) {
    if (ev.t === 'advance') {
      cost = ev.meters
      before = ev.distanceAfter + ev.meters
    }
  }
  return { before, cost }
}

/** 함수를 거쳐 읽어 타입 좁힘이 남지 않게 한다 (advanceNode 가 status 를 바꾼다) */
function statusOf(r: RunState): RunState['status'] {
  return r.status
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

/** 새 런 시드 — Math.random 을 쓰지 않는다 (TECH §5: 모든 무작위는 시드에서 나온다) */
function freshSeed(): number {
  const t = Date.now()
  const p = Math.floor((typeof performance !== 'undefined' ? performance.now() : 0) * 1000)
  return (t ^ (p * 2654435761)) | 0
}

/** URL 해시의 #seed=XXXX (문자열이면 해시). 없으면 null */
function seedFromHash(): number | null {
  const m = /(?:^#|[#&])seed=([^&]+)/.exec(location.hash)
  if (m === null) return null
  const raw = decodeURIComponent(m[1]).trim()
  if (raw === '') return null
  if (/^-?\d+$/.test(raw)) return Number(raw) | 0
  return viewSeedOf(raw) | 0
}

// ---------------------------------------------------------------------------

export class App {
  private readonly ui: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly r: GameRenderer | null
  private readonly scene: GameScene | null
  private readonly audio: AudioHook

  private run: RunState | null = null
  private combat: CombatState | null = null
  private view: CombatView | null = null

  /** 전투 종료를 기다리는 resolve (승/패) */
  private endCombat: ((o: 'win' | 'lose') => void) | null = null
  /** 사격/배출 연출이 도는 동안 true */
  private acting = false
  private lastMove: LastMove = { before: 0, cost: 0 }

  /** 이번 런에서 이미 본 폐허 이벤트 */
  private readonly seenEvents = new Set<string>()

  /** rAF 프레임마다 호출되는 대기 훅 (이동 구간 종료 감시 등) */
  private readonly frameHooks = new Set<(dt: number) => void>()

  private travelOverlay: HTMLElement | null = null
  private travelOffs: Array<() => void> = []
  private devBox: HTMLElement | null = null
  private devT = 0
  private devN = 0

  private booted = false
  /** 결과 화면에서 [다시 시작] 을 골랐는가 */
  private restartWanted = false

  constructor(o: AppOptions) {
    this.ui = o.ui
    this.canvas = o.canvas
    this.r = o.renderer
    this.scene = o.renderer !== null ? o.renderer.scene : null
    this.audio = o.audio

    // 설정 → 연출 강도. 시퀀서는 Fx 가 스스로 강도를 적용하면 중복 적용하지 않는다.
    this.applyFxSettings()
    subscribeSettings(() => this.applyFxSettings())

    // 사운드 훅 (현재 no-op)
    if (this.scene !== null) {
      this.scene.gun.onSound = (id: string): void => this.audio.play(id)
      // 총 구도: 기본값(0.26 / -0.60 / 0.62m)은 총이 뷰포트 절반을 덮어 적을 가린다.
      // 더 멀리(1.0m) · 더 아래(-0.72)로 밀어 '보이는 영역 하단 25%에 걸친 실루엣'으로 만든다.
      // 실기 캡처 기준 재조정: 총이 뷰포트 중앙까지 올라와 적을 가리고,
      // 광각 절두체 가장자리라 심하게 기울어 보였다. 더 오른쪽·아래·멀리로 민다.
      this.scene.setGunAnchor(0.56, -0.88, 1.18)
    }

    if (location.hash.includes('dev')) this.mountDevOverlay()
  }

  // =========================================================================
  // 프레임 (main 의 rAF 가 부른다)
  // =========================================================================

  frame(dt: number): void {
    for (const h of Array.from(this.frameHooks)) h(dt)
    if (this.devBox !== null) this.updateDev(dt)
  }

  /** 화면 크기가 바뀌었다 (visualViewport / orientationchange) */
  onResize(): void {
    this.syncInsets()
  }

  /** 백그라운드 진입 — rAF 는 main 이 멈춘다. 여기선 저장만 (전투 중 저장 금지) */
  onHidden(): void {
    const run = this.run
    if (run === null || statusOf(run) !== 'alive') return
    if (this.combat !== null) return // TECH §5 — 전투 도중에는 저장하지 않는다
    saveRun(run)
  }

  // =========================================================================
  // 진입점
  // =========================================================================

  async boot(): Promise<void> {
    if (this.booted) return
    this.booted = true
    for (;;) {
      let run = await this.titleScreen()
      if (run === null) continue
      // 결과 화면의 [다시 시작] 은 재귀가 아니라 이 루프로 돌아온다
      for (;;) {
        this.run = run
        this.seenEvents.clear()
        setFxSeed(run.seed) // 연출용 난수 고정 (core rng 와 완전히 분리)
        let again = false
        try {
          again = await this.runLoop(run)
        } catch (e) {
          console.error('[run]', e)
          toast('진행 중 오류가 났다. 타이틀로 돌아간다.')
        }
        this.teardownCombat()
        this.run = null
        if (!again) break
        run = newRun(freshSeed())
      }
    }
  }

  // =========================================================================
  // 타이틀
  // =========================================================================

  private async titleScreen(): Promise<RunState | null> {
    this.idleScene()
    const res = await showTitle(this.ui, { hasSave: hasSave() })
    this.audio.resume() // 첫 터치 안에서 (iOS 자동재생 정책, TECH §4)

    switch (res.action) {
      case 'settings':
        await showSettings(this.ui)
        this.applyFxSettings()
        return null
      case 'continue': {
        const r = loadRun()
        if (r !== null) return r
        toast('이어할 런이 없다')
        return null
      }
      case 'seed':
        return newRun(res.seed ?? freshSeed())
      case 'new':
      default: {
        const urlSeed = seedFromHash()
        if (urlSeed !== null) toast('시드 ' + urlSeed + ' 로 시작한다')
        return newRun(urlSeed ?? freshSeed())
      }
    }
  }

  // =========================================================================
  // 런 루프
  // =========================================================================

  /** true 를 돌려주면 "다시 시작"을 고른 것이다 */
  private async runLoop(run: RunState): Promise<boolean> {
    this.restartWanted = false
    for (;;) {
      if (statusOf(run) !== 'alive') break
      // 노드 경계 저장 (TECH §5). 여기가 복구 지점이다.
      saveRun(run)

      const node = currentNode(run)
      const alive = await this.playNode(run, node)
      if (!alive) return this.restartWanted // 즉사 → 결과 화면까지 이미 끝냈다

      advanceNode(run)
      if (statusOf(run) === 'won') {
        await this.finish(run, true, '적과 접촉하지 않고 섹터를 전부 넘어섰다.')
        return this.restartWanted
      }
      saveRun(run)
    }
    return this.restartWanted
  }

  /** 노드 하나. false 를 돌려주면 런이 끝난 것이다. */
  private async playNode(run: RunState, node: NodeKind): Promise<boolean> {
    if (node === 'combat') {
      const doors = rollDoors(run)
      await this.travel(run, node, 0, null)
      this.showDoorsIn3D(doors)
      const idx = await this.doorChoice(run, doors)
      this.scene?.corridor.hideDoors()
      const door = doors[idx] as DoorOption | undefined
      await this.travel(run, node, 1, door?.archetype ?? null, DOOR_TRAVEL)
      const r = enterDoor(run, idx)
      if (r.enemy === null) return true
      return await this.combatNode(run, r.enemy, r.threat)
    }

    if (node === 'boss') {
      await this.travel(run, node, 0, null)
      const r = enterDoor(run, 0)
      if (r.enemy === null) return true
      return await this.combatNode(run, r.enemy, r.threat)
    }

    // --- 상점 / 성소 / 폐허 ---
    await this.travel(run, node, 0, null)
    enterDoor(run, 0) // run.current 를 맞춰 준다 (적은 없다)
    this.idleScene()

    if (node === 'armory') {
      await showArmory(this.ui, run, '정비소', armoryStock(run))
    } else if (node === 'reliquary') {
      await showArmory(this.ui, run, '성소', reliquaryStock(run))
    } else {
      // 폐허: 화면이 opt.apply 를 이미 실행한다 → 호출부는 절대 다시 부르지 않는다
      const ev = pickDerelict(runRng(run), this.seenEvents)
      await showDerelict(this.ui, run, ev)
    }
    saveRun(run)
    return true
  }

  // =========================================================================
  // 이동 구간 (온레일)
  // =========================================================================

  private viewRng(run: RunState, salt: number): ViewRng {
    return makeViewRng(
      viewSeedOf(run.seed + ':' + run.sector + ':' + run.nodeIndex + ':' + salt) ^ 0x5bf03635,
    )
  }

  private kindFor(rng: ViewRng, node: NodeKind, leg: number): CorridorKind {
    if (node === 'boss') return 'chapel'
    if (node === 'reliquary') return 'chapel'
    if (node === 'armory') return 'garage'
    if (node === 'derelict') return 'office'
    if (leg === 1) return 'corridor'
    return rng.pick(COMBAT_KINDS)
  }

  private async travel(
    run: RunState,
    node: NodeKind,
    leg: number,
    hint: string | null,
    fixedSeconds?: number,
  ): Promise<void> {
    const sc = this.scene
    const rng = this.viewRng(run, leg)
    const base = fixedSeconds ?? rng.range(TRAVEL_MIN, TRAVEL_MAX)
    const sp = speedFactor()
    // 연출 속도 설정을 그대로 존중한다 (즉시 = 이동 생략)
    const secs = !Number.isFinite(sp) ? 0 : base / clamp(sp, 1, 3)

    if (sc === null || secs <= 0.05) {
      if (sc !== null) {
        sc.startTravel(rng.int(0x7fffffff), this.kindFor(rng, node, leg), 0.35, hint)
        sc.rail.skip()
      }
      return
    }

    sc.setViewportInsets(0, 0) // 이동 중에는 화면 전체가 복도다
    sc.startTravel(rng.int(0x7fffffff), this.kindFor(rng, node, leg), secs, hint)
    this.mountTravelOverlay(leg === 1 ? '문 안쪽으로' : '이동 중')
    await this.waitFrames(() => sc.rail.finished, secs * 4 + 8)
    this.unmountTravelOverlay()
  }

  /** 홀드=2배속 / 더블탭=스킵 / [건너뛰기] 버튼 (TECH §4.1) */
  private mountTravelOverlay(label: string): void {
    this.unmountTravelOverlay()
    const ov = el('div', 'travel-ov')
    ov.style.cssText =
      'position:absolute;inset:0;display:flex;flex-direction:column;' +
      'justify-content:space-between;align-items:stretch;background:transparent;'
    ov.setAttribute('aria-label', '이동 구간')

    const top = add(ov, 'div')
    top.style.cssText =
      'display:flex;justify-content:flex-end;padding:calc(var(--sat) + 10px) 12px 0;'
    const skip = add(top, 'button', 'btn ghost', '건너뛰기')
    skip.type = 'button'
    skip.style.cssText =
      'flex:0 0 auto;min-width:96px;min-height:44px;padding:0 14px;' +
      'background:rgba(15,17,20,.82);backdrop-filter:blur(2px);'

    const foot = add(ov, 'div')
    // 하단 12pt 는 홈 인디케이터 몫 — 여기에 조작요소를 두지 않는다
    foot.style.cssText =
      'padding:0 16px calc(var(--sab) + 34px);display:flex;flex-direction:column;gap:4px;' +
      'align-items:center;pointer-events:none;'
    const t1 = add(foot, 'div', undefined, label)
    t1.style.cssText =
      'font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--text);' +
      'text-shadow:0 2px 8px #000;'
    const t2 = add(foot, 'div', undefined, '누르고 있으면 2배속 · 두 번 두드리면 건너뛰기')
    t2.style.cssText = 'font-size:11px;color:var(--text-dim);text-shadow:0 2px 8px #000;'

    this.ui.appendChild(ov)
    this.travelOverlay = ov

    const rail = this.scene?.rail
    let lastTap = 0
    const offs = this.travelOffs
    offs.push(
      on<PointerEvent>(ov, 'pointerdown', (e) => {
        if (e.target === skip) return
        this.audio.resume()
        rail?.setSpeedMul(2)
        const now = performance.now()
        if (now - lastTap < 320) {
          rail?.skip()
          lastTap = 0
        } else {
          lastTap = now
        }
      }),
    )
    const up = (): void => rail?.setSpeedMul(1)
    offs.push(on(window, 'pointerup', up))
    offs.push(on(window, 'pointercancel', up))
    offs.push(
      on(skip, 'click', (e) => {
        e.stopPropagation()
        rail?.skip()
      }),
    )
  }

  private unmountTravelOverlay(): void {
    for (const off of this.travelOffs) off()
    this.travelOffs = []
    if (this.travelOverlay !== null) {
      this.travelOverlay.remove()
      this.travelOverlay = null
    }
    this.scene?.rail.setSpeedMul(1)
  }

  /** 조건이 참이 될 때까지 프레임을 흘려보낸다 (최대 maxSec) */
  private waitFrames(pred: () => boolean, maxSec: number): Promise<void> {
    if (pred()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let acc = 0
      const hook = (dt: number): void => {
        acc += dt
        if (!pred() && acc < maxSec) return
        this.frameHooks.delete(hook)
        resolve()
      }
      this.frameHooks.add(hook)
    })
  }

  // =========================================================================
  // 갈림길
  // =========================================================================

  private showDoorsIn3D(doors: DoorOption[]): void {
    const a = doors[0]
    const b = doors[1] ?? doors[0]
    if (a === undefined) return
    this.scene?.corridor.showDoors([a.threat, b.threat])
  }

  private async doorChoice(run: RunState, doors: DoorOption[]): Promise<number> {
    const p = showDoors(this.ui, run, doors)
    // 복도 끝의 실제 문 2개가 선택지 뒤로 비쳐 보이게 한다 (.screen 은 기본이 거의 불투명)
    const sc = this.ui.querySelector<HTMLElement>('.screen[aria-label="갈림길"]')
    if (sc !== null) {
      // 위/아래(글자 영역)는 진하게, 가운데 빈 구간만 열어 문 2개가 비쳐 보이게 한다
      sc.style.background =
        'linear-gradient(180deg, rgba(6,7,9,.93) 0%, rgba(6,7,9,.93) 34%,' +
        ' rgba(6,7,9,.42) 46%, rgba(6,7,9,.42) 70%, rgba(6,7,9,.9) 82%, rgba(6,7,9,.96) 100%)'
    }
    const idx = await p
    return clamp(Math.floor(idx), 0, Math.max(0, doors.length - 1))
  }

  // =========================================================================
  // 전투
  // =========================================================================

  private async combatNode(
    run: RunState,
    enemy: EnemyInstance,
    threat: Threat,
  ): Promise<boolean> {
    const mods = consumeCombatMods(run)
    const s = startCombat(run.loadout, enemy, runRng(run), mods)
    this.combat = s
    this.lastMove = { before: s.distance, cost: s.fireCost }

    const view = new CombatView(this.ui, {
      onFire: (plan: Round[]) => void this.doFire(plan),
      onOpenRack: (slot, railIndex) => void this.openRack(slot, railIndex),
    })
    this.view = view
    view.render(s)
    this.syncInsets()

    const sc = this.scene
    if (sc !== null) {
      sc.setMode('combat')
      sc.setZoom(1)
      sc.fx.clearScreenEffects()
      sc.fx.setVignette(BASE_VIGNETTE)
      sc.fx.setTint(1, 1, 1)
      sc.enemy.spawn(enemy.bodyCount, enemy.archetype.id)
      sc.enemy.setDistance(s.distance, enemy.startDist, false)
      sc.gun.resetHeat(s.heat)
    }

    const outcome = await new Promise<'win' | 'lose'>((resolve) => {
      this.endCombat = resolve
    })
    this.endCombat = null
    this.absorbStats(run, s)

    if (outcome === 'win') {
      const brass = combatBrass(s, threat)
      run.loadout.brass += brass
      run.stats.brassEarned += brass
      run.stats.combatsWon += 1
      this.teardownCombat()
      await this.rewardRoom(run, threat, brass)
      return true
    }

    // 즉사
    run.status = 'dead'
    const cause = deathCause(this.lastMove.before, this.lastMove.cost)
    this.teardownCombat()
    await this.finish(run, false, cause)
    return false
  }

  private seqDeps(view: CombatView): SeqDeps {
    return {
      view,
      // 3D 가 없으면 빈 객체를 넘긴다 — 시퀀서의 브리지가 DOM 폴백으로 떨어진다
      scene: (this.scene ?? {}) as GameScene,
      speed: () => speedFactor(),
      flashIntensity: () => flashIntensity(),
      shakeIntensity: () => shakeIntensity(),
      haptic: (kind) => haptic(kind === 'heavy' ? 24 : 10),
    }
  }

  /**
   * 전투 중 부착물 교체 — 사격 전이면 언제든 가능하다.
   * 교체 후 파생값(용량·비용)이 바뀌므로 화면을 통째로 다시 그린다.
   */
  private async openRack(slot: SlotKind, railIndex?: number): Promise<void> {
    const s = this.combat
    const view = this.view
    if (s === null || view === null || this.acting) return
    const changed = await showSwapSheet(this.ui, s, slot, railIndex)
    if (changed) {
      view.render(s)
      this.syncInsets()
      toast('부착물을 교체했다')
    }
  }

  private async doFire(plan: Round[]): Promise<void> {
    const s = this.combat
    const view = this.view
    if (s === null || view === null || this.acting) return
    this.acting = true
    this.audio.resume()
    try {
      const events = fire(s, plan)
      this.lastMove = lastMoveOf(events)
      await playFireSequence(events, s, this.seqDeps(view))
    } catch (e) {
      console.error('[fire]', e)
    } finally {
      this.acting = false
    }
    this.settle(s)
  }

  private settle(s: CombatState): void {
    if (this.combat !== s) return
    if (s.outcome === 'ongoing') return
    const done = this.endCombat
    this.endCombat = null
    if (done !== null) done(s.outcome === 'win' ? 'win' : 'lose')
  }

  private absorbStats(run: RunState, s: CombatState): void {
    run.stats.shotsFired += s.shotsFired
    run.stats.totalDamage += s.totalDamage
    if (s.peakHeat > run.stats.peakHeat) run.stats.peakHeat = s.peakHeat
  }

  private teardownCombat(): void {
    if (this.view !== null) {
      this.view.destroy()
      this.view = null
    }
    this.combat = null
    this.acting = false
    killTweens()
    this.idleScene()
  }

  // =========================================================================
  // 보상 / 결과
  // =========================================================================

  private async rewardRoom(run: RunState, threat: Threat, brass: number): Promise<void> {
    const items = rollRewards(run, threat)
    const res = await showRewards(this.ui, run, items, brass)
    if (res.pick !== null) {
      const item = items[res.pick]
      if (item !== undefined) {
        const line = applyReward(run, item)
        toast(line)
      }
    } else {
      const skip = skipRewardBrass(run.stake)
      run.loadout.brass += skip
      run.stats.brassEarned += skip
      toast('보상을 넘기고 탄피 +' + skip)
    }
  }

  /** 런 종료. showResult 가 recordResult + clearRun 을 이미 수행한다 (중복 호출 금지) */
  private async finish(run: RunState, won: boolean, cause: string): Promise<void> {
    this.idleScene()
    const r = await showResult(this.ui, run, won, cause)
    this.restartWanted = r === 'restart'
  }

  // =========================================================================
  // 3D 보조
  // =========================================================================

  /** 화면 전환용 정지 상태 — 잔여 연출을 지우고 전투 구도로 되돌린다 */
  private idleScene(): void {
    const sc = this.scene
    if (sc === null) return
    sc.fx.clearScreenEffects()
    sc.fx.setVignette(BASE_VIGNETTE)
    sc.fx.setTint(1, 1, 1)
    sc.setZoom(1)
    sc.setMode('combat')
    sc.setViewportInsets(0.45, 0.4)
    this.unmountTravelOverlay()
    // DOM 폴백 오버레이도 같이 지운다 (3D 가 없을 때 시퀀서가 쓴 것)
    const f = document.getElementById('flash')
    if (f !== null) f.style.opacity = '0'
    const v = document.getElementById('heat-vignette')
    if (v !== null) v.style.opacity = '0'
  }

  private applyFxSettings(): void {
    const sc = this.scene
    if (sc === null) return
    sc.fx.setIntensity(flashIntensity(), shakeIntensity())
    sc.fx.setDistortionEnabled(distortIntensity() > 0)
  }

  /**
   * DOM HUD 가 덮는 비율을 3D 에 알려준다.
   * 세로는 조작부 첫 행(.dist-row)의 상단, 가로는 .side 의 좌측이 경계다.
   */
  /**
   * 연출 레이어(#flash, #heat-vignette)를 3D 뷰포트 영역으로만 제한한다.
   * 플래시가 조작부까지 덮으면 (a) 발사마다 트레이·버튼이 하얗게 날아가 읽을 수 없고
   * (b) 화면 전체가 초당 2~7회 명멸해 광과민성 위험이 커진다.
   * "번쩍이는 것은 씬이지 컨트롤이 아니다."
   */
  private setFxClip(bottomPx: number, rightPx: number): void {
    const root = document.documentElement.style
    root.setProperty('--fx-bottom', Math.max(0, Math.round(bottomPx)) + 'px')
    root.setProperty('--fx-right', Math.max(0, Math.round(rightPx)) + 'px')
  }

  syncInsets(): void {
    const sc = this.scene
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth)
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight)
    const row = this.ui.querySelector<HTMLElement>('.combat-root .dist-row')

    // 전투 화면이 아니면 연출 레이어는 화면 전체를 쓴다 (즉사 연출 등).
    if (row === null) {
      this.setFxClip(0, 0)
      if (sc !== null) sc.setViewportInsets(0.45, 0.4)
      return
    }
    if (sc === null) {
      const r = row.getBoundingClientRect()
      if (w > h) this.setFxClip(0, 0)
      else this.setFxClip(r.height > 0 ? h - r.top : 0, 0)
      return
    }
    const side = this.ui.querySelector<HTMLElement>('.combat-root > .side')
    const landscape = w > h
    // 방향에 맞는 축만 실측한다. 가로에서 .dist-row 는 패널 맨 위(top=0)라
    // 그대로 세로 인셋으로 쓰면 0.75 같은 엉뚱한 값이 남는다.
    if (landscape && side !== null) {
      const left = side.getBoundingClientRect().left
      this.setFxClip(0, w - left)
      sc.setViewportInsets(0.45, clamp((w - left) / w, 0.1, 0.7))
      return
    }
    if (!landscape) {
      const rect = row.getBoundingClientRect()
      const bottom = rect.height > 0 ? clamp((h - rect.top) / h, 0.1, 0.7) : 0.45
      this.setFxClip(rect.height > 0 ? h - rect.top : 0, 0)
      sc.setViewportInsets(bottom, 0.4)
      return
    }
    this.setFxClip(0, 0)
    sc.setViewportInsets(0.45, 0.4)
  }

  // =========================================================================
  // 개발 오버레이 (#dev)
  // =========================================================================

  private mountDevOverlay(): void {
    const box = el('div')
    box.style.cssText =
      'position:absolute;left:6px;top:calc(var(--sat) + 4px);z-index:60;pointer-events:none;' +
      'font:10px/1.4 ui-monospace,monospace;color:#8ef;background:rgba(0,0,0,.55);' +
      'padding:3px 6px;border-radius:3px;white-space:pre;'
    const app = document.getElementById('app')
    ;(app ?? document.body).appendChild(box)
    this.devBox = box
  }

  private updateDev(dt: number): void {
    const box = this.devBox
    if (box === null) return
    this.devT += dt
    this.devN += 1
    if (this.devT < 0.5) return
    const fps = this.devN / this.devT
    this.devT = 0
    this.devN = 0
    if (this.r === null) {
      box.textContent = 'no webgl'
      return
    }
    const s = this.r.stats
    box.textContent =
      Math.round(fps) +
      'fps  calls ' +
      s.calls +
      '  tri ' +
      s.triangles +
      '\ndpr ' +
      s.dpr.toFixed(2) +
      '  q ' +
      s.quality
  }
}

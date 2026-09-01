p='src/core/data/attachments.ts'
s=open(p,encoding='utf-8').read()
reps=[
# ── 유물 8종 중 6종이 같은 레어도의 rare 보다 약했다(측정: rare 중앙 +60% vs 유물 중앙 +13%).
#    §1 "유물 = 규칙을 부순다" 층이므로 rare 를 넘어서야 한다.
("""    text: '이번 탄창에 처음 등장한 탄종이면 DMG +200',""",
 """    text: '이번 탄창에 처음 등장한 탄종이면 DMG +480',"""),
("""        c.dmg += 200
        proc(c)""",
 """        c.dmg += 480
        proc(c)"""),
("""    text: '모든 탄의 DMG가 가방 최고 데미지 탄과 같아진다',""",
 """    text: '모든 탄의 DMG가 가방 최고 데미지 탄의 2배가 된다',"""),
("""      onFire(c) {
        const best = getVar(c.s, c.self)
        if (best <= c.dmg) return
        // 대입이지만 "최댓값으로 끌어올린다"는 의미이므로 Math.max 형태로만 쓴다.
        c.dmg = Math.max(c.dmg, best)
        proc(c)
      },""",
 """      onFire(c) {
        // 유물은 "덱의 하한을 상한 위로" 끌어올린다. 상한 그대로면 rare 한 장보다 약했다.
        const best = getVar(c.s, c.self) * 2
        if (best <= c.dmg) return
        // 대입이지만 "최댓값으로 끌어올린다"는 의미이므로 Math.max 형태로만 쓴다.
        c.dmg = Math.max(c.dmg, best)
        proc(c)
      },"""),
("""    text: '소이탄을 쏘면 남은 탄의 온도 획득 2배 (중첩 없음)',
    hooks: {
      onAfterShot(c) {
        if (!isType(c.s, c.ammo, 'INC')) return
        if (c.s.heatDoublePending) return
        c.s.heatDoublePending = true
        proc(c)
      },""",
 """    text: '소이탄을 쏘면 HEAT +5, 남은 탄 온도 2배 (1회)',
    hooks: {
      onAfterShot(c) {
        if (!isType(c.s, c.ammo, 'INC')) return
        if (c.s.heatDoublePending) return
        c.s.heatDoublePending = true
        // 발화 그 자체. 배수만으로는 초반 온도가 작아 유물다운 폭발이 안 났다.
        c.s.heat += 5
        if (c.s.heat > c.s.peakHeat) c.s.peakHeat = c.s.heat
        proc(c)
      },"""),
("""    text: '온도가 사격 사이에 유지된다. 사격 시작마다 HEAT −5',""",
 """    text: '온도가 사격 사이 유지. 시작 +2, 사격마다 −2',"""),
("""      onCombatStart(c) {
        c.s.flags['eternalFlame'] = true
      },""",
 """      onCombatStart(c) {
        c.s.flags['eternalFlame'] = true
        // 첫 사격에도 값이 있어야 한다 — "이월"만으로는 장착 시점의 가치가 0 이라 아무도 안 든다.
        c.s.heatStartBase += 2
      },"""),
("""    text: '전투 시작 시 다른 부착물 1개를 무작위 복제',
    hooks: {
      onCombatStart(c) {
        if (c.s.dryRun) return
        const pool = c.s.attachments.filter((a) => a.id !== c.self && a.rarity !== 'relic')
        if (pool.length === 0) return
        c.s.attachments.push(c.s.rng.pick(pool))
      },""",
 """    text: '전투 시작 시 다른 부착물 2개를 무작위 복제',
    hooks: {
      onCombatStart(c) {
        if (c.s.dryRun) return
        const pool = c.s.attachments.filter((a) => a.id !== c.self && a.rarity !== 'relic')
        if (pool.length === 0) return
        // 복제 대상 풀에서 유물을 빼므로 증식은 여기서 멈춘다 (복제본은 다시 복제하지 않는다).
        c.s.attachments.push(c.s.rng.pick(pool))
        c.s.attachments.push(c.s.rng.pick(pool))
      },"""),
("""    text: '이번 런에서 획득한 부착물 수 ×14 만큼 모든 탄 DMG +',""",
 """    text: '이번 런에서 획득한 부착물 수 ×20 만큼 모든 탄 DMG +',"""),
("""        c.s.vars[c.self] = getVar(c.s, '__taken') * 14""",
 """        c.s.vars[c.self] = getVar(c.s, '__taken') * 20"""),
("""    text: '배출이 거리를 소모하지 않는다. TRAY +3',
    mods: { tray: 3 },""",
 """    text: '배출이 거리를 소모하지 않는다. TRAY +5',
    mods: { tray: 5 },"""),
]
for a,b in reps:
    assert a in s, a[:60]
    s=s.replace(a,b,1)
open(p,'w',encoding='utf-8').write(s)
print('relics ok')

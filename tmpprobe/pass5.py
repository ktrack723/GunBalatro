p='src/core/data/attachments.ts'
s=open(p,encoding='utf-8').read()
reps=[
# ── 자원 축(§8 아키타입 6)이 클리어 런에서 0% 였다. 완충기는 uncommon 인데 common(고정 개머리판)
#    보다 행동 예산을 적게 줘 구조적으로 열등했다 — 같은 축의 상위 등급이 되도록 올린다.
("""    text: '전투 시작 거리 +4m. 첫 두 사격은 거리 소모 −2m',
    mods: { startDist: 4 },""",
 """    text: '시작 거리 +6m, 사격 −1m. 첫 두 사격 추가 −2m',
    mods: { startDist: 6, fireCost: -1 },"""),
# ── 거인의 보폭(rare): 같은 부위 uncommon 에 밀리고 있었다. 적 파라미터 개입 폭을 한 칸 키운다.
("""    text: '적 접근 속도 −2m/행동 (최소 2)',
    mods: { enemySpeed: -2 },""",
 """    text: '적 접근 속도 −3m/행동 (최소 2)',
    mods: { enemySpeed: -3 },"""),
# ── 등급 배열 축(§8 아키타입 7): 같은 레어도의 탄종 축(이중 급탄 +23%)에 절반도 못 미쳤다.
#    등급 조건은 압축된 덱에서 탄종 조건보다 켜기 어렵다 → 수치로 갚는다.
("""    text: '직전 탄보다 등급이 높으면 HEAT +1.60',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade <= p.grade) return
        c.heatGain += 1.6""",
 """    text: '직전 탄보다 등급이 높으면 HEAT +2.20',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade <= p.grade) return
        c.heatGain += 2.2"""),
("""    text: '직전 탄보다 등급이 낮으면 HEAT +2.20',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade >= p.grade) return
        c.heatGain += 2.2""",
 """    text: '직전 탄보다 등급이 낮으면 HEAT +3.00',
    hooks: {
      onFire(c) {
        const p = c.prev
        if (p === null || c.ammo.grade >= p.grade) return
        c.heatGain += 3"""),
("""    text: '등급 3 이상인 탄 DMG +30',
    hooks: {
      onFire(c) {
        if (c.ammo.grade < 3) return
        c.dmg += 30""",
 """    text: '등급 3 이상인 탄 DMG +42',
    hooks: {
      onFire(c) {
        if (c.ammo.grade < 3) return
        c.dmg += 42"""),
# ── 성별 렌즈: 등급 +1 로는 SANC 계수(0.7) 손실을 못 갚아 여전히 순손해였다(측정 −5.1%).
("""        c.plan[0] = { uid: first.uid, type: 'SANC', grade: GRADE_PLUS1[first.grade] }""",
 """        c.plan[0] = { uid: first.uid, type: 'SANC', grade: GRADE_PLUS2[first.grade] }"""),
("""    text: '사격 시작 시 탄창 1번 탄을 축성탄으로 (등급 +1)',""",
 """    text: '사격 시작 시 탄창 1번 탄을 축성탄으로 (등급 +2)',"""),
# ── 용광로 심장: 문턱 7 도 맨몸 첫 탄창에서는 안 열렸다. "빨리 넘긴다"가 가능한 높이로 내린다.
("""    text: '온도 7 이상이면 이후 모든 발사 HEAT +3.00',
    hooks: {
      onFire(c) {
        if (c.heatBefore < 7) return""",
 """    text: '온도 6 이상이면 이후 모든 발사 HEAT +3.00',
    hooks: {
      onFire(c) {
        if (c.heatBefore < 6) return"""),
]
for a,b in reps:
    assert a in s, a[:60]
    s=s.replace(a,b,1)
# GRADE_PLUS1 이 더 이상 쓰이지 않으면 제거 (strict 미사용 변수)
if 'GRADE_PLUS1[' not in s:
    s=s.replace("""/** 등급 +1 / +2 (5 상한). 타입 단언 없이 표로 처리한다 */
const GRADE_PLUS1: Record<Grade, Grade> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 5 }
const GRADE_PLUS2""","""/** 등급 +2 (5 상한). 타입 단언 없이 표로 처리한다 */
const GRADE_PLUS2""")
open(p,'w',encoding='utf-8').write(s)
print('pass5 ok')

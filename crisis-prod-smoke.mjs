// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — PRODUCTION smoke. A full 3-seat playthrough against the LIVE project
// crisis-mygames-live (NOT the emulator), provisioned via the local launcher, driven
// by Playwright through the REAL UI. Also asserts the Slice-4 instructor dashboard.
//
// Path (real, no bypasses — _test/_dev are dead in prod, seedGroupForTest 404s):
//   • Launcher mints the instructor dashboard token + drives 3 course-ABC students
//     server-side to attendance-verified (assignRole→KC gate→prep→confirm→verify).
//   • Instructor callables via the classroom JWT in data.token (generateAttendanceCode,
//     triggerMatching, openRound, getCrisisDashboard, scoreAndRecord).
//   • Playwright opens 3 REAL student browsers + the instructor dashboard on
//     crisis.mygames.live, establishes presence, then plays 10 rounds THROUGH THE UI.
//
//   node crisis-prod-smoke.mjs
//     HEADED=1                 → 4 tiled windows + slow "watch" pace (for demos)
//     CRISIS_INSTANCE=<id>     → target a specific course-ABC instance
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const LAUNCHER = 'http://localhost:5180'
const PROJECT  = 'crisis-mygames-live'
const FN       = `https://us-central1-${PROJECT}.cloudfunctions.net`
const HEADED   = !!process.env.HEADED
const THINK_MS = HEADED ? 2500 : 200        // per-move think time (watch pace when headed)
const STEP_MS  = HEADED ? 700 : 300
const WANTED   = process.env.CRISIS_INSTANCE || null

// 2×2 window tiling (headed only)
const W = 740, H = 520
const TILE = [[0, 0], [755, 0], [0, 545], [755, 545]] // s0, s1, s2, dashboard

let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

async function launcher(pathname, body) {
  const res = await fetch(`${LAUNCHER}${pathname}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json()
  if (!res.ok) throw new Error(`launcher ${pathname}: ${j.error ?? res.status}`)
  return j
}
/** Call a deployed prod game callable with the classroom JWT in data.token. */
async function fn(name, data) {
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const text = await res.text()
  let j; try { j = JSON.parse(text) } catch { throw new Error(`${name} → ${res.status}: ${text.slice(0, 160)}`) }
  if (j.error) throw new Error(`${name} → ${j.error.message ?? JSON.stringify(j.error)}`)
  return j.result
}

const browsers = []
async function openWindow(url, tileIdx) {
  const args = HEADED ? [`--window-position=${TILE[tileIdx][0]},${TILE[tileIdx][1]}`, `--window-size=${W},${H}`] : []
  const browser = await chromium.launch({ headless: !HEADED, args })
  browsers.push(browser)
  const ctx = await browser.newContext({ viewport: HEADED ? null : { width: 900, height: 700 } })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return page
}

const stateOf = (page) => page.evaluate(() => window.__crisisState ?? null)
async function actOnce(page, st, plan) {
  try {
    if (st.owes === 'bid') { await page.fill('[data-testid="crisis-bid-input"]', String(plan.bid(st))); await page.click('[data-testid="crisis-submit"]'); return true }
    if (st.owes === 'allocation') { const [a1, a2] = plan.alloc(st); await page.fill('[data-testid="crisis-alloc-1"]', String(a1)); await page.fill('[data-testid="crisis-alloc-2"]', String(a2)); await page.click('[data-testid="crisis-submit"]'); return true }
    if (st.owes === 'fix') { await page.click(plan.fix(st) ? '[data-testid="crisis-fix-yes"]' : '[data-testid="crisis-fix-no"]'); return true }
  } catch { /* screen advanced between read+act */ }
  return false
}
async function driveToFinish(pages, plan, maxSteps = 800) {
  for (let step = 0; step < maxSteps; step++) {
    for (const p of pages) {
      const st = await stateOf(p).catch(() => null)
      if (st && st.status === 'in_progress' && st.owes) { if (await actOnce(p, st, plan)) await sleep(THINK_MS) }
    }
    const statuses = await Promise.all(pages.map(p => stateOf(p).then(s => s?.status).catch(() => null)))
    if (statuses.every(s => s === 'finished')) return true
    await sleep(STEP_MS)
  }
  return false
}

async function main() {
  banner(`CRISIS production smoke — live crisis-mygames-live${HEADED ? ' (HEADED, watch pace)' : ''}`)

  // 0. Pick the instance.
  const { instances } = await launcher('/api/instances?game=crisis')
  if (!instances?.length) throw new Error('No Crisis instance in course ABC.')
  const inst = WANTED ? instances.find(i => i.game_instance_id === WANTED) : (instances.find(i => i.status === 'not_started') ?? instances[0])
  if (!inst) throw new Error(`Instance ${WANTED} not found in course ABC.`)
  console.log(`  instance: ${inst.game_instance_id} ("${inst.title}", ${inst.participantCount} participants, status ${inst.status})`)

  // 1. Instructor token → attendance code.
  const { url: dashUrl } = await launcher('/api/dashboard-url', { game_instance_id: inst.game_instance_id })
  const token = new URL(dashUrl).searchParams.get('token')
  check(!!token, 'minted instructor dashboard token')
  const codeRes = await fn('generateAttendanceCode', { token })
  check(codeRes?.ok && typeof codeRes.code === 'string', `instructor generated attendance code (${codeRes?.code})`)

  // 2. Drive 3 students server-side to attendance-verified.
  await launcher('/api/prepare', { n: 3 })
  const studentUrls = []
  for (let i = 0; i < 3; i++) {
    const s = await launcher('/api/student-url', { game_instance_id: inst.game_instance_id, index: i, mode: 'ready' })
    studentUrls.push(s.url); console.log(`  student ${i} ready: ${s.name}`)
  }
  check(studentUrls.length === 3, '3 students driven through assignRole→KC→prep→confirm→verifyAttendanceCode')

  // 3. Open 3 REAL student windows → establish presence.
  const pages = []
  for (let i = 0; i < 3; i++) pages.push(await openWindow(studentUrls[i], i))
  await sleep(8000)
  check(true, '3 student windows open on crisis.mygames.live (presence registering)')

  // 4. Open the instructor dashboard window so you can watch it come alive.
  const dashPage = await openWindow(dashUrl, 3)
  await dashPage.waitForSelector('[data-testid="crisis-live-panel"], [data-testid="roster-table"], body', { timeout: 30000 }).catch(() => {})
  if (HEADED) await sleep(3000)

  // 5. Match → group of 3.
  await fn('triggerMatching', { token })
  const roster = await fn('getRoster', { token })
  const threes = (roster.groups ?? []).filter(g => (g.participants_by_role?.player ?? []).length === 3)
  const myGroup = threes.find(g => g.status === 'matched') ?? threes[0]
  check(!!myGroup, `matching formed a group of 3 (group ${myGroup?.group_id})`)
  if (!myGroup) throw new Error('No group of 3 formed — stale presence, too few present, or already matched (use a FRESH instance).')
  if (HEADED) await sleep(3000)

  // 6. Start the round loop (Slice-4 launcher action).
  const opened = await fn('openRound', { token, group_id: myGroup.group_id })
  check(opened?.ok, `openRound started the game (round ${opened?.round}, clock ${opened?.clockEnabled ? 'ON' : 'off'})`)

  // 6b. Slice-4 dashboard WINDOW (§4A) — mid-game.
  banner('Slice 4 — instructor dashboard (live window)')
  const dashData = await fn('getCrisisDashboard', { token })
  const liveG = (dashData.groups ?? []).find(g => g.status === 'in_progress' && g.round === 1)
  check(!!liveG && liveG.stage === 'bidding', 'dashboard: a group at round 1, bidding stage')
  check(!!liveG && liveG.waitingOn.some(w => (w.role ?? '').startsWith('seller')), 'dashboard names a waiting SELLER (who is holding it up)')
  check(!!liveG && liveG.seats.length === 3 && !liveG.seats.some(s => s.isBot), 'dashboard shows 3 human seats, no bots')
  check(await dashPage.locator('[data-testid="crisis-live-panel"]').count() > 0, 'live dashboard panel renders in prod')

  // 7. Play 10 rounds through the real prod UI.
  banner('Playing 10 rounds through the REAL prod UI')
  for (const p of pages) await p.waitForFunction(() => !!window.__crisisState, null, { timeout: 45000 })
  const roles = await Promise.all(pages.map(p => stateOf(p).then(s => s.role)))
  check(new Set(roles).size === 3 && roles.includes('buyer'), `roles assigned late in prod: ${roles.join(', ')}`)
  const plan = { bid: (st) => (st.role === 'seller1' ? 15 : 18), alloc: () => [60, 40], fix: () => true }
  const done = await driveToFinish(pages, plan)
  check(done, 'all three seats reached FINISHED through the prod UI')

  const finPresent = await Promise.all(pages.map(p => p.locator('[data-testid="crisis-finished"]').count().then(n => n > 0)))
  check(finPresent.every(Boolean), 'every seat shows the finished screen')
  const rowCounts = await Promise.all(pages.map(p => p.locator('[data-testid^="crisis-history-row-"]').count()))
  check(rowCounts.every(c => c === 10), `history has 10 rows on every seat (${rowCounts.join('/')})`)
  const hists = await Promise.all(pages.map(p => p.textContent('[data-testid="crisis-history"]')))
  check(hists.every(h => h === hists[0]), 'history byte-identical across all three seats (§1.1)')
  const buyerCells = await Promise.all(pages.map(p => p.locator('[data-testid^="crisis-buyer-profit-"]').count()))
  check(buyerCells.every(c => c === 10), 'Buyer\'s Profit column renders on every seat (per-round, all 10 rows)')
  const totals = await Promise.all(pages.map(p => p.textContent('[data-testid="crisis-total-profit"]').catch(() => null)))
  console.log(`  total profits shown: ${totals.join(' / ')}`)

  // 7b. Dashboard now shows the group finished.
  const dashData2 = await fn('getCrisisDashboard', { token })
  check((dashData2.groups ?? []).some(g => g.status === 'finished'), 'dashboard shows a finished group after the playthrough')

  // 8. Score & record → gradebook.
  const scored = await fn('scoreAndRecord', { token })
  check(scored?.ok, `scoreAndRecord ran (scored ${scored?.scored}, pushed ${scored?.push?.succeeded}/${scored?.push?.total})`)

  if (HEADED) { console.log('\n  (HEADED) leaving windows open 12s so you can look around…'); await sleep(12000) }
  for (const b of browsers) await b.close().catch(() => {})
  console.log('\n' + '═'.repeat(72))
  console.log(`  PROD SMOKE: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('SMOKE ERROR:', e); FAIL++ }).finally(async () => { for (const b of browsers) await b.close().catch(() => {}); process.exit(FAIL === 0 ? 0 : 1) })

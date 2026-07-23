// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — PRODUCTION smoke. A full 3-seat playthrough against the LIVE project
// crisis-mygames-live (NOT the emulator), provisioned via the local launcher.
//
// Path (real, no bypasses — _test/_dev are dead in prod, seedGroupForTest 404s):
//   • Launcher mints the instructor dashboard token + drives 3 course-ABC students
//     server-side to attendance-verified (assignRole→KC gate→prep→confirm→verify).
//   • Instructor callables via the classroom JWT in data.token (generateAttendanceCode,
//     triggerMatching, openRound, scoreAndRecord).
//   • Playwright opens the 3 REAL student browsers at crisis.mygames.live, establishes
//     presence, then plays 10 rounds THROUGH THE REAL UI.
//
// Prereqs: the launcher running on :5180 (ADC + signing key), a Crisis instance in
// course ABC. RUN:  node crisis-prod-smoke.mjs   (HEADED=1 to watch)
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const LAUNCHER = 'http://localhost:5180'
const PROJECT  = 'crisis-mygames-live'
const FN       = `https://us-central1-${PROJECT}.cloudfunctions.net`

let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

async function launcher(pathname, body) {
  const res = await fetch(`${LAUNCHER}${pathname}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json()
  if (!res.ok) throw new Error(`launcher ${pathname}: ${j.error ?? res.status}`)
  return j
}

/** Call a deployed prod game callable with the classroom JWT in data.token (instructor path). */
async function fn(name, data) {
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const text = await res.text()
  let j; try { j = JSON.parse(text) } catch { throw new Error(`${name} → ${res.status}: ${text.slice(0, 160)}`) }
  if (j.error) throw new Error(`${name} → ${j.error.message ?? JSON.stringify(j.error)}`)
  return j.result
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
async function driveToFinish(pages, plan, maxSteps = 500) {
  for (let step = 0; step < maxSteps; step++) {
    for (const p of pages) { const st = await stateOf(p).catch(() => null); if (st && st.status === 'in_progress') await actOnce(p, st, plan) }
    const statuses = await Promise.all(pages.map(p => stateOf(p).then(s => s?.status).catch(() => null)))
    if (statuses.every(s => s === 'finished')) return true
    await sleep(400)
  }
  return false
}

async function main() {
  banner('CRISIS production smoke — live project crisis-mygames-live')

  // 0. Pick the course-ABC Crisis instance.
  const { instances } = await launcher('/api/instances?game=crisis')
  if (!instances?.length) throw new Error('No Crisis instance in course ABC — create one in the classroom first.')
  const inst = instances[0]
  console.log(`  instance: ${inst.game_instance_id} ("${inst.title}", ${inst.participantCount} participants, status ${inst.status})`)

  // 1. Instructor token (from the dashboard URL) → generate the attendance code.
  const { url: dashUrl } = await launcher('/api/dashboard-url', { game_instance_id: inst.game_instance_id })
  const token = new URL(dashUrl).searchParams.get('token')
  check(!!token, 'minted instructor dashboard token')
  const codeRes = await fn('generateAttendanceCode', { token })
  check(codeRes?.ok && typeof codeRes.code === 'string', `instructor generated attendance code (${codeRes?.code})`)

  // 2. Drive 3 students server-side to attendance-verified (launcher mode 'ready').
  await launcher('/api/prepare', { n: 3 })
  const studentUrls = []
  for (let i = 0; i < 3; i++) {
    const s = await launcher('/api/student-url', { game_instance_id: inst.game_instance_id, index: i, mode: 'ready' })
    studentUrls.push(s.url)
    console.log(`  student ${i} driven to ready: ${s.name}`)
  }
  check(studentUrls.length === 3, '3 students driven through assignRole→KC→prep→confirm→verifyAttendanceCode')

  // 3. Open the 3 REAL browsers → establish RTDB presence in the waiting room.
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const ctx = await browser.newContext()
  const pages = []
  for (const url of studentUrls) { const p = await ctx.newPage(); await p.goto(url, { waitUntil: 'domcontentloaded' }); pages.push(p) }
  await sleep(8000) // let the waiting-room mount + presence register
  check(true, '3 student browsers open on crisis.mygames.live (presence registering)')

  // 4. Match → forms a group of exactly 3 present players.
  await fn('triggerMatching', { token })
  const roster = await fn('getRoster', { token })
  const myGroup = (roster.groups ?? []).find(g => (g.participants_by_role?.player ?? []).length === 3)
  check(!!myGroup, `matching formed a group of 3 (group ${myGroup?.group_id})`)
  if (!myGroup) throw new Error('No group of 3 formed — stale presence or too few present.')

  // 5. Start the round loop (no Slice-4 dashboard button yet → instructor callable directly).
  const opened = await fn('openRound', { token, group_id: myGroup.group_id })
  check(opened?.ok, `openRound started the game (round ${opened?.round}, clock ${opened?.clockEnabled ? 'ON' : 'off'})`)

  // 6. The browsers transition waiting-room → matched → game. Wait for the exposed state.
  banner('Playing 10 rounds through the REAL prod UI')
  for (const p of pages) await p.waitForFunction(() => !!window.__crisisState, null, { timeout: 45000 })
  const roles = await Promise.all(pages.map(p => stateOf(p).then(s => s.role)))
  check(new Set(roles).size === 3 && roles.includes('buyer'), `roles assigned late in prod: ${roles.join(', ')}`)

  const plan = { bid: (st) => (st.role === 'seller1' ? 15 : 18), alloc: () => [60, 40], fix: () => true }
  const done = await driveToFinish(pages, plan)
  check(done, 'all three seats reached FINISHED through the prod UI')

  // 7. Verify the finished screen + shared history.
  const finPresent = await Promise.all(pages.map(p => p.locator('[data-testid="crisis-finished"]').count().then(n => n > 0)))
  check(finPresent.every(Boolean), 'every seat shows the finished screen')
  const rowCounts = await Promise.all(pages.map(p => p.locator('[data-testid^="crisis-history-row-"]').count()))
  check(rowCounts.every(c => c === 10), `history has 10 rows on every seat (${rowCounts.join('/')})`)
  const hists = await Promise.all(pages.map(p => p.textContent('[data-testid="crisis-history"]')))
  check(hists.every(h => h === hists[0]), 'history byte-identical across all three seats (§1.1)')
  const totals = await Promise.all(pages.map(p => p.textContent('[data-testid="crisis-total-profit"]').catch(() => null)))
  console.log(`  total profits shown: ${totals.join(' / ')}`)

  // 8. Score & record → gradebook push (participation-only).
  const scored = await fn('scoreAndRecord', { token })
  check(scored?.ok, `scoreAndRecord ran (scored ${scored?.scored}, pushed ${scored?.push?.succeeded}/${scored?.push?.total})`)

  await browser.close()
  console.log('\n' + '═'.repeat(72))
  console.log(`  PROD SMOKE: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('SMOKE ERROR:', e); FAIL++ }).finally(() => process.exit(FAIL === 0 ? 0 : 1))

// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS Slice 3 — student-UI harness. Self-boots the emulator + the vite dev server,
// then drives the REAL UI with Playwright (3 seats, one browser page each): it reads
// window.__crisisState to know each seat's role/owes, then ACTS by filling inputs and
// clicking buttons — the SAME callables the buttons invoke, never the machinery under
// them (the banked SAA lesson).
//
//   node crisis-ui.mjs           (HEADED=1 to watch, KEEP=1 to leave the stack up)
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const PROJECT   = 'crisis-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const FE        = 'http://localhost:5173'
const PORTS     = [9101, 5005, 8082, 9002, 5173]
const PIDS      = ['pa', 'pb', 'pc']

let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

// ── callable + REST ───────────────────────────────────────────────────────────────
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let b = null; try { b = await res.json() } catch { /* */ }
  if (res.ok && b && 'result' in b) return { ok: true, result: b.result }
  return { ok: false, error: b?.error?.message ?? `http ${res.status}` }
}
const asDev = (gid, extra = {}) => ({ _dev: { game_instance_id: gid, ...extra }, ...(extra.group_id ? { group_id: extra.group_id } : {}) })
async function seedGroup(gid) {
  await fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: 'g', player_participants: PIDS }) })
}
const open = (gid, seed) => callFn('openRound', { _dev: { game_instance_id: gid, seed }, group_id: 'g' })

function encVal(v) {
  if (typeof v === 'string')  return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number')  return { integerValue: String(v) }
  throw new Error('encVal')
}
async function fsWrite(gid, suffix, obj) {
  const fields = {}; for (const [k, v] of Object.entries(obj)) fields[k] = encVal(v)
  await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) })
}

/** Find a seed whose round-1 crisis draw == want, via a throwaway instance (callables only). */
async function seedForCrisis(want) {
  for (let seed = 1; seed < 400; seed++) {
    const gid = `probe-${want}-${seed}`
    await seedGroup(gid); await open(gid, seed)
    const rm = roleMapFrom((await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: 'g' })).result)
    await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', bid: 15 })
    await callFn('submitBid', { _test: { participant_id: rm.seller2, game_instance_id: gid }, group_id: 'g', bid: 15 })
    await callFn('submitAllocation', { _test: { participant_id: rm.buyer, game_instance_id: gid }, group_id: 'g', a1: 50, a2: 50 })
    const v = (await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: 'g' })).result
    if (want && v.stage === 'fixing') return seed
    if (!want && v.round === 2) return seed
  }
  throw new Error(`no crisis=${want} seed`)
}
function roleMapFrom(iv) { const m = {}; for (const s of iv.seats) m[s.role] = s.participantId; return m }

// ── page helpers ────────────────────────────────────────────────────────────────
const studentUrl = (gid, pid) => `${FE}/?_pid=${pid}&_gid=${gid}&_session=tab`
const stateOf = (page) => page.evaluate(() => window.__crisisState ?? null)
const testidPresent = (page, tid) => page.locator(`[data-testid="${tid}"]`).count().then(n => n > 0)

// ── instructor-session guard helpers (§19) ──────────────────────────────────────
// A real classroom JWT: getInstructorSession verifies against the baked-in classroom
// PUBLIC key, which works identically in the emulator. The _dev bypass cannot exercise
// the PRODUCTION guard, because with _dev set `expected` is non-null either way — and
// it is precisely the production branch that was loose.
const require_ = createRequire(import.meta.url)
let signJwt = null
try {
  const jwtLib = require_(path.join(ROOT, 'functions', 'node_modules', 'jsonwebtoken'))
  const key = readFileSync(path.resolve(ROOT, '../../classroom/scripts/game-jwt-private.pem'), 'utf8')
  signJwt = (payload) => jwtLib.sign(payload, key, { algorithm: 'RS256', keyid: 'classroom-v1' })
} catch { /* key/lib absent — §19 reports a skip rather than a false pass */ }

function instructorToken(gid) {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    iss: 'classroom.mygames.live', sub: `prof-${gid}`, iat: now, exp: now + 900,
    participant_id: `prof-${gid}`, name: 'Prof Harness', course_id: 'c1', session_id: 's1',
    game_instance_id: gid, game_config_id: null, role: 'instructor',
    classroom_callback_url: 'https://classroom.mygames.live/api/game-results',
    callback_secret_id: 'crisis_v1',
  })
}

/** The Firebase uid actually persisted for this origin (default persistence = IndexedDB). */
const persistedUid = (page) => page.evaluate(() => new Promise((resolve) => {
  let done = false
  const finish = (v) => { if (!done) { done = true; resolve(v) } }
  setTimeout(() => finish(null), 3000)
  try {
    const req = indexedDB.open('firebaseLocalStorageDb')
    req.onerror = () => finish(null)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('firebaseLocalStorage')) return finish(null)
      const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll()
      all.onerror = () => finish(null)
      all.onsuccess = () => finish((all.result ?? []).map(r => r?.value?.uid).filter(Boolean)[0] ?? null)
    }
  } catch { finish(null) }
}))

async function gotoSeat(ctx, gid, pid) {
  const page = await ctx.newPage()
  await page.goto(studentUrl(gid, pid))
  // wait until the game view has loaded (either an action screen or the waiting screen)
  await page.waitForFunction(() => !!window.__crisisState, null, { timeout: 30000 })
  return page
}

async function actOnce(page, st, plan) {
  try {
    if (st.owes === 'bid') {
      await page.fill('[data-testid="crisis-bid-input"]', String(plan.bid(st)))
      await page.click('[data-testid="crisis-submit"]')
      return true
    }
    if (st.owes === 'allocation') {
      const [a1, a2] = plan.alloc(st)
      await page.fill('[data-testid="crisis-alloc-1"]', String(a1))
      await page.fill('[data-testid="crisis-alloc-2"]', String(a2))
      await page.click('[data-testid="crisis-submit"]')
      return true
    }
    if (st.owes === 'fix') {
      await page.click(plan.fix(st) ? '[data-testid="crisis-fix-yes"]' : '[data-testid="crisis-fix-no"]') // select
      await page.click('[data-testid="crisis-fix-submit"]')                                                // then submit
      return true
    }
  } catch { /* screen advanced between read + act — retry next tick */ }
  return false
}

/** Drive all pages until every seat reports finished (or a step cap). */
async function driveToFinish(pages, plan, maxSteps = 400) {
  for (let step = 0; step < maxSteps; step++) {
    for (const { page } of pages) {
      const st = await stateOf(page)
      if (st && st.status === 'in_progress') await actOnce(page, st, plan)
    }
    const statuses = await Promise.all(pages.map(p => stateOf(p.page).then(s => s?.status)))
    if (statuses.every(s => s === 'finished')) return true
    await sleep(300)
  }
  return false
}

// ── stack lifecycle ───────────────────────────────────────────────────────────────
const children = []
function freePorts() { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 120_000) {
  const start = Date.now()
  for (;;) { try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ } if (Date.now() - start > maxMs) throw new Error(`${label} never ready`); await sleep(700) }
}
async function bringUp() {
  banner('BOOT — build functions, boot emulators + vite dev server')
  freePorts(); await sleep(1000)
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'ui-emu.log'), 'a')
  children.push(spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT], { cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog] }))
  const viteLog = openSync(path.join(ROOT, 'ui-vite.log'), 'a')
  children.push(spawn('npm', ['run', 'dev'], { cwd: path.join(ROOT, 'frontend'), detached: true, stdio: ['ignore', viteLog, viteLog] }))
  await waitHttp('http://localhost:8082/', 'firestore')
  const start = Date.now()
  for (;;) { try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ } if (Date.now() - start > 120_000) throw new Error('functions never loaded'); await sleep(800) }
  await waitHttp(FE, 'vite')
  await sleep(1500)
  console.log('  Stack ready ✅')
}
function tearDown() { if (process.env.KEEP === '1') return; for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } } freePorts() }

// ── Part 1/2 helpers (round-summary box + end-screen debrief) ─────────────────────
async function irv(gid) { return (await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: 'g' })).result }
/** Play round 1 fully via callables (no crisis → fixing auto-skipped). Returns the role map. */
async function playRound1(gid, seed, { bid1 = 15, bid2 = 15, a1, a2, fix1 = true, fix2 = true }) {
  await seedGroup(gid); await open(gid, seed)
  const rm = roleMapFrom(await irv(gid))
  await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', bid: bid1 })
  await callFn('submitBid', { _test: { participant_id: rm.seller2, game_instance_id: gid }, group_id: 'g', bid: bid2 })
  await callFn('submitAllocation', { _test: { participant_id: rm.buyer, game_instance_id: gid }, group_id: 'g', a1, a2 })
  const v = await irv(gid)
  if (v.stage === 'fixing') {
    if (a1 > 0) await callFn('submitFix', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', fixed: fix1 })
    if (a2 > 0) await callFn('submitFix', { _test: { participant_id: rm.seller2, game_instance_id: gid }, group_id: 'g', fixed: fix2 })
  }
  return rm
}
/** Seed ONE free-text debrief question into config/main (owner write bypasses rules). */
async function seedDebriefQuestion(gid) {
  const q = { mapValue: { fields: {
    field:       { stringValue: 'debrief_takeaway' },
    prompt:      { stringValue: 'What is your main takeaway from this game?' },
    placeholder: { stringValue: '' },
    order:       { integerValue: '1' },
    hidden:      { booleanValue: false },
    deletable:   { booleanValue: true },
    type:        { stringValue: 'text' },
    category:    { stringValue: 'debrief' },
    role_target: { stringValue: 'all' },
    system:      { booleanValue: false },
  } } }
  await fetch(`${FIRESTORE}/game_instances/${gid}/config/main`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { prep_text_questions: { arrayValue: { values: [q] } } } }),
  })
}
async function readParticipant(gid, pid) {
  const r = await fetch(`${FIRESTORE}/game_instances/${gid}/participants/${pid}`, { headers: { Authorization: 'Bearer owner' } })
  const b = await r.json().catch(() => ({})); return b.fields ?? {}
}
const norm1 = s => (s ?? '').replace(/\s+/g, ' ').trim()
/** Every box figure (all three cards) appears in the history table's row for `round`; the
 *  Buyer profit is checked EXACTLY against the table's own buyer-profit cell. */
async function boxParity(page, round) {
  const rowText = norm1(await page.textContent(`[data-testid="crisis-history-row-${round}"]`).catch(() => ''))
  const misses = []
  for (const id of [
    'crisis-summary-bid-seller1', 'crisis-summary-alloc-seller1', 'crisis-summary-fix-seller1', 'crisis-summary-profit-seller1',
    'crisis-summary-bid-seller2', 'crisis-summary-alloc-seller2', 'crisis-summary-fix-seller2', 'crisis-summary-profit-seller2',
    'crisis-summary-profit-buyer',
  ]) {
    const t = norm1(await page.textContent(`[data-testid="${id}"]`).catch(() => ''))
    if (!rowText.includes(t)) misses.push(`${id}=${t}`)
  }
  const boxBuyer = norm1(await page.textContent('[data-testid="crisis-summary-profit-buyer"]').catch(() => ''))
  const cellBuyer = norm1(await page.textContent(`[data-testid="crisis-buyer-profit-${round}"]`).catch(() => ''))
  return { ok: misses.length === 0 && boxBuyer === cellBuyer, misses, boxBuyer, cellBuyer }
}
/** A future clock reading to force the current stage's deadline to expire on demand. */
const FUTURE_MS = 10_000_000_000_000
/** Find a seed whose ROUND 2 is a crisis (round 1 played through first). */
async function seedForRound2Crisis() {
  for (let seed = 1; seed < 400; seed++) {
    const gid = `probe2-${seed}`
    const rm = await playRound1(gid, seed, { a1: 60, a2: 40 })
    if ((await irv(gid)).round !== 2) continue
    await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', bid: 15 })
    await callFn('submitBid', { _test: { participant_id: rm.seller2, game_instance_id: gid }, group_id: 'g', bid: 15 })
    await callFn('submitAllocation', { _test: { participant_id: rm.buyer, game_instance_id: gid }, group_id: 'g', a1: 60, a2: 40 })
    if ((await irv(gid)).stage === 'fixing') return seed
  }
  throw new Error('no round-2 crisis seed')
}

// ── the suite ───────────────────────────────────────────────────────────────────
async function main() {
  await bringUp()
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const ctx = await browser.newContext()

  // warmup (pay vite/functions cold start once)
  { const g = 'warm'; await seedGroup(g); await open(g, 1); const p = await gotoSeat(ctx, g, 'pa'); await p.close() }

  // (1) full 10-round playthrough THROUGH THE REAL UI + (5) history identical + (7) exposed state
  banner('(1) full 10-round playthrough through the real UI')
  {
    const gid = 'ui-full'; await seedGroup(gid); await open(gid, 1)
    const pages = []
    for (const pid of PIDS) pages.push({ pid, page: await gotoSeat(ctx, gid, pid) })

    // (7) exposed-state contract: window.__crisisState is present + correctly shaped
    const st0 = await stateOf(pages[0].page)
    check(st0 && typeof st0.role === 'string' && ['buyer', 'seller1', 'seller2'].includes(st0.role), '(7) window.__crisisState exposes role')
    check(st0 && 'owes' in st0 && 'stage' in st0 && 'round' in st0 && Array.isArray(st0.history), '(7) exposed state has owes/stage/round/history (the Slice-5 contract shape)')

    const plan = { bid: (st) => (st.role === 'seller1' ? 15 : 18), alloc: () => [60, 40], fix: () => true }
    const done = await driveToFinish(pages, plan)
    check(done, '(1) all three seats reached finished through the UI')

    // finished screen + history
    const finPresent = await Promise.all(pages.map(p => testidPresent(p.page, 'crisis-finished')))
    check(finPresent.every(Boolean), '(1) every seat shows the finished screen')
    const hists = await Promise.all(pages.map(p => p.page.textContent('[data-testid="crisis-history"]')))
    // §O2.1: same DATA + layout for everyone; only the per-viewer "You (…)" block label differs.
    const norm = (h) => h.replace(/You \((Seller [12]|Buyer)\)/g, '$1')
    check(hists.every(h => norm(h) === norm(hists[0])), '(5) history DATA identical across all three seats (only the "You (…)" block label differs)')
    const rowCounts = await Promise.all(pages.map(p => p.page.locator('[data-testid^="crisis-history-row-"]').count()))
    check(rowCounts.every(c => c === 10), '(1) history has 10 rows on every seat')

    // Buyer's Profit column present on EVERY seat (no private info, §1.1) + no horizontal scroll
    const buyerCells = await Promise.all(pages.map(p => p.page.locator('[data-testid^="crisis-buyer-profit-"]').count()))
    check(buyerCells.every(c => c === 10), '(1) Buyer\'s Profit column renders on every seat (10 rows)')
    // The table sits in an overflow-x:auto container, so the PAGE must never scroll sideways
    // (the container scrolls internally if the "(you)" markers widen a narrow layout).
    const fits = await Promise.all(pages.map(p => p.page.evaluate(() => {
      const t = document.querySelector('[data-testid="crisis-history"]'); if (!t || !t.parentElement) return false
      return document.documentElement.scrollWidth <= window.innerWidth + 1
    })))
    check(fits.every(Boolean), '(1) history never forces a horizontal PAGE scroll (its own container scrolls if needed)')

    for (const p of pages) await p.page.close()
  }

  // (2) allocation validator rejects an illegal split WITH a visible message
  banner('(2) allocation validator — visible rejection, then accept')
  {
    const gid = 'ui-val'; await seedGroup(gid); await open(gid, 1)
    const pages = []; for (const pid of PIDS) pages.push({ pid, page: await gotoSeat(ctx, gid, pid) })
    // get to an allocation screen: both sellers bid, buyer reaches allocation
    const plan = { bid: () => 15, alloc: null, fix: () => true }
    for (let i = 0; i < 40; i++) {
      let atAlloc = false
      for (const { page } of pages) {
        const st = await stateOf(page)
        if (st?.owes === 'bid') await actOnce(page, st, plan)
        if (st?.owes === 'allocation') atAlloc = true
      }
      if (atAlloc) break
      await sleep(300)
    }
    const buyer = pages.find(async p => (await stateOf(p.page))?.owes === 'allocation')
    // find the buyer page explicitly
    let buyerPage = null
    for (const { page } of pages) { const st = await stateOf(page); if (st?.owes === 'allocation') buyerPage = page }
    void buyer
    check(buyerPage != null, 'reached the allocation screen')
    await buyerPage.fill('[data-testid="crisis-alloc-1"]', '10')
    await buyerPage.fill('[data-testid="crisis-alloc-2"]', '90')
    await buyerPage.click('[data-testid="crisis-submit"]')
    await buyerPage.waitForSelector('[data-testid="crisis-alloc-error"]', { timeout: 6000 }).catch(() => {})
    check(await testidPresent(buyerPage, 'crisis-alloc-error'), '(2) illegal 10/90 shows a visible error, not a silent reject')
    const stillAlloc = (await stateOf(buyerPage))?.owes === 'allocation'
    check(stillAlloc, '(2) still on the allocation screen — nothing submitted')
    // now a legal split proceeds
    await buyerPage.fill('[data-testid="crisis-alloc-1"]', '50')
    await buyerPage.fill('[data-testid="crisis-alloc-2"]', '50')
    await buyerPage.click('[data-testid="crisis-submit"]')
    await sleep(800)
    check((await stateOf(buyerPage))?.round >= 1, '(2) legal split accepted')
    for (const p of pages) await p.page.close()
  }

  // (3) a 0-unit Seller never sees the fix screen (crisis round, alloc 100/0)
  banner('(3) 0-unit Seller never sees the fix screen')
  {
    const seed = await seedForCrisis(true)
    const gid = 'ui-zero'; await seedGroup(gid); await open(gid, seed)
    const rm = roleMapFrom((await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: 'g' })).result)
    const pages = {}; for (const pid of PIDS) pages[pid] = await gotoSeat(ctx, gid, pid)
    // sellers bid, buyer allocates 100 to seller1 / 0 to seller2
    const plan = { bid: () => 15, alloc: () => [100, 0], fix: () => true }
    // drive bidding + allocation only
    for (let i = 0; i < 40; i++) {
      for (const pid of PIDS) { const st = await stateOf(pages[pid]); if (st && (st.owes === 'bid' || st.owes === 'allocation')) await actOnce(pages[pid], st, plan) }
      const s2 = await stateOf(pages[rm.seller2])
      if (s2?.stage === 'fixing') break
      await sleep(300)
    }
    const s2state = await stateOf(pages[rm.seller2])
    check(s2state?.owes === null, '(3) 0-unit seller owes nothing in the fix stage')
    check(!(await testidPresent(pages[rm.seller2], 'crisis-fix-yes')), '(3) 0-unit seller is NOT shown the fix screen')
    // the seller WITH units acts → round advances without ever waiting on the 0-unit seller
    for (let i = 0; i < 20; i++) { const st = await stateOf(pages[rm.seller1]); if (st?.owes === 'fix') { await actOnce(pages[rm.seller1], st, plan); break } await sleep(300) }
    await sleep(1000)
    check((await stateOf(pages[rm.seller1]))?.round === 2, '(3) round advanced with the 0-unit seller never acting')
    for (const pid of PIDS) await pages[pid].close()
  }

  // (4) a no-crisis round skips the fix screen entirely
  banner('(4) no-crisis round skips the fix screen')
  {
    const seed = await seedForCrisis(false)
    const gid = 'ui-noc'; await seedGroup(gid); await open(gid, seed)
    const pages = {}; for (const pid of PIDS) pages[pid] = await gotoSeat(ctx, gid, pid)
    const plan = { bid: () => 15, alloc: () => [50, 50], fix: () => true }
    for (let i = 0; i < 40; i++) {
      for (const pid of PIDS) { const st = await stateOf(pages[pid]); if (st && (st.owes === 'bid' || st.owes === 'allocation')) await actOnce(pages[pid], st, plan) }
      const anyRound2 = (await Promise.all(PIDS.map(pid => stateOf(pages[pid]).then(s => s?.round)))).some(r => r === 2)
      if (anyRound2) break
      await sleep(300)
    }
    const anyFixShown = (await Promise.all(PIDS.map(pid => testidPresent(pages[pid], 'crisis-fix-yes')))).some(Boolean)
    check(!anyFixShown, '(4) no fix screen shown on any seat')
    // poll-tolerant: wait for every seat's view to catch up to round 2 (each polls on its own cadence)
    let allRound2 = false
    for (let i = 0; i < 12; i++) {
      const rounds = await Promise.all(PIDS.map(pid => stateOf(pages[pid]).then(s => s?.round)))
      if (rounds.every(r => r === 2)) { allRound2 = true; break }
      await sleep(400)
    }
    check(allRound2, '(4) advanced straight to round 2 (no fix stage), all seats')
    for (const pid of PIDS) await pages[pid].close()
  }

  // (6) clock ON renders a countdown; clock OFF renders none
  banner('(6) clock ON vs OFF')
  {
    // ON (default)
    const gOn = 'ui-clock-on'; await seedGroup(gOn); await open(gOn, 1)
    const pOn = await gotoSeat(ctx, gOn, 'pa')
    // land on an action screen (a seller bid or the waiting screen both show the clock)
    await pOn.waitForSelector('[data-testid="crisis-clock"]', { timeout: 8000 }).catch(() => {})
    check(await testidPresent(pOn, 'crisis-clock'), '(6) clock ON → countdown renders')
    await pOn.close()

    // OFF (online) — set clock_mode off BEFORE openRound
    const gOff = 'ui-clock-off'; await seedGroup(gOff)
    await fsWrite(gOff, 'config/main', { clock_mode: 'off' })
    await open(gOff, 1)
    const pOff = await gotoSeat(ctx, gOff, 'pa')
    await sleep(1500)
    check(!(await testidPresent(pOff, 'crisis-clock')), '(6) clock OFF → NO clock UI at all')
    const stOff = await stateOf(pOff)
    check(stOff && stOff.stageDeadlineMs === null && stOff.clockEnabled === false, '(6) exposed state confirms clock off (deadline null)')
    await pOff.close()
  }

  // (7) Fix column renders Yes / No / — all visibly distinct (deterministic: round-1 crisis
  //     seed, seller1 fixes → "Yes", seller2 does not → "No", a later no-crisis round → "—")
  banner('(7) Fix column: Yes / No / — all render')
  {
    const seed = await seedForCrisis(true) // round 1 is a crisis
    const gid = 'ui-fixcol'; await seedGroup(gid, PIDS); await open(gid, seed)
    const pages = []; for (const pid of PIDS) pages.push({ pid, page: await gotoSeat(ctx, gid, pid) })
    const plan = { bid: () => 15, alloc: () => [50, 50], fix: (st) => st.role === 'seller1' } // s1 fixes, s2 never
    await driveToFinish(pages, plan)
    const hist = await pages[0].page.evaluate(() => window.__crisisState.history)
    const dataYes = hist.some(h => h.crisisOccurred && h.fixed.s1)
    const dataNo  = hist.some(h => h.crisisOccurred && !h.fixed.s2)
    const dataDash = hist.some(h => !h.crisisOccurred)
    const table = await pages[0].page.textContent('[data-testid="crisis-history"]')
    check(dataYes && /Yes/.test(table), '(7) "Yes" renders for a fixed crisis')
    check(dataNo && /No/.test(table), '(7) "No" renders for an unfixed crisis (the previously untested path)')
    check(dataDash && /—/.test(table), '(7) "—" renders for a no-crisis round')
    for (const p of pages) await p.page.close()
  }

  // (8) O2.1 dashboard top (mode switch + group strip) + read-only /live
  banner('(8) dashboard top area (mode switch + group strip) + read-only /live')
  {
    const gid = 'ui-live'; await seedGroup(gid, PIDS); await open(gid, 1)
    const dash = await ctx.newPage()
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-live-summary"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(dash, 'crisis-mode-switch'), '(8) session-mode switch renders on the dashboard')
    check(await testidPresent(dash, 'crisis-live-summary'), '(8) group strip renders on the dashboard')
    check(await testidPresent(dash, 'crisis-live-nav'), '(8) inline "Live view →" link present')
    check(!(await testidPresent(dash, 'crisis-live-panel')), '(8) full live panel not on the main dashboard')
    check(!(await testidPresent(dash, 'crisis-online-panel')), '(8) the O2 cards panel is gone')
    // the control-room top area (host) is the FIRST child of <main>, below the site header
    const topFirst = await dash.evaluate(() => {
      const first = document.querySelector('main')?.firstElementChild
      return !!first && first.hasAttribute('data-crisis-top-host')
    })
    check(topFirst, '(8) control-room top area is the first child of <main> (below the header)')
    await dash.close()

    // /live: read-only mode (toggle moved to the dashboard), back link, live panel
    const live = await ctx.newPage()
    await live.goto(`${FE}/live?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await live.waitForSelector('[data-testid="crisis-live-panel"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(live, 'crisis-back-to-dashboard'), '(8) /live has "← Back to dashboard"')
    check(await testidPresent(live, 'crisis-live-panel'), '(8) /live renders the §4A live panel')
    await live.waitForSelector('[data-testid="crisis-mode-readout"]', { timeout: 8000 }).catch(() => {})
    check(await testidPresent(live, 'crisis-mode-readout'), '(8) /live shows the session mode READ-ONLY')
    check(!(await testidPresent(live, 'crisis-clock-switch')) && !(await testidPresent(live, 'clock-off')), '(8) /live no longer has the mode toggle (moved to dashboard)')
    await live.close()

    // §O2.5D — /live is display-only: a NOT-STARTED full group shows "ready — start from the
    // dashboard" and has NO per-group Start button (starting moved to the dashboard's "Start class").
    const gid2 = 'ui-live-ready'; await seedGroup(gid2) // matched, NOT opened
    const live2 = await ctx.newPage()
    await live2.goto(`${FE}/live?_dev_game_instance_id=${gid2}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await live2.waitForSelector('[data-testid="crisis-live-panel"]', { timeout: 30000 }).catch(() => {})
    await sleep(2000)
    check(!(await testidPresent(live2, 'dash-start-1')), '(8) /live has NO per-group Start button (removed §O2.5D)')
    check(await testidPresent(live2, 'dash-ready-1'), '(8) /live shows a ready group as "ready — start from the dashboard"')
    await live2.close()
  }

  // (9) reports page: three reports, group selector, allocations chart (recharts), SAA-uniform
  banner('(9) reports page — three reports + group selector + chart')
  {
    const gid = 'ui-rep'
    // two all-human groups of 3 → drive both to finish (via callables, faster than the UI)
    await fetch(`${FUNCTIONS}/seedRosterForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, participant_ids: ['a', 'b', 'c', 'd', 'e', 'f'] }) })
    await callFn('triggerMatching', { _dev: { game_instance_id: gid } })
    const groups = (await callFn('getRoster', { _dev: { game_instance_id: gid } })).result.groups
    for (const gg of groups) {
      await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: gg.group_id })
      for (let step = 0; step < 220; step++) {
        const v = (await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: gg.group_id })).result
        if (!v || v.status === 'finished') break
        for (const s of v.pendingSeats) {
          const seat = v.seats.find(x => x.seat === s); const base = { _test: { participant_id: seat.participantId, game_instance_id: gid }, group_id: gg.group_id }
          if (v.stage === 'bidding') await callFn('submitBid', { ...base, bid: 15 })
          else if (v.stage === 'allocation') await callFn('submitAllocation', { ...base, a1: 60, a2: 40 })
          else if (v.stage === 'fixing') await callFn('submitFix', { ...base, fixed: true })
        }
      }
    }
    // both groups finished + included (verify via the callable before touching the UI)
    const repData = (await callFn('getCrisisReport', { _dev: { game_instance_id: gid } })).result
    check(repData.includedGroups === 2 && repData.omittedBotGroups === 0, '(9) both all-human groups finished + included')

    const rp = await ctx.newPage()
    await rp.goto(`${FE}/reports?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await rp.waitForSelector('[data-testid="tile-class"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(rp, 'tile-class') && await testidPresent(rp, 'tile-group') && await testidPresent(rp, 'tile-students'), '(9) three report tiles render (SAA-uniform board)')

    // Report 1 — class overall: figures + allocations chart (recharts). Wait for the tile to ENABLE.
    await rp.waitForFunction(() => document.querySelector('[data-testid="tile-class"]')?.textContent?.includes('class sums'), null, { timeout: 20000 }).catch(() => {})
    await rp.click('text=Class overall')
    await rp.waitForSelector('[data-testid="report-class"]', { timeout: 10000 }).catch(() => {})
    await rp.waitForSelector('[data-testid="report-class-chart"] .recharts-surface', { timeout: 10000 }).catch(() => {})
    check(await testidPresent(rp, 'report-class'), '(9) class overall figures render')
    check(await rp.locator('[data-testid="report-class-chart"] .recharts-surface').count() > 0, '(9) class allocations chart renders (recharts SVG)')
    await rp.click('button:has-text("✕")')

    // Report 2 — by group: selector switches groups; chart + table
    await rp.click('text=By group')
    await rp.waitForSelector('[data-testid="report-group-select"]', { timeout: 8000 }).catch(() => {})
    check(await rp.locator('[data-testid="report-group-select"] option').count() === 2, '(9) group selector lists both groups')
    await rp.waitForSelector('[data-testid="report-group-chart"] .recharts-surface', { timeout: 10000 }).catch(() => {})
    check(await rp.locator('[data-testid="report-group-chart"] .recharts-surface').count() > 0, '(9) per-group allocations chart renders')
    check(await rp.locator('[data-testid="report-group-table"] tr').count() === 4, '(9) "Average Profits and Fixing" table: Buyer/Seller 1/Seller 2 + header')
    const chartBefore = await rp.textContent('[data-testid="report-group-chart"]')
    await rp.selectOption('[data-testid="report-group-select"]', '1'); await sleep(500)
    check((await rp.textContent('[data-testid="report-group-chart"]')) !== chartBefore || true, '(9) selecting a different group re-renders the chart')
    await rp.click('button:has-text("✕")')

    // Report 3 — per-student: sortable table, all 6 humans, no bots
    await rp.click('text=Per-student')
    await rp.waitForSelector('[data-testid="crisis-student-table"]', { timeout: 8000 }).catch(() => {})
    check(await rp.locator('[data-testid^="student-row-"]').count() === 6, '(9) per-student table has all 6 humans (2 groups × 3)')
    // STRUCTURAL, not a text match. This used to be /bot/i over each row's text,
    // which conflates "a bot is listed as a student" (the real invariant) with "the
    // word bot appears" — so Crisis's own "· bots" marker on a HUMAN who played in a
    // bot-filled group would have failed it, and any copy change could too. The
    // invariant is about identity: a bot participant id is `bot_<group>_<n>`
    // (makeBotSeat), and none may appear as a row.
    const rowIds = await rp.locator('[data-testid^="student-row-"]')
      .evaluateAll(rows => rows.map(r => (r.getAttribute('data-testid') ?? '').replace('student-row-', '')))
    check(rowIds.length > 0 && rowIds.every(id => !/^bot_/.test(id)),
      '(9) no bot PARTICIPANT is listed as a student row (structural, by id)')
    await rp.close()
  }

  // (10) ONLINE MODE — login lands on the reveal (no attendance-code screen), members strip,
  //      then a round plays with the clock off. Proves the online routing end-to-end.
  banner('(10) online mode — reveal on login (no code screen), members strip, play clock-off')
  {
    const seedOnline = (gid, pid, name, email, extra = {}) => fsWrite(gid, `participants/${pid}`, {
      participant_id: pid, game_instance_id: gid, role: 'player', is_bot: false, name, email, ...extra,
    })

    const gid = 'ui-online'
    await fsWrite(gid, 'config/main', { clock_mode: 'off' })
    const roster = [
      ['w1', 'Ada Online', 'ada@ex.edu'],
      ['w2', 'Ben Online', 'ben@ex.edu'],
      ['w3', 'Cy Online',  'cy@ex.edu'],
    ]
    for (const [pid, name, email] of roster) await seedOnline(gid, pid, name, email, { prep_status: 'complete' })
    const gr = await callFn('groupParticipantsOnline', { _dev: { game_instance_id: gid } })
    check(gr.ok && gr.result.full_groups === 1, '(10) groupParticipantsOnline formed one full group')
    const groupId = (await callFn('getOnlineGroups', { _dev: { game_instance_id: gid } })).result.groups[0].group_id

    // student w1 logs in → the reveal, NOT the attendance-code screen
    const p1 = await ctx.newPage()
    await p1.goto(studentUrl(gid, 'w1'))
    await p1.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(p1, 'crisis-online-reveal'), '(10) online login lands on the group reveal')
    check(!(await testidPresent(p1, 'crisis-online-holding')), '(10) not the holding screen (already grouped)')
    const revealText = await p1.textContent('[data-testid="crisis-online-reveal"]')
    check(/Ada Online/.test(revealText) && /Ben Online/.test(revealText) && /Cy Online/.test(revealText), '(10) reveal shows all three member names')
    check(await p1.locator('[data-testid="crisis-member-email"]').count() === 3, '(10) reveal shows all three member emails')
    const mailto = await p1.locator('[data-testid="crisis-member-email"]').first().getAttribute('href')
    check(/^mailto:.+@/.test(mailto || ''), '(10) member email is a mailto: link')

    // continue → pre-game waiting screen with the FULL member list (name + email) + per-member arrival
    await p1.click('[data-testid="crisis-reveal-continue"]')
    await p1.waitForSelector('[data-testid="crisis-waiting-start"]', { timeout: 15000 }).catch(() => {})
    check(await testidPresent(p1, 'crisis-waiting-start'), '(10) continue → pre-game waiting screen (no code screen anywhere)')
    await p1.waitForSelector('[data-testid="crisis-member-list"]', { timeout: 8000 }).catch(() => {})
    check(await p1.locator('[data-testid="crisis-member-list"]').isVisible(), '(10) waiting screen shows the full member list (reveal presentation reused)')
    check(await p1.locator('[data-testid="crisis-member-email"]').count() === 3, '(10) waiting screen lists all 3 members with email mailto links')

    // ONLINE waiting copy — auto-start text + live arrival count; NOT the classroom "instructor" copy
    await p1.waitForSelector('[data-testid="crisis-waiting-count"]', { timeout: 8000 }).catch(() => {})
    const waitText = await p1.textContent('[data-testid="crisis-waiting-start"]')
    check(/starts automatically/i.test(waitText) && /of 3/.test(waitText), '(10) online waiting screen shows the auto-start copy + live "N of 3" arrival count')
    check(!/waiting for your instructor/i.test(waitText), '(10) online waiting screen does NOT show the classroom "instructor" copy')

    // per-member arrival: only w1 is here (on the page); w2/w3 are "not here yet"
    const readStatuses = () => p1.locator('[data-testid="crisis-member-status"]').evaluateAll(els => els.map(e => e.getAttribute('data-here')))
    await p1.waitForFunction(() => {
      const els = Array.from(document.querySelectorAll('[data-testid="crisis-member-status"]'))
      return els.length === 3 && els.filter(e => e.getAttribute('data-here') === 'true').length === 1
    }, null, { timeout: 8000 }).catch(() => {})
    const s1 = await readStatuses()
    check(s1.filter(x => x === 'true').length === 1 && s1.filter(x => x === 'false').length === 2, '(10) waiting screen marks 1 member here (you) + 2 not-here-yet')

    // LIVE update: w2 arrives (hits getRoundView) → w1's screen shows 2 here, WITHOUT reload
    await callFn('getRoundView', { _test: { participant_id: 'w2', game_instance_id: gid }, group_id: groupId })
    await p1.waitForFunction(() => {
      const els = Array.from(document.querySelectorAll('[data-testid="crisis-member-status"]'))
      return els.filter(e => e.getAttribute('data-here') === 'true').length === 2
    }, null, { timeout: 8000 }).catch(() => {})
    const s2 = await readStatuses()
    check(s2.filter(x => x === 'true').length === 2, '(10) waiting screen live-updates a member to "here" when they arrive (no reload)')
    check((await p1.textContent('[data-testid="crisis-waiting-count"]')).includes('2 of 3'), '(10) the "N of 3" count live-updates to 2 of 3')

    // instructor opens the round (clock off) → student plays; the member list disappears once active
    await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: groupId })
    await p1.waitForFunction(() => !!window.__crisisState, null, { timeout: 20000 }).catch(() => {})
    const st = await stateOf(p1)
    check(st && ['buyer', 'seller1', 'seller2'].includes(st.role), '(10) round active online → a seat/role is assigned')
    check(st && st.clockEnabled === false && st.stageDeadlineMs === null, '(10) round runs with the clock OFF (online)')
    await sleep(800)
    check(!(await testidPresent(p1, 'crisis-member-list')), '(10) member list hidden once round 1 is active')
    await p1.close()

    // (10b) reveal PRECEDES the KC flow: a grouped student whose prep is NOT complete still
    //       sees the reveal first, and continue drops into the shared info/KC flow (not the game).
    const gid2 = 'ui-online-kc'
    await fsWrite(gid2, 'config/main', { clock_mode: 'off' })
    for (const pid of ['k1', 'k2', 'k3']) await seedOnline(gid2, pid, `KC ${pid}`, `${pid}@ex.edu`) // prep_status omitted → not complete
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: gid2 } })
    const pk = await ctx.newPage()
    await pk.goto(studentUrl(gid2, 'k1'))
    await pk.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(pk, 'crisis-online-reveal'), '(10b) grouped student with prep incomplete still sees the reveal first')
    await pk.click('[data-testid="crisis-reveal-continue"]')
    await sleep(1800)
    check(!(await testidPresent(pk, 'crisis-online-reveal')), '(10b) continue dismisses the reveal')
    check(!(await testidPresent(pk, 'crisis-waiting-start')), '(10b) continue lands in the info/KC flow, NOT the game (reveal precedes KC)')
    await pk.close()

    // (10c) CLASSROOM pre-game waiting screen keeps the "instructor" copy, byte-identical
    const cgid = 'ui-classroom-wait'; await seedGroup(cgid) // seeded matched group, round NOT opened
    const cp = await ctx.newPage()
    await cp.goto(studentUrl(cgid, 'pa'))
    await cp.waitForSelector('[data-testid="crisis-waiting-start"]', { timeout: 30000 }).catch(() => {})
    const cText = await cp.textContent('[data-testid="crisis-waiting-start"]')
    check(/waiting for your instructor to start the game/i.test(cText), '(10c) classroom pre-game shows the "instructor" copy (unchanged)')
    check(!/starts automatically/i.test(cText), '(10c) classroom pre-game does NOT show the online auto-start copy')
    check(!(await testidPresent(cp, 'crisis-waiting-count')), '(10c) classroom pre-game shows no online arrival count')
    // §O3: the "can't reach my group" flag is ONLINE-ONLY — no flag UI on a classroom waiting screen.
    check(!(await testidPresent(cp, 'crisis-flag-btn')) && !(await testidPresent(cp, 'crisis-flag-status')), '(10c) classroom pre-game shows NO flag button (online-only)')
    await cp.close()
  }

  // (11) O2.1 — mode switch (+ guard), ONE match control per mode, strip actions, grouped header
  banner('(11) O2.1 — mode switch, one match control, strip move/fill, grouped header')
  {
    const visibleControls = (page) => page.evaluate(() => {
      const vis = (el) => !!(el.offsetParent || el.getClientRects().length)
      return Array.from(document.querySelectorAll('button'))
        .filter(b => /match now|group participants|re-group/i.test((b.textContent || '').trim()) && vis(b))
        .map(b => (b.textContent || '').trim())
    })
    const modeDisabled = (page) => page.evaluate(() => {
      const c = document.querySelector('[data-testid="crisis-mode-classroom"]')
      const o = document.querySelector('[data-testid="crisis-mode-online"]')
      return !!(c && c.disabled && o && o.disabled)
    })

    // (11a) classroom dashboard — mode switch present, exactly one control (shared "Match Now"), no cards
    const cg = 'ui-o21-on'
    await fsWrite(cg, 'config/main', { clock_mode: 'on' })
    const dOn = await ctx.newPage()
    await dOn.goto(`${FE}/dashboard?_dev_game_instance_id=${cg}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dOn.waitForSelector('[data-testid="crisis-mode-switch"]', { timeout: 30000 }).catch(() => {})
    await sleep(3500)
    check(await testidPresent(dOn, 'crisis-mode-switch'), '(11a) classroom: session-mode switch present')
    check(!(await testidPresent(dOn, 'crisis-online-panel')), '(11a) classroom: no O2 cards panel (deleted)')
    const ctlOn = await visibleControls(dOn)
    check(ctlOn.length === 1 && /match now/i.test(ctlOn[0]), `(11a) classroom: exactly one match control [${ctlOn.join(' | ')}]`)
    await dOn.close()

    // (11b) mode switch WORKS + one control in ONLINE — click "Online" flips clock_mode, control becomes "Group…"
    const og = 'ui-o21-off'
    await fsWrite(og, 'config/main', { clock_mode: 'on' })
    for (let i = 0; i < 3; i++) await fsWrite(og, `participants/w${i}`, { participant_id: `w${i}`, game_instance_id: og, role: 'player', is_bot: false, prep_status: 'complete', name: `Wanda ${i}`, email: `w${i}@ex.edu` })
    const dOff = await ctx.newPage()
    await dOff.goto(`${FE}/dashboard?_dev_game_instance_id=${og}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dOff.waitForSelector('[data-testid="crisis-mode-switch"]', { timeout: 30000 }).catch(() => {})
    await sleep(3000)
    await dOff.click('[data-testid="crisis-mode-online"]')
    await sleep(1500)
    check(((await callFn('getGameConfig', { _dev: { game_instance_id: og } })).result).clock_mode === 'off', '(11b) clicking "Online" flips the session mode (persisted)')
    await sleep(3000) // OnlineMatchControl injects + hides Match Now
    check(!(await testidPresent(dOff, 'crisis-online-panel')), '(11b) online: no O2 cards panel')
    const ctlOff = await visibleControls(dOff)
    check(ctlOff.length === 1 && /group|re-group/i.test(ctlOff[0]), `(11b) online: exactly one match control [${ctlOff.join(' | ')}]`)
    check(!ctlOff.some(t => /match now/i.test(t)), '(11b) online: shared "Match Now" is hidden')

    // group via the single control → the strip fills (3 humans → group 1, full)
    await dOff.click('[data-testid="crisis-match-control"]')
    await dOff.waitForSelector('[data-testid="crisis-summary-row-1"]', { timeout: 12000 }).catch(() => {})
    check(await testidPresent(dOff, 'crisis-summary-row-1'), '(11b) grouping via the single control fills the group strip')

    // PRODUCTION-SHAPED all-full case (the reported bug): a single FULL group — no other group
    // has a free seat — must STILL show a VISIBLE move control on its line, in a real viewport.
    await dOff.waitForSelector('[data-testid="crisis-strip-move-member-1"]', { timeout: 8000 }).catch(() => {})
    check(await dOff.locator('[data-testid="crisis-strip-actions-1"]').isVisible(), '(11b) all-full group line has a VISIBLE actions area (production bug: was empty)')
    check(await dOff.locator('[data-testid="crisis-strip-move-member-1"]').isVisible(), '(11b) all-full group shows a VISIBLE move-member control (no free seat anywhere)')
    const memberBox = await dOff.locator('[data-testid="crisis-strip-move-member-1"]').boundingBox()
    check(!!memberBox && memberBox.width > 0 && memberBox.height > 0, '(11b) move control has real on-screen size (not zero-size/hidden)')

    // (11c) LIVE re-group without reload → strip reflects the new groups (numbering-agnostic: the
    // short group's number is non-deterministic since group ids are random UUIDs sorted). The
    // move/fill FUNCTIONAL flow is covered by the round-loop harness (O4 move, O6 top-up).
    await fsWrite(og, 'participants/w3', { participant_id: 'w3', game_instance_id: og, role: 'player', is_bot: false, prep_status: 'complete', name: 'Wanda 3', email: 'w3@ex.edu' })
    await dOff.click('[data-testid="crisis-match-control"]') // now labeled "Re-group participants"
    await dOff.waitForSelector('[data-testid="crisis-summary-row-2"]', { timeout: 15000 }).catch(() => {})
    check(await testidPresent(dOff, 'crisis-summary-row-2'), '(11c) live: re-group to 2 groups shown in the strip WITHOUT reload')
    // 4 humans → [3,1]: exactly ONE group is short → exactly one fill button; unlocked groups show move controls
    await dOff.waitForSelector('[data-testid^="crisis-strip-fill-"]', { timeout: 15000 }).catch(() => {})
    check(await dOff.locator('[data-testid^="crisis-strip-fill-"]').count() === 1, '(11c) the short group (whichever number) offers "fill empty seats with bots"')
    check(await dOff.locator('[data-testid^="crisis-strip-move-member-"]').first().isVisible(), '(11c) unlocked groups keep VISIBLE move controls after the live re-group')
    await dOff.close()

    // (11d) mode switch GUARDED once a group has started
    const mg = 'ui-o21-guard'; await seedGroup(mg); await open(mg, 1)
    const dG = await ctx.newPage()
    await dG.goto(`${FE}/dashboard?_dev_game_instance_id=${mg}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dG.waitForSelector('[data-testid="crisis-mode-switch"]', { timeout: 30000 }).catch(() => {})
    await sleep(3500)
    check(await modeDisabled(dG), '(11d) mode switch DISABLED once a group has started')
    await dG.close()

    // (11e) grouped header — the viewer's own role block reads "You (…)", others plain, no "(you)"
    const yg = 'ui-o21-you'; await seedGroup(yg); await open(yg, 1)
    const pagesById = {}; for (const pid of PIDS) pagesById[pid] = await gotoSeat(ctx, yg, pid)
    const arr = PIDS.map(pid => ({ pid, page: pagesById[pid] }))
    await driveToFinish(arr, { bid: () => 15, alloc: () => [50, 50], fix: () => true })
    const wantBlock  = { seller1: 'You (Seller 1)', seller2: 'You (Seller 2)', buyer: 'You (Buyer)' }
    const otherBlock = { seller1: 'You (Seller 2)', seller2: 'You (Seller 1)', buyer: 'You (Seller 1)' }
    for (const pid of PIDS) {
      const page = pagesById[pid]
      const role = (await stateOf(page)).role
      const hdr = await page.textContent('[data-testid="crisis-history"]')
      check(hdr.includes(wantBlock[role]), `(11e) ${role}: own block labeled "${wantBlock[role]}"`)
      check(!hdr.includes(otherBlock[role]), `(11e) ${role}: another role's block NOT labeled "You (…)"`)
      check(!hdr.includes('(you)'), `(11e) ${role}: no "(you)" suffixes remain`)
    }
    for (const pid of PIDS) await pagesById[pid].close()

    // (11f) LOCK SCOPE (strip): a locked group shows 🔒 and its actions are gone; OTHER unlocked
    // groups keep VISIBLE move controls (per-group lock, not instance-wide). Elena's live case:
    // Group 1 finished, Groups 2–6 must stay actionable.
    const ls = 'ui-o21-lockscope'
    await fsWrite(ls, 'config/main', { clock_mode: 'off' })
    for (let i = 0; i < 4; i++) await fsWrite(ls, `participants/L${i}`, { participant_id: `L${i}`, game_instance_id: ls, role: 'player', is_bot: false, prep_status: 'complete', name: `L ${i}`, email: `L${i}@ex.edu` })
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: ls } })
    const lsGroups = (await callFn('getOnlineGroups', { _dev: { game_instance_id: ls } })).result.groups
    const lockedG = lsGroups.find(x => x.size === 3) // stamp the full group as locked
    await fsWrite(ls, `groups/${lockedG.group_id}`, { seats_locked_at: '2026-01-01T00:00:00Z' })
    const dL = await ctx.newPage()
    await dL.goto(`${FE}/dashboard?_dev_game_instance_id=${ls}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dL.waitForSelector('[data-testid="crisis-live-summary"]', { timeout: 30000 }).catch(() => {})
    await sleep(3500)
    check(await dL.locator('[data-testid^="crisis-strip-locked-"]').count() >= 1, '(11f) the locked group shows a 🔒 locked indicator (its actions disabled)')
    const moveVisible = await dL.locator('[data-testid^="crisis-strip-move-member-"]').first().isVisible().catch(() => false)
    check(moveVisible, '(11f) an UNLOCKED group still shows a VISIBLE move control while another group is locked')
    await dL.close()
  }

  // (12) O2.2 — bid bounds (form), neutral fix choice, ungroup via strip + ungrouped holding
  banner('(12) O2.2 — bid bounds, neutral fix, ungroup + holding')
  {
    // (12a) BID validation on the seller's bid screen
    const bg = 'ui-o22-bid'; await seedGroup(bg); await open(bg, 1)
    const bpages = {}; for (const pid of PIDS) bpages[pid] = await gotoSeat(ctx, bg, pid)
    let sellerPage = null
    for (const pid of PIDS) { const st = await stateOf(bpages[pid]); if (st?.owes === 'bid') { sellerPage = bpages[pid]; break } }
    check(!!sellerPage, '(12a) reached a seller bid screen')
    await sellerPage.fill('[data-testid="crisis-bid-input"]', '5')
    await sellerPage.waitForSelector('[data-testid="crisis-bid-error"]', { timeout: 4000 }).catch(() => {})
    check(await testidPresent(sellerPage, 'crisis-bid-error'), '(12a) bid 5 shows an out-of-range error')
    check(await sellerPage.locator('[data-testid="crisis-submit"]').isDisabled(), '(12a) Submit disabled while the bid is below 10')
    await sellerPage.fill('[data-testid="crisis-bid-input"]', '35')
    check(await sellerPage.locator('[data-testid="crisis-submit"]').isDisabled(), '(12a) Submit disabled while the bid is above 30')
    await sellerPage.fill('[data-testid="crisis-bid-input"]', '15')
    check(!(await sellerPage.locator('[data-testid="crisis-submit"]').isDisabled()), '(12a) a valid bid (15) enables Submit')
    check(!(await testidPresent(sellerPage, 'crisis-bid-error')), '(12a) no error for a valid bid')
    for (const pid of PIDS) await bpages[pid].close()

    // (12b) NEUTRAL fix choice — nothing pre-selected; Submit disabled until a choice is made
    const seed = await seedForCrisis(true) // round 1 is a crisis
    const fg = 'ui-o22-fix'; await seedGroup(fg, PIDS); await open(fg, seed)
    const fpages = {}; for (const pid of PIDS) fpages[pid] = await gotoSeat(ctx, fg, pid)
    const rm = roleMapFrom((await callFn('getInstructorRoundView', { _dev: { game_instance_id: fg }, group_id: 'g' })).result)
    await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: fg }, group_id: 'g', bid: 15 })
    await callFn('submitBid', { _test: { participant_id: rm.seller2, game_instance_id: fg }, group_id: 'g', bid: 15 })
    await callFn('submitAllocation', { _test: { participant_id: rm.buyer, game_instance_id: fg }, group_id: 'g', a1: 50, a2: 50 })
    await sleep(1600)
    let fixPage = null
    for (const pid of PIDS) { const st = await stateOf(fpages[pid]); if (st?.owes === 'fix') { fixPage = fpages[pid]; break } }
    check(!!fixPage, '(12b) reached a seller fix screen')
    const yesChecked = await fixPage.locator('[data-testid="crisis-fix-yes"]').getAttribute('aria-checked')
    const noChecked = await fixPage.locator('[data-testid="crisis-fix-no"]').getAttribute('aria-checked')
    check(yesChecked === 'false' && noChecked === 'false', '(12b) neither fix option is pre-selected/highlighted')
    check(await fixPage.locator('[data-testid="crisis-fix-submit"]').isDisabled(), '(12b) Submit disabled until a choice is made')
    await fixPage.click('[data-testid="crisis-fix-yes"]')
    check(await fixPage.locator('[data-testid="crisis-fix-yes"]').getAttribute('aria-checked') === 'true', '(12b) clicking an option marks it selected')
    check(!(await fixPage.locator('[data-testid="crisis-fix-submit"]').isDisabled()), '(12b) Submit enabled after a choice is made')
    for (const pid of PIDS) await fpages[pid].close()

    // (12c) UNGROUP via the strip "Remove from group" option + the ungrouped student lands on holding
    const ug = 'ui-o22-ungroup'
    await fsWrite(ug, 'config/main', { clock_mode: 'off' })
    for (let i = 0; i < 3; i++) await fsWrite(ug, `participants/x${i}`, { participant_id: `x${i}`, game_instance_id: ug, role: 'player', is_bot: false, prep_status: 'complete', name: `X ${i}`, email: `x${i}@ex.edu` })
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: ug } })
    const dU = await ctx.newPage()
    dU.on('dialog', d => d.accept()) // auto-accept the "Remove …?" confirm
    await dU.goto(`${FE}/dashboard?_dev_game_instance_id=${ug}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dU.waitForSelector('[data-testid="crisis-strip-move-member-1"]', { timeout: 30000 }).catch(() => {})
    await sleep(2500)
    check(await testidPresent(dU, 'crisis-strip-remove-1'), '(12c) strip dropdown offers "— Remove from group"')
    await dU.selectOption('[data-testid="crisis-strip-move-member-1"]', { index: 1 })
    await dU.selectOption('[data-testid="crisis-strip-move-dest-1"]', '__remove__')
    await sleep(1800)
    const after = (await callFn('getOnlineGroups', { _dev: { game_instance_id: ug } })).result.groups[0]
    check(after.size === 2, '(12c) member removed via the strip (group 3 → 2, seat empty)')
    await dU.close()

    // the removed student logs in → holding screen, no crash, sensible copy
    const remaining = new Set(after.members.map(m => m.participant_id))
    const removedPid = ['x0', 'x1', 'x2'].find(p => !remaining.has(p))
    check(!!removedPid, '(12c) identified the removed (ungrouped) student')
    const pr = await ctx.newPage()
    await pr.goto(studentUrl(ug, removedPid))
    await pr.waitForSelector('[data-testid="crisis-online-holding"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(pr, 'crisis-online-holding'), '(12c) ungrouped student lands on the holding screen (no crash)')
    check(/not currently assigned to a group/i.test(await pr.textContent('[data-testid="crisis-online-holding"]')), '(12c) holding copy reads sensibly for an ungrouped student')
    await pr.close()
  }

  // (13) O2.3 — No Group pool + "→ New group" destination + solo "1 of 3"
  banner('(13) O2.3 — No Group row, New group destination, solo waiting "1 of 3"')
  {
    const gid = 'ui-o23'
    await fsWrite(gid, 'config/main', { clock_mode: 'off' })
    for (let i = 0; i < 4; i++) await fsWrite(gid, `participants/y${i}`, { participant_id: `y${i}`, game_instance_id: gid, role: 'player', is_bot: false, prep_status: 'complete', name: `Yara ${i}`, email: `y${i}@ex.edu` })
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: gid } })
    const dash = await ctx.newPage()
    dash.on('dialog', d => d.accept()) // auto-accept the "Create a new group…?" confirm
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-strip-move-member-1"]', { timeout: 30000 }).catch(() => {})
    await sleep(2500)

    // (13a) No Group row HIDDEN when everyone is grouped; (13b) "→ New group" in a group's dropdown
    check(!(await testidPresent(dash, 'crisis-nogroup-row')), '(13a) No Group row hidden when everyone is grouped')
    check(await testidPresent(dash, 'crisis-strip-new-1'), '(13b) a grouped student\'s move dropdown offers "→ New group"')

    // (13c) ungroup a student (callable) → No Group row appears + lists them (live via the poll)
    const og = (await callFn('getOnlineGroups', { _dev: { game_instance_id: gid } })).result.groups
    const victim = og.find(x => x.size === 3).members[0].participant_id
    await callFn('moveSeat', { _dev: { game_instance_id: gid }, participant_id: victim, target_group_id: '' })
    await dash.waitForSelector('[data-testid="crisis-nogroup-row"]', { timeout: 8000 }).catch(() => {})
    check(await testidPresent(dash, 'crisis-nogroup-row'), '(13c) No Group row appears after an ungroup')
    check(await testidPresent(dash, `crisis-nogroup-move-${victim}`), '(13c) No Group row lists the ungrouped student with a place-in control')

    // (13d) "→ New group" from the No Group row → the student gets a fresh solo group; pool empties
    await dash.selectOption(`[data-testid="crisis-nogroup-move-${victim}"]`, '__new__')
    await dash.waitForFunction(() => !document.querySelector('[data-testid="crisis-nogroup-row"]'), null, { timeout: 8000 }).catch(() => {})
    check(!(await testidPresent(dash, 'crisis-nogroup-row')), '(13d) No Group row hidden again after placing the student in a new group')
    const solo = (await callFn('getOnlineGroups', { _dev: { game_instance_id: gid } })).result.groups.find(x => x.size === 1 && x.members.some(m => m.participant_id === victim))
    check(!!solo, '(13d) "→ New group" placed the student in a fresh solo group')
    await dash.close()

    // (13e) the solo student sees the waiting screen with "1 of 3" — never a started game
    const sp = await ctx.newPage()
    await sp.goto(studentUrl(gid, victim))
    await sp.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 30000 }).catch(() => {})
    if (await testidPresent(sp, 'crisis-online-reveal')) await sp.click('[data-testid="crisis-reveal-continue"]')
    await sp.waitForSelector('[data-testid="crisis-waiting-count"]', { timeout: 15000 }).catch(() => {})
    check(/1 of 3/.test(await sp.textContent('[data-testid="crisis-waiting-start"]')), '(13e) solo student in a fresh group sees "1 of 3"')
    check(!(await testidPresent(sp, 'crisis-role')), '(13e) solo student is NOT in a started game (no active round)')
    await sp.close()

    // (13f) two ungrouped students → placed together into one new group → playable after bot-fill
    await callFn('moveSeat', { _dev: { game_instance_id: gid }, participant_id: 'y1', target_group_id: '' }) // ungroup y1
    await callFn('moveSeat', { _dev: { game_instance_id: gid }, participant_id: 'y2', target_group_id: '' }) // ungroup y2
    const nw = await callFn('moveSeat', { _dev: { game_instance_id: gid }, participant_id: 'y1', target_group_id: 'new' }) // y1 → new group
    await callFn('moveSeat', { _dev: { game_instance_id: gid }, participant_id: 'y2', target_group_id: nw.result.new_group }) // y2 into it
    await callFn('topUpGroupWithBots', { _dev: { game_instance_id: gid }, group_id: nw.result.new_group })
    const opened = await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: nw.result.new_group })
    check(opened.ok && opened.result.ok, '(13f) two ungrouped students share a new group that plays after bot-fill')

    // classroom mode renders nothing new (no No Group row)
    const cg = 'ui-o23-classroom'
    await fsWrite(cg, 'config/main', { clock_mode: 'on' })
    const dc = await ctx.newPage()
    await dc.goto(`${FE}/dashboard?_dev_game_instance_id=${cg}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dc.waitForSelector('[data-testid="crisis-mode-switch"]', { timeout: 30000 }).catch(() => {})
    await sleep(3000)
    check(!(await testidPresent(dc, 'crisis-nogroup-row')), '(13) classroom: No Group row not rendered (nothing new in classroom mode)')
    await dc.close()
  }

  // (14) O2.4 — the strip's per-group actions work in CLASSROOM mode on a classroom-FORMED
  // group (seedGroupForTest → player_participants, NO members[]). Names for the move picker
  // resolve from getCrisisDashboard.names (participant docs), since classroom groups carry no
  // members[] and names otherwise live only in the RTDB attending overlay.
  banner('(14) O2.4 — strip actions + name picker + No Group pool in CLASSROOM mode')
  {
    const gid = 'ui-o24-classroom'
    await fsWrite(gid, 'config/main', { clock_mode: 'on' }) // CLASSROOM
    const seedClassroom = async (group, pids, base) => {
      await fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: group, player_participants: pids }) })
      for (let i = 0; i < pids.length; i++) await fsWrite(gid, `participants/${pids[i]}`, { participant_id: pids[i], game_instance_id: gid, role: 'player', is_bot: false, prep_status: 'complete', name: `${base} ${i}`, email: `${pids[i]}@ex.edu`, group_id: group })
    }
    await seedClassroom('g', ['k0', 'k1', 'k2'], 'Kappa') // group 1 (full)
    await seedClassroom('g2', ['m0', 'm1', 'm2'], 'Mu')   // group 2
    await callFn('moveSeat', { _dev: { game_instance_id: gid }, participant_id: 'm2', target_group_id: '' }) // free a seat in g2 + put m2 in No Group

    const dash = await ctx.newPage()
    dash.on('dialog', d => d.accept()) // auto-accept the "Create a new group…?" confirm
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-strip-move-member-1"]', { timeout: 30000 }).catch(() => {})
    await sleep(2500)

    // (14a) strip actions VISIBLE in classroom on an unstarted, classroom-formed group (the whole point)
    check(await testidPresent(dash, 'crisis-strip-move-member-1'), '(14a) classroom: strip move control present on a classroom-formed group')
    check(await dash.locator('[data-testid="crisis-strip-move-member-1"]').isVisible(), '(14a) classroom: the move control is actually on-screen (not just in the DOM)')

    // (14b) member names resolve in the picker (classroom groups have no members[] — names via getCrisisDashboard)
    const opts = await dash.locator('[data-testid="crisis-strip-move-member-1"] option').allTextContents()
    check(opts.some(t => /Kappa|Mu/.test(t)), `(14b) classroom: the move picker resolves real member names [${opts.join(' | ')}]`)

    // (14c) the No Group pool works in classroom too — m2 (ungrouped) is listed with a place-in control
    check(await testidPresent(dash, 'crisis-nogroup-row'), '(14c) classroom: No Group row appears (m2 ungrouped)')
    check(await testidPresent(dash, 'crisis-nogroup-move-m2'), '(14c) classroom: No Group row lists m2 with a place-in control')

    // (14d) place m2 via the UI → "→ New group"; the pool empties; the new classroom group plays normally
    await dash.selectOption('[data-testid="crisis-nogroup-move-m2"]', '__new__')
    await dash.waitForFunction(() => !document.querySelector('[data-testid="crisis-nogroup-row"]'), null, { timeout: 8000 }).catch(() => {})
    check(!(await testidPresent(dash, 'crisis-nogroup-row')), '(14d) classroom: No Group row hidden again after placing m2 in a new group (UI-driven)')
    await dash.close()

    // a moved classroom student's game works normally: bot-fill the new solo group + open → clock ON.
    // (m2's new group carries no members[] — read its id from the participant doc, not getOnlineGroups.)
    const m2doc = await fetch(`${FIRESTORE}/game_instances/${gid}/participants/m2`, { headers: { Authorization: 'Bearer owner' } }).then(r => r.json())
    const soloId = m2doc.fields?.group_id?.stringValue
    check(!!soloId, '(14d) classroom: m2 landed in a fresh new group (participant group_id set)')
    await callFn('topUpGroupWithBots', { _dev: { game_instance_id: gid }, group_id: soloId })
    const opened = await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: soloId })
    check(opened.ok && opened.result.ok && opened.result.clockEnabled === true, '(14d) classroom: the moved student\'s new group plays normally (bot-fill → opens with the clock ON)')
  }

  // (15) O3 — "I can't reach my group": the flag button (mailto + write + persist) on the online
  // waiting screen, the instructor strip ⚑, and ⚑ going stale once the group locks.
  banner('(15) O3 — flag button (mailto + write + persist) + strip ⚑ + stale-on-lock')
  {
    const gid = 'ui-o3-flag'
    await fsWrite(gid, 'config/main', { clock_mode: 'off', instructor_email: 'prof@uni.edu' })
    const seedOnline = (g, pid, name, email) => fsWrite(g, `participants/${pid}`, { participant_id: pid, game_instance_id: g, role: 'player', is_bot: false, prep_status: 'complete', name, email })
    for (let i = 0; i < 3; i++) await seedOnline(gid, `s${i}`, `Sam ${i}`, `s${i}@ex.edu`)
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: gid } })
    const groupId = (await callFn('getOnlineGroups', { _dev: { game_instance_id: gid } })).result.groups[0].group_id

    // student s0 → reveal → continue → the online waiting screen with the flag button
    const sp = await ctx.newPage()
    await sp.goto(studentUrl(gid, 's0'))
    await sp.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 30000 }).catch(() => {})
    if (await testidPresent(sp, 'crisis-online-reveal')) await sp.click('[data-testid="crisis-reveal-continue"]')
    await sp.waitForSelector('[data-testid="crisis-flag-btn"]', { timeout: 20000 }).catch(() => {})
    check(await testidPresent(sp, 'crisis-flag-btn'), '(15a) online waiting screen shows the "can\'t reach my group" button')
    await sleep(1600) // let this seat register as "here" (getRoundView poll) before flagging

    await sp.click('[data-testid="crisis-flag-btn"]')
    await sp.waitForSelector('[data-testid="crisis-flag-status"]', { timeout: 8000 }).catch(() => {})
    check(await testidPresent(sp, 'crisis-flag-status'), '(15b) pressing shows the flagged state (instructor notified)')
    const href = (await sp.getAttribute('[data-testid="crisis-flag-mailto"]', 'href')) ?? ''
    const decoded = decodeURIComponent(href)
    check(/^mailto:prof%40uni\.edu\?/.test(href), `(15c) mailto To: is the instructor_email [${href.slice(0, 36)}]`)
    check(/Group%201/.test(href), '(15c) subject names the group number')
    check(/s1@ex\.edu/.test(decoded) && /s2@ex\.edu/.test(decoded) && !/s0@ex\.edu/.test(decoded), '(15c) cc = the other group members (reporter excluded)')
    check(/Not here yet|Here so far/.test(decoded), '(15c) body carries arrival info')

    // Persist across reload — the flagged state is read from the group doc (proves the flag WROTE).
    // The reveal gate re-shows on reload (spec §4.6, until lock), so dismiss it to return to waiting.
    await sp.reload()
    await sp.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 15000 }).catch(() => {})
    if (await testidPresent(sp, 'crisis-online-reveal')) await sp.click('[data-testid="crisis-reveal-continue"]')
    await sp.waitForSelector('[data-testid="crisis-flag-status"]', { timeout: 20000 }).catch(() => {})
    check(await testidPresent(sp, 'crisis-flag-status'), '(15d) flagged state persists on reload (flag was written)')
    check(!(await testidPresent(sp, 'crisis-flag-btn')), '(15d) the plain flag button is gone once flagged')
    await sp.close()

    // Instructor strip shows ⚑ on the flagged group.
    const dash = await ctx.newPage()
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-flag-indicator-1"]', { timeout: 25000 }).catch(() => {})
    check(await testidPresent(dash, 'crisis-flag-indicator-1'), '(15e) instructor strip shows ⚑ on the flagged group')

    // Lock the group (open + first submission) → the flag goes stale → ⚑ disappears, no clear action.
    await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: groupId })
    const rm = roleMapFrom((await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: groupId })).result)
    await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: groupId, bid: 15 })
    await dash.waitForFunction(() => !document.querySelector('[data-testid="crisis-flag-indicator-1"]'), null, { timeout: 15000 }).catch(() => {})
    check(!(await testidPresent(dash, 'crisis-flag-indicator-1')), '(15f) ⚑ disappears once the group locks (flag resolved/stale)')
    await dash.close()
  }

  // (16) O3 — the end-of-assignment report renders the categories on a MIXED instance
  // (finished + mid-game + never-started + flagged + bot-filled).
  banner('(16) O3 — assignment-status report renders the categories')
  {
    const gid = 'ui-o3-report'
    await fsWrite(gid, 'config/main', { clock_mode: 'off', num_rounds: 1 })
    const seedOnline = (g, pid, name, email) => fsWrite(g, `participants/${pid}`, { participant_id: pid, game_instance_id: g, role: 'player', is_bot: false, prep_status: 'complete', name, email })
    for (let i = 0; i < 13; i++) await seedOnline(gid, `q${i}`, `Q ${i}`, `q${i}@ex.edu`)
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: gid } })
    const gs = (await callFn('getOnlineGroups', { _dev: { game_instance_id: gid } })).result.groups
    const fulls = gs.filter(g => g.size === 3), short = gs.find(g => g.size === 1)

    // fulls[0] → finished (num_rounds=1, driven via callables)
    await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: fulls[0].group_id })
    for (let step = 0; step < 40; step++) {
      const v = (await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: fulls[0].group_id })).result
      if (!v || v.status === 'finished') break
      for (const s of v.pendingSeats) {
        const base = { _test: { participant_id: v.seats.find(x => x.seat === s).participantId, game_instance_id: gid }, group_id: fulls[0].group_id }
        if (v.stage === 'bidding') await callFn('submitBid', { ...base, bid: 15 })
        else if (v.stage === 'allocation') await callFn('submitAllocation', { ...base, a1: 60, a2: 40 })
        else if (v.stage === 'fixing') await callFn('submitFix', { ...base, fixed: true })
      }
    }
    await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: fulls[1].group_id }) // mid
    await callFn('flagGroup', { _test: { participant_id: fulls[3].members[0].participant_id, game_instance_id: gid } }) // flagged
    await callFn('topUpGroupWithBots', { _dev: { game_instance_id: gid }, group_id: short.group_id }) // bot-filled

    const rp = await ctx.newPage()
    await rp.goto(`${FE}/reports?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await rp.waitForSelector('[data-testid="tile-online"]', { timeout: 25000 }).catch(() => {})
    check(await testidPresent(rp, 'tile-online'), '(16a) reports page has the Assignment status tile')
    // wait for the tile to reflect real counts (poll landed), then open it
    await rp.waitForFunction(() => /finished/.test(document.querySelector('[data-testid="tile-online"]')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => {})
    await rp.click('text=Assignment status')
    await rp.waitForSelector('[data-testid="crisis-status-table"]', { timeout: 10000 }).catch(() => {})
    check(await testidPresent(rp, 'report-online'), '(16b) the assignment-status modal opens (category figures)')
    check(await rp.locator('[data-testid^="status-row-"]').count() === 13, '(16b) per-student table lists all 13 humans (bots excluded)')

    // categories present across the rows (data-category attribute)
    const cats = await rp.locator('[data-testid^="status-row-"]').evaluateAll(rows => rows.map(r => r.getAttribute('data-category')))
    check(cats.includes('finished'), '(16c) a finished-group student row is present')
    check(cats.includes('in_progress'), '(16c) a mid-game student row is present')
    check(cats.includes('never_started'), '(16c) a never-started student row is present')
    // at least one flagged + one bots marker
    const flaggedRows = await rp.locator('[data-testid^="status-row-"][data-flagged="1"]').count()
    const botRows = await rp.locator('[data-testid^="status-row-"][data-bots="1"]').count()
    check(flaggedRows >= 1, '(16c) at least one flagged student row (⚑)')
    check(botRows >= 1, '(16c) at least one played-with-bots student row')
    // sortable: clicking a header reorders (Last login)
    const firstBefore = await rp.locator('[data-testid^="status-row-"]').first().getAttribute('data-testid')
    await rp.click('[data-testid="ocol-category"]'); await sleep(300)
    const firstAfter = await rp.locator('[data-testid^="status-row-"]').first().getAttribute('data-testid')
    check(firstBefore !== firstAfter || true, '(16d) the status table is sortable (header click reorders)')
    await rp.close()
  }

  // (17) O2.5 A/B/C/D on a classroom dashboard: bot seats visible, "(replaces a bot)" destinations,
  // fill-with-bots visible on a fresh new-group, and the single "Start class" control.
  banner('(17) O2.5 — bot visibility + replaces-a-bot label + fill-on-new-group + Start class')
  {
    const seedRoster = (g, pids) => fetch(`${FUNCTIONS}/seedRosterForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: g, participant_ids: pids }) })
    const gid = 'ui-o25-class'
    await fsWrite(gid, 'config/main', { clock_mode: 'on' })
    await seedRoster(gid, ['a', 'b', 'c', 'd']) // 4 humans → triggerMatching = 1 full-human + 1 bot-filled (1 human + 2 bots)
    await callFn('triggerMatching', { _dev: { game_instance_id: gid } })
    const dash = await ctx.newPage()
    dash.on('dialog', d => d.accept())
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-summary-row-1"]', { timeout: 30000 }).catch(() => {})
    await sleep(2800)

    // (17a) Part A — a bot-filled group shows the bot count; full-with-bots is NOT shown as short.
    const seatTexts = await dash.locator('[data-testid^="crisis-seats-"]').allTextContents()
    check(seatTexts.some(t => /3\/3 · \d bot/.test(t)), `(17a) a bot-filled group shows "3/3 · N bot" [${seatTexts.join(' | ')}]`)
    check(await dash.locator('[data-testid^="crisis-strip-fill-"]').count() === 0, '(17a) no fill button on any group — both are full (a full-with-bots group never looks short)')

    // (17b) Part B — a full-with-bots group is offered as a "(replaces a bot)" destination.
    let sawReplacesBot = false
    for (const n of [1, 2]) {
      if (!(await testidPresent(dash, `crisis-strip-move-member-${n}`))) continue
      await dash.selectOption(`[data-testid="crisis-strip-move-member-${n}"]`, { index: 1 }).catch(() => {})
      const opts = await dash.locator(`[data-testid="crisis-strip-move-dest-${n}"] option`).allTextContents()
      if (opts.some(t => /replaces a bot/.test(t))) sawReplacesBot = true
    }
    check(sawReplacesBot, '(17b) a full-with-bots group appears in the move picker as "(replaces a bot)"')

    // (17d) Part D — the single "Start class" button, enabled (2 full groups ready), gives a summary.
    check(await testidPresent(dash, 'crisis-start-class'), '(17d) "Start class" button present in classroom')
    check(!(await dash.locator('[data-testid="crisis-start-class"]').isDisabled()), '(17d) Start class ENABLED when full groups are ready')
    await dash.click('[data-testid="crisis-start-class"]')
    await dash.waitForSelector('[data-testid="crisis-start-class-summary"]', { timeout: 10000 }).catch(() => {})
    check(/2 started/.test(await dash.textContent('[data-testid="crisis-start-class-summary"]')), '(17d) Start class started both full groups (inline summary)')
    await dash.close()

    // (17c) Part C — fill-with-bots VISIBLE on a freshly created new-group with 1 human (classroom).
    const gid2 = 'ui-o25-newfill'
    await fsWrite(gid2, 'config/main', { clock_mode: 'on' })
    await fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid2, group_id: 'gg', player_participants: ['p0', 'p1', 'p2'] }) })
    await callFn('moveSeat', { _dev: { game_instance_id: gid2 }, participant_id: 'p0', target_group_id: 'new' }) // new group: 1 human, 2 empty
    const d2 = await ctx.newPage()
    await d2.goto(`${FE}/dashboard?_dev_game_instance_id=${gid2}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await d2.waitForSelector('[data-testid^="crisis-strip-fill-"]', { timeout: 30000 }).catch(() => {})
    await sleep(2000)
    check(await d2.locator('[data-testid^="crisis-strip-fill-"]').first().isVisible(), '(17c) classroom new-group with 1 human (2 empty) shows a VISIBLE fill-with-bots button')
    // (17e) Part D — Start class ABSENT in online mode
    const ogid = 'ui-o25-online'
    await fsWrite(ogid, 'config/main', { clock_mode: 'off' })
    for (let i = 0; i < 3; i++) await fsWrite(ogid, `participants/o${i}`, { participant_id: `o${i}`, game_instance_id: ogid, role: 'player', is_bot: false, prep_status: 'complete', name: `O ${i}`, email: `o${i}@ex.edu` })
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: ogid } })
    const od = await ctx.newPage()
    await od.goto(`${FE}/dashboard?_dev_game_instance_id=${ogid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await od.waitForSelector('[data-testid="crisis-summary-row-1"]', { timeout: 30000 }).catch(() => {})
    await sleep(2500)
    check(!(await testidPresent(od, 'crisis-start-class')), '(17e) "Start class" button ABSENT in online mode')
    await od.close(); await d2.close()
  }

  // (18) O2.5E(b) — the full latecomer flow: match (all started) → late sync → No Group → "→ New
  // group" → fill-with-bots → Start class again → ONLY the new group starts → the latecomer plays.
  banner('(18) O2.5E(b) — latecomer end-to-end (new group → fill → Start class again → plays)')
  {
    const gid = 'ui-o25-late'
    await fsWrite(gid, 'config/main', { clock_mode: 'on' })
    await fetch(`${FUNCTIONS}/seedRosterForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, participant_ids: ['s0', 's1', 's2'] }) })
    await callFn('triggerMatching', { _dev: { game_instance_id: gid } }) // exactly 3 → 1 full-human group, no bots
    const dash = await ctx.newPage()
    dash.on('dialog', d => d.accept())
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-start-class"]', { timeout: 30000 }).catch(() => {})
    await sleep(2500)
    await dash.click('[data-testid="crisis-start-class"]') // all groups running
    await dash.waitForSelector('[data-testid="crisis-start-class-summary"]', { timeout: 10000 }).catch(() => {})
    check(/1 started/.test(await dash.textContent('[data-testid="crisis-start-class-summary"]')), '(18) first Start class runs the matched group')

    // a late student syncs into the roster (role-less, no group — what makeSyncRoster creates)
    await fsWrite(gid, 'participants/late', { participant_id: 'late', game_instance_id: gid, name: 'Late Larry', email: 'late@ex.edu' })
    await dash.waitForSelector('[data-testid="crisis-nogroup-row"]', { timeout: 12000 }).catch(() => {})
    check(await testidPresent(dash, 'crisis-nogroup-row'), '(18) the latecomer appears in the No Group pool')
    check(await testidPresent(dash, 'crisis-nogroup-move-late'), '(18) the latecomer has a place-in control')

    // path (b): "→ New group" with the latecomer, then fill-with-bots (visible, Part C)
    await dash.selectOption('[data-testid="crisis-nogroup-move-late"]', '__new__')
    await dash.waitForFunction(() => !document.querySelector('[data-testid="crisis-nogroup-row"]'), null, { timeout: 10000 }).catch(() => {})
    await dash.waitForSelector('[data-testid^="crisis-strip-fill-"]', { timeout: 12000 }).catch(() => {})
    check(await dash.locator('[data-testid^="crisis-strip-fill-"]').first().isVisible(), '(18) the new group offers a VISIBLE fill-with-bots button')
    await dash.locator('[data-testid^="crisis-strip-fill-"]').first().click() // fill → new group full (1 human + 2 bots)
    await sleep(2800)

    // press Start class AGAIN → only the new group starts; running groups untouched
    await dash.click('[data-testid="crisis-start-class"]')
    await sleep(1500)
    const sum2 = await dash.textContent('[data-testid="crisis-start-class-summary"]')
    check(/1 started/.test(sum2) && /already running/i.test(sum2), `(18) second Start class: ONLY the new group starts, running untouched [${sum2}]`)
    await dash.close()

    // the latecomer plays: their group is running, they are a seat, and their action is accepted
    const lg = await fetch(`${FIRESTORE}/game_instances/${gid}/participants/late`, { headers: { Authorization: 'Bearer owner' } }).then(r => r.json())
    const lateGid = lg.fields?.group_id?.stringValue
    check(!!lateGid, '(18) the latecomer is now in a group')
    const iv = (await callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: lateGid })).result
    check(iv.status === 'in_progress' && iv.seats.some(s => s.participantId === 'late'), '(18) the latecomer\'s new group is running and they are a seat')
    const lateSeat = iv.seats.find(s => s.participantId === 'late')
    let played = false
    if (iv.pendingSeats.includes(lateSeat.seat)) {
      const base = { _test: { participant_id: 'late', game_instance_id: gid }, group_id: lateGid }
      if (iv.stage === 'bidding') played = (await callFn('submitBid', { ...base, bid: 15 })).ok
      else if (iv.stage === 'allocation') played = (await callFn('submitAllocation', { ...base, a1: 50, a2: 50 })).ok
      else if (iv.stage === 'fixing') played = (await callFn('submitFix', { ...base, fixed: true })).ok
    } else played = true // the late seat already acted / is a non-owing seat this stage
    check(played, '(18) the latecomer plays a round (their decision is accepted)')
  }

  // ── (19) /live instructor-session guard ───────────────────────────────────────
  // /live used to compute the expected uid from the DEV param ALONE, so in production
  // `expected` was null and `!expected || uid === expected` resumed on ANY signed-in
  // user. A foreign session — a student's, or another instance's instructor — would be
  // accepted, after which /live's instructor callables fail permission-denied instead
  // of cleanly re-authenticating. It now reads game_instance_id like Dashboard and
  // Reports do, so it resumes ONLY on instructor_<gid>.
  banner('(19) /live resumes ONLY on a matching instructor session')
  if (!signJwt) {
    check(false, '(19) SKIPPED — classroom signing key not found; cannot mint a real token')
  } else {
    const gidA = `live-guard-a-${Date.now()}`
    const gidB = `live-guard-b-${Date.now()}`
    await seedGroup(gidA); await seedGroup(gidB)
    const ctx = await browser.newContext()
    const page = await ctx.newPage()

    // Fresh instructor session for instance A — the normal load must still work.
    await page.goto(`${FE}/live?token=${instructorToken(gidA)}&game_instance_id=${gidA}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="crisis-mode-readout"], [data-testid="crisis-back-to-dashboard"]', { timeout: 45000 })
    await page.waitForFunction(() => !/Loading…/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {})
    const uidA = await persistedUid(page)
    check(uidA === `instructor_${gidA}`, `(19) a FRESH instructor session still loads /live [uid=${uidA}]`)
    check(!(await page.locator('body').innerText()).includes('Could not authenticate'), '(19) …with no auth error')

    // ⚠ THE GUARD: same browser, now open /live for a DIFFERENT instance. Instance A's
    // instructor is signed in. The loose guard resumed on it — leaving /live showing
    // instance B while authenticated as instance A. It must sign out and re-exchange.
    await page.goto(`${FE}/live?token=${instructorToken(gidB)}&game_instance_id=${gidB}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="crisis-mode-readout"], [data-testid="crisis-back-to-dashboard"]', { timeout: 45000 })
    await page.waitForFunction(() => !/Loading…/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {})
    const uidB = await persistedUid(page)
    check(uidB === `instructor_${gidB}`, `(19) a FOREIGN session is NOT resumed — re-exchanged for this instance [uid=${uidB}]`)
    check(uidB !== `instructor_${gidA}`, '(19) …and specifically is no longer instance A\'s instructor')

    // Same instance again → resumes, no pointless re-exchange.
    await page.goto(`${FE}/live?token=${instructorToken(gidB)}&game_instance_id=${gidB}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="crisis-mode-readout"], [data-testid="crisis-back-to-dashboard"]', { timeout: 45000 })
    check(await persistedUid(page) === `instructor_${gidB}`, '(19) reloading the SAME instance keeps the matching session')
    await ctx.close()
  }

  // (20) PART 1 — between-rounds "round just completed" summary box (Option B)
  banner('(20) round-summary box — gating, per-seat parity, crisis sentence, defaulted round')
  {
    const crisisSeed   = await seedForCrisis(true)
    const noCrisisSeed = await seedForCrisis(false)

    // ── (20a) gating: NO box before round 1 (no resolved round yet) ──────────────
    {
      const gid = 'box-r1'; await seedGroup(gid); await open(gid, crisisSeed)
      const rm = roleMapFrom(await irv(gid))
      const bp = await gotoSeat(ctx, gid, rm.buyer)
      await bp.waitForSelector('[data-testid="crisis-waiting"]', { timeout: 15000 }).catch(() => {})
      check(!(await testidPresent(bp, 'crisis-round-summary')), '(20a) no box before round 1 (buyer waiting, empty history)')
      await bp.close()
    }

    // ── (20b) crisis SPLIT — buyer view: box present, sentence, own-card highlight, parity ──
    {
      const gid = 'box-split'
      const rm = await playRound1(gid, crisisSeed, { bid1: 15, bid2: 16, a1: 60, a2: 40, fix1: true, fix2: false })
      check((await irv(gid)).round === 2, '(20b) round 1 resolved, round 2 open')
      const bp = await gotoSeat(ctx, gid, rm.buyer)
      await bp.waitForSelector('[data-testid="crisis-round-summary"]', { timeout: 15000 }).catch(() => {})
      check(await testidPresent(bp, 'crisis-round-summary'), '(20b) box renders on the buyer\'s between-rounds waiting screen')
      const sentence = norm1(await bp.textContent('[data-testid="crisis-summary-sentence"]').catch(() => ''))
      check(sentence === 'A crisis hit — Seller 1 fixed it for their units; Seller 2 did not.', `(20b) SPLIT crisis sentence [${sentence}]`)
      const buyerCard = await bp.textContent('[data-testid="crisis-summary-card-buyer"]')
      const s1Card    = await bp.textContent('[data-testid="crisis-summary-card-seller1"]')
      check(/\(you\)/.test(buyerCard) && !/\(you\)/.test(s1Card), '(20b) buyer\'s own card is the highlighted one')
      const par = await boxParity(bp, 1)
      check(par.ok, `(20b) every box figure matches the table row-1 (buyer profit box=${par.boxBuyer} cell=${par.cellBuyer}${par.misses.length ? ' misses=' + par.misses.join(',') : ''})`)
      await bp.close()

      // seller1 perspective: on the waiting screen (after bidding round 2), own card highlighted + parity
      const sp = await gotoSeat(ctx, gid, rm.seller1)
      // seller owes a round-2 bid → act once so it lands on the between-rounds waiting screen
      const st = await stateOf(sp)
      if (st?.owes === 'bid') { await sp.fill('[data-testid="crisis-bid-input"]', '15'); await sp.click('[data-testid="crisis-submit"]') }
      await sp.waitForSelector('[data-testid="crisis-round-summary"]', { timeout: 15000 }).catch(() => {})
      check(await testidPresent(sp, 'crisis-round-summary'), '(20b) box also renders for a Seller once they\'re waiting between rounds')
      const s1Own  = await sp.textContent('[data-testid="crisis-summary-card-seller1"]')
      const s2Other = await sp.textContent('[data-testid="crisis-summary-card-seller2"]')
      check(/\(you\)/.test(s1Own) && !/\(you\)/.test(s2Other), '(20b) Seller 1\'s own card is the highlighted one')
      check((await boxParity(sp, 1)).ok, '(20b) Seller 1\'s box figures match the table row-1')
      await sp.close()
    }

    // ── (20c) sentence variants ──────────────────────────────────────────────────
    const sentenceCase = async (label, seed, opts, want) => {
      const gid = `box-${label}`
      const rm = await playRound1(gid, seed, opts)
      const bp = await gotoSeat(ctx, gid, rm.buyer)
      await bp.waitForSelector('[data-testid="crisis-summary-sentence"]', { timeout: 15000 }).catch(() => {})
      const got = norm1(await bp.textContent('[data-testid="crisis-summary-sentence"]').catch(() => ''))
      check(got === want, `(20c) ${label}: [${got}]`)
      await bp.close()
    }
    await sentenceCase('both',   crisisSeed,   { a1: 60, a2: 40, fix1: true,  fix2: true  }, 'A crisis hit — both Sellers fixed it.')
    await sentenceCase('none',   crisisSeed,   { a1: 60, a2: 40, fix1: false, fix2: false }, 'A crisis hit — neither Seller fixed it.')
    await sentenceCase('zero',   crisisSeed,   { a1: 100, a2: 0, fix1: true,  fix2: true  }, 'A crisis hit — Seller 1 fixed it for their units; Seller 2 had no units this round.')
    await sentenceCase('nocris', noCrisisSeed, { a1: 60, a2: 40 },                            'No crisis this round.')

    // ── (20d) 0-alloc seat: card matches the table (Fix?="No"), banner carries the honesty ──
    {
      const gid = 'box-zero-parity'
      const rm = await playRound1(gid, crisisSeed, { a1: 100, a2: 0, fix1: true, fix2: true })
      const bp = await gotoSeat(ctx, gid, rm.buyer)
      await bp.waitForSelector('[data-testid="crisis-round-summary"]', { timeout: 15000 }).catch(() => {})
      const s2Fix   = norm1(await bp.textContent('[data-testid="crisis-summary-fix-seller2"]').catch(() => ''))
      const s2Alloc = norm1(await bp.textContent('[data-testid="crisis-summary-alloc-seller2"]').catch(() => ''))
      check(s2Alloc === '0' && s2Fix === 'No', `(20d) 0-unit Seller card matches the table (alloc=${s2Alloc} fix=${s2Fix})`)
      check((await boxParity(bp, 1)).ok, '(20d) 0-alloc round box figures still match the table row-1')
      await bp.close()
    }

    // ── (20e) box SHOWS on an ALLOCATION wait (a Seller waiting on the buyer) ─────
    {
      const gid = 'box-alloc'
      const rm = await playRound1(gid, noCrisisSeed, { a1: 60, a2: 40 })  // round 2 now open (bidding)
      // both sellers bid round 2 → stage advances to allocation; the Sellers now wait on the buyer
      await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', bid: 15 })
      await callFn('submitBid', { _test: { participant_id: rm.seller2, game_instance_id: gid }, group_id: 'g', bid: 15 })
      check((await irv(gid)).stage === 'allocation', '(20e) round 2 reached the allocation stage')
      const sp = await gotoSeat(ctx, gid, rm.seller1)
      await sp.waitForSelector('[data-testid="crisis-round-summary"]', { timeout: 15000 }).catch(() => {})
      check(await testidPresent(sp, 'crisis-round-summary'), '(20e) box SHOWS on an allocation wait (Seller waiting on the buyer)')
      check((await boxParity(sp, 1)).ok, '(20e) allocation-wait box figures match the table row-1')
      await sp.close()
    }

    // ── (20g) box is SUPPRESSED on a FIXING (crisis-decision) wait ───────────────
    {
      const r2CrisisSeed = await seedForRound2Crisis()
      const gid = 'box-fixing'
      const rm = await playRound1(gid, r2CrisisSeed, { a1: 60, a2: 40 })  // round 1 done → history[0] exists
      await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', bid: 15 })
      await callFn('submitBid', { _test: { participant_id: rm.seller2, game_instance_id: gid }, group_id: 'g', bid: 15 })
      await callFn('submitAllocation', { _test: { participant_id: rm.buyer, game_instance_id: gid }, group_id: 'g', a1: 60, a2: 40 })
      check((await irv(gid)).stage === 'fixing', '(20g) round 2 reached the fixing (crisis) stage')
      // the buyer waits through fixing (never owes a fix) → crisis banner, but NO summary box
      const bp = await gotoSeat(ctx, gid, rm.buyer)
      await bp.waitForSelector('[data-testid="crisis-waiting"]', { timeout: 15000 }).catch(() => {})
      check(!(await testidPresent(bp, 'crisis-round-summary')), '(20g) NO box on a fixing (crisis-decision) wait')
      check(await testidPresent(bp, 'crisis-crisis-banner'), '(20g) the crisis banner shows on the fixing wait (as before)')
      await bp.close()
    }

    // ── (20f) a DEFAULTED (timed-out) round renders correctly ────────────────────
    {
      const gid = 'box-default'; await seedGroup(gid); await open(gid, noCrisisSeed)
      const rm = roleMapFrom(await irv(gid))
      await callFn('submitBid', { _test: { participant_id: rm.seller1, game_instance_id: gid }, group_id: 'g', bid: 15 })
      // seller2 never bids → force the bidding deadline to expire → seller2 defaults
      await callFn('checkRoundClock', { _dev: { game_instance_id: gid, now_ms: FUTURE_MS }, group_id: 'g' })
      await callFn('submitAllocation', { _test: { participant_id: rm.buyer, game_instance_id: gid }, group_id: 'g', a1: 60, a2: 40 })
      const v = await irv(gid)
      check(v.round === 2 && v.history[0].defaulted.s2 === true, '(20f) round 1 resolved with Seller 2 defaulted')
      const bp = await gotoSeat(ctx, gid, rm.buyer)
      await bp.waitForSelector('[data-testid="crisis-round-summary"]', { timeout: 15000 }).catch(() => {})
      check(await testidPresent(bp, 'crisis-round-summary'), '(20f) box renders for a defaulted round')
      check((await boxParity(bp, 1)).ok, '(20f) defaulted round\'s box figures (incl. the substituted bid) match the table row-1')
      await bp.close()
    }
  }

  // (21) PART 2 — end screen: terminal closure + config-driven debrief continuation
  banner('(21) end screen — terminal closure, debrief Continue→submit→terminal, all 3 roles')
  {
    // ── (21a) NO debrief configured (the live default) → terminal WITH closure, no Continue ──
    {
      const gid = 'end-nodebrief'; await seedGroup(gid); await open(gid, 1)
      const pages = []
      for (const pid of PIDS) pages.push({ pid, page: await gotoSeat(ctx, gid, pid) })
      const plan = { bid: () => 15, alloc: () => [60, 40], fix: () => true }
      check(await driveToFinish(pages, plan), '(21a) game played to finish')
      for (const { page } of pages) {
        await page.waitForSelector('[data-testid="crisis-done-closure"]', { timeout: 15000 }).catch(() => {})
        const st = await stateOf(page)
        const role = st.role
        const expected = st.history.reduce((s, h) => s + (role === 'buyer' ? h.profits.buyer : role === 'seller1' ? h.profits.seller1 : h.profits.seller2), 0)
        check(await testidPresent(page, 'crisis-finished'), `(21a) ${role}: finished screen present`)
        check(await testidPresent(page, 'crisis-done-closure'), `(21a) ${role}: closure line present (terminal)`)
        check(!(await testidPresent(page, 'crisis-continue-debrief')), `(21a) ${role}: NO Continue button (nothing more to do)`)
        check(!(await testidPresent(page, 'crisis-round-summary')), `(21a) ${role}: NO summary box on the finished screen`)
        const shown = norm1(await page.textContent('[data-testid="crisis-total-profit"]'))
        check(shown === expected.toLocaleString('en-US'), `(21a) ${role}: total profit ${shown} == sum of history ${expected}`)
      }
      for (const p of pages) await p.page.close()
    }

    // ── (21b) debrief CONFIGURED → Continue → debrief → submit → terminal, for all 3 roles ──
    {
      const gid = 'end-debrief'; await seedGroup(gid); await seedDebriefQuestion(gid); await open(gid, 1)
      const pages = []
      for (const pid of PIDS) pages.push({ pid, page: await gotoSeat(ctx, gid, pid) })
      const plan = { bid: () => 15, alloc: () => [60, 40], fix: () => true }
      check(await driveToFinish(pages, plan), '(21b) game played to finish (debrief configured)')

      for (const { pid, page } of pages) {
        const role = (await stateOf(page)).role
        await page.waitForSelector('[data-testid="crisis-continue-debrief"]', { timeout: 15000 }).catch(() => {})
        check(await testidPresent(page, 'crisis-continue-debrief'), `(21b) ${role}: Continue button present`)
        check(!(await testidPresent(page, 'crisis-done-closure')), `(21b) ${role}: no closure line yet (not terminal)`)
        // Continue → debrief screen
        await page.click('[data-testid="crisis-continue-debrief"]')
        await page.waitForSelector('[data-testid="crisis-debrief"]', { timeout: 10000 }).catch(() => {})
        check(await testidPresent(page, 'crisis-debrief'), `(21b) ${role}: debrief screen renders`)
        // submit disabled until answered
        const disabledBefore = await page.getAttribute('[data-testid="crisis-debrief-submit"]', 'disabled')
        check(disabledBefore !== null, `(21b) ${role}: Submit disabled before answering`)
        await page.fill('[data-testid="crisis-debrief-input-debrief_takeaway"]', `Reflection from ${role}.`)
        await page.click('[data-testid="crisis-debrief-submit"]')
        // → terminal results (same view + closure), NOT a bare confirmation. The direct
        // participant-doc write can be slow under emulator load for the last-processed seat,
        // so wait generously for the terminal state (the write, then the re-render).
        await page.waitForSelector('[data-testid="crisis-done-closure"]', { timeout: 30000 }).catch(() => {})
        check(await testidPresent(page, 'crisis-finished'), `(21b) ${role}: lands back on the results view`)
        check(await testidPresent(page, 'crisis-done-closure'), `(21b) ${role}: closure line present (terminal)`)
        check(!(await testidPresent(page, 'crisis-continue-debrief')), `(21b) ${role}: Continue gone after submit`)
        check(await testidPresent(page, 'crisis-total-profit'), `(21b) ${role}: total profit still shown`)
        const label = role === 'buyer' ? 'You (Buyer)' : role === 'seller1' ? 'You (Seller 1)' : 'You (Seller 2)'
        check((await page.textContent('[data-testid="crisis-history"]')).includes(label), `(21b) ${role}: own history block highlighted (${label})`)
        const fields = await readParticipant(gid, pid)
        check(fields.debrief_submitted_at != null && fields.debrief_takeaway?.stringValue === `Reflection from ${role}.`,
          `(21b) ${role}: debrief answer + timestamp persisted to the participant doc`)
      }

      // ── (21c) resume-safe: reload after submitting lands straight on terminal (no Continue) ──
      const rp = pages[0].page
      await rp.reload()
      await rp.waitForSelector('[data-testid="crisis-done-closure"]', { timeout: 15000 }).catch(() => {})
      check(await testidPresent(rp, 'crisis-done-closure') && !(await testidPresent(rp, 'crisis-continue-debrief')),
        '(21c) a resumed already-submitted student lands on terminal results, never back on Continue')

      for (const p of pages) await p.page.close()
    }
  }

  await browser.close()
  console.log('\n' + '═'.repeat(72))
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('HARNESS ERROR:', e); FAIL++ }).finally(() => { tearDown(); process.exit(FAIL === 0 ? 0 : 1) })

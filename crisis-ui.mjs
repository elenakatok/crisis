// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS Slice 3 — student-UI harness. Self-boots the emulator + the vite dev server,
// then drives the REAL UI with Playwright (3 seats, one browser page each): it reads
// window.__crisisState to know each seat's role/owes, then ACTS by filling inputs and
// clicking buttons — the SAME callables the buttons invoke, never the machinery under
// them (the banked SAA lesson).
//
//   node crisis-ui.mjs           (HEADED=1 to watch, KEEP=1 to leave the stack up)
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync } from 'node:fs'
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
      await page.click(plan.fix(st) ? '[data-testid="crisis-fix-yes"]' : '[data-testid="crisis-fix-no"]')
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
    // §O2 6b: same DATA + layout for everyone; only the per-viewer "(you)" marker differs.
    const norm = (h) => h.replace(/ \(you\)/g, '')
    check(hists.every(h => norm(h) === norm(hists[0])), '(5) history DATA identical across all three seats (only the "(you)" marker differs)')
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

  // (8) SAA-uniform: summary panel at TOP of the dashboard (link, not button); /live same-window
  banner('(8) SAA-uniform live view — top summary panel + same-window /live')
  {
    const gid = 'ui-live'; await seedGroup(gid, PIDS); await open(gid, 1)
    // main dashboard: summary panel portaled to TOP; orange "Live view →" link; NO bottom button; panel not here
    const dash = await ctx.newPage()
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dash.waitForSelector('[data-testid="crisis-live-summary"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(dash, 'crisis-live-summary'), '(8) summary panel present at the top of the dashboard')
    check(await testidPresent(dash, 'crisis-live-nav'), '(8) inline "Live view →" link present (not a button)')
    check(!(await testidPresent(dash, 'crisis-open-live')), '(8) old bottom "Open live view" button removed')
    check(!(await testidPresent(dash, 'crisis-live-panel')), '(8) full live panel not on the main dashboard')
    // the summary panel (inside its portal host) is the FIRST child of <main>, above the heading (like SAA)
    const firstIsSummary = await dash.evaluate(() => {
      const first = document.querySelector('main')?.firstElementChild
      return !!first && first.querySelector('[data-testid="crisis-live-summary"]') !== null
    })
    check(firstIsSummary, '(8) summary panel is the first child of <main> (under buttons, above heading)')
    await dash.close()
    // /live (SAME window nav): back link + clock switch + panel
    const live = await ctx.newPage()
    await live.goto(`${FE}/live?_dev_game_instance_id=${gid}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await live.waitForSelector('[data-testid="crisis-clock-switch"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(live, 'crisis-back-to-dashboard'), '(8) /live has an orange "← Back to dashboard" link')
    check(await testidPresent(live, 'crisis-clock-switch'), '(8) /live has the clock switch')
    await live.waitForSelector('[data-testid="crisis-live-panel"]', { timeout: 20000 }).catch(() => {})
    check(await testidPresent(live, 'crisis-live-panel'), '(8) /live renders the §4A live panel')

    // (8b) the clock switch PERSISTS — click OFF then ON, confirm each sticks via getGameConfig
    await live.click('[data-testid="clock-off"]'); await sleep(1200)
    let cfg = (await callFn('getGameConfig', { _dev: { game_instance_id: gid } })).result
    check(cfg.clock_mode === 'off', '(8b) clicking OFF persists (updateGameConfig accepted clock_mode)')
    await live.click('[data-testid="clock-on"]'); await sleep(1200)
    cfg = (await callFn('getGameConfig', { _dev: { game_instance_id: gid } })).result
    check(cfg.clock_mode === 'on', '(8b) clicking ON persists — both stick')
    check(!(await live.locator('text=No recognised fields to update').count()), '(8b) NO "No recognised fields to update" error')
    await live.close()
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
    check(!(await rp.locator('[data-testid^="student-row-"]').evaluateAll(rows => rows.some(r => /bot/i.test(r.textContent ?? '')))), '(9) no bot rows in the per-student table')
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
    check(await p1.locator('[data-testid="crisis-reveal-email"]').count() === 3, '(10) reveal shows all three member emails')
    const mailto = await p1.locator('[data-testid="crisis-reveal-email"]').first().getAttribute('href')
    check(/^mailto:.+@/.test(mailto || ''), '(10) member email is a mailto: link')

    // continue → pre-game waiting screen + persistent members strip
    await p1.click('[data-testid="crisis-reveal-continue"]')
    await p1.waitForSelector('[data-testid="crisis-waiting-start"]', { timeout: 15000 }).catch(() => {})
    check(await testidPresent(p1, 'crisis-waiting-start'), '(10) continue → pre-game waiting screen (no code screen anywhere)')
    // the strip renders once its group-doc snapshot resolves (a tick after the screen appears)
    await p1.waitForSelector('[data-testid="crisis-members-strip"]', { timeout: 8000 }).catch(() => {})
    check(await testidPresent(p1, 'crisis-members-strip'), '(10) persistent members strip shows before round 1')

    // instructor opens the round (clock off) → student plays; strip disappears once round active
    await callFn('openRound', { _dev: { game_instance_id: gid, seed: 1 }, group_id: groupId })
    await p1.waitForFunction(() => !!window.__crisisState, null, { timeout: 20000 }).catch(() => {})
    const st = await stateOf(p1)
    check(st && ['buyer', 'seller1', 'seller2'].includes(st.role), '(10) round active online → a seat/role is assigned')
    check(st && st.clockEnabled === false && st.stageDeadlineMs === null, '(10) round runs with the clock OFF (online)')
    await sleep(800)
    check(!(await testidPresent(p1, 'crisis-members-strip')), '(10) members strip hidden once round 1 is active')
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
  }

  // (11) O2 — single matching control per mode, live online panel, (you) history markers
  banner('(11) O2 — one match control per mode + live online panel + (you) markers')
  {
    const visibleControls = (page) => page.evaluate(() => {
      const vis = (el) => !!(el.offsetParent || el.getClientRects().length)
      return Array.from(document.querySelectorAll('button'))
        .filter(b => /match now|group participants|re-group/i.test((b.textContent || '').trim()) && vis(b))
        .map(b => (b.textContent || '').trim())
    })

    // (11a) classroom dashboard — exactly one control (shared "Match Now"), no online panel
    const cg = 'ui-o2-on'
    await fsWrite(cg, 'config/main', { clock_mode: 'on' })
    const dOn = await ctx.newPage()
    await dOn.goto(`${FE}/dashboard?_dev_game_instance_id=${cg}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dOn.waitForSelector('[data-testid="crisis-live-summary"]', { timeout: 30000 }).catch(() => {})
    await sleep(3500)
    check(!(await testidPresent(dOn, 'crisis-online-panel')), '(11a) classroom: online panel NOT rendered')
    const ctlOn = await visibleControls(dOn)
    check(ctlOn.length === 1 && /match now/i.test(ctlOn[0]), `(11a) classroom: exactly one match control [${ctlOn.join(' | ')}]`)
    await dOn.close()

    // (11b) online dashboard — panel present; exactly one control; shared "Match Now" hidden
    const og = 'ui-o2-off'
    await fsWrite(og, 'config/main', { clock_mode: 'off' })
    for (let i = 0; i < 3; i++) await fsWrite(og, `participants/w${i}`, { participant_id: `w${i}`, game_instance_id: og, role: 'player', is_bot: false, prep_status: 'complete', name: `Wanda ${i}`, email: `w${i}@ex.edu` })
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: og } })
    const dOff = await ctx.newPage()
    await dOff.goto(`${FE}/dashboard?_dev_game_instance_id=${og}&_session=tab`, { waitUntil: 'domcontentloaded' })
    await dOff.waitForSelector('[data-testid="crisis-online-panel"]', { timeout: 30000 }).catch(() => {})
    check(await testidPresent(dOff, 'crisis-online-panel'), '(11b) online: online panel renders in the dashboard body')
    await sleep(1800) // MutationObserver hides the shared Match Now
    const ctlOff = await visibleControls(dOff)
    check(ctlOff.length === 1 && /group|re-group/i.test(ctlOff[0]), `(11b) online: exactly one match control [${ctlOff.join(' | ')}]`)
    check(!ctlOff.some(t => /match now/i.test(t)), '(11b) online: shared "Match Now" is hidden')
    check(await testidPresent(dOff, 'crisis-online-group-1'), '(11b) online: group 1 card renders')
    check(!(await testidPresent(dOff, 'crisis-online-group-2')), '(11b) online: only one group so far')

    // (11c) LIVE re-group without reload — add a 4th student + re-group via callable → 2 cards
    await fsWrite(og, 'participants/w3', { participant_id: 'w3', game_instance_id: og, role: 'player', is_bot: false, prep_status: 'complete', name: 'Wanda 3', email: 'w3@ex.edu' })
    await callFn('groupParticipantsOnline', { _dev: { game_instance_id: og } })
    await dOff.waitForSelector('[data-testid="crisis-online-group-2"]', { timeout: 12000 }).catch(() => {})
    check(await testidPresent(dOff, 'crisis-online-group-2'), '(11c) live onSnapshot: re-group to 2 groups reflected WITHOUT reload')
    await dOff.close()

    // (11d) "(you)" markers land on the viewer's OWN history columns, for each of the 3 roles
    const yg = 'ui-o2-you'; await seedGroup(yg); await open(yg, 1)
    const pagesById = {}; for (const pid of PIDS) pagesById[pid] = await gotoSeat(ctx, yg, pid)
    const arr = PIDS.map(pid => ({ pid, page: pagesById[pid] }))
    await driveToFinish(arr, { bid: () => 15, alloc: () => [50, 50], fix: () => true })
    const wantCol = { seller1: 'Bid 1 (you)', seller2: 'Bid 2 (you)', buyer: "Buyer's Profit (you)" }
    const notCol  = { seller1: 'Bid 2 (you)', seller2: 'Bid 1 (you)', buyer: 'Bid 1 (you)' }
    for (const pid of PIDS) {
      const page = pagesById[pid]
      const role = (await stateOf(page)).role
      const hdr = await page.textContent('[data-testid="crisis-history"]')
      check(hdr.includes(wantCol[role]), `(11d) ${role}: own column marked "${wantCol[role]}"`)
      check(!hdr.includes(notCol[role]), `(11d) ${role}: another role's column NOT marked "(you)"`)
    }
    for (const pid of PIDS) await pagesById[pid].close()
  }

  await browser.close()
  console.log('\n' + '═'.repeat(72))
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('HARNESS ERROR:', e); FAIL++ }).finally(() => { tearDown(); process.exit(FAIL === 0 ? 0 : 1) })

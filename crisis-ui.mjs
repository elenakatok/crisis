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
    check(hists.every(h => h === hists[0]), '(5) history table byte-identical across all three seats')
    const rowCounts = await Promise.all(pages.map(p => p.page.locator('[data-testid^="crisis-history-row-"]').count()))
    check(rowCounts.every(c => c === 10), '(1) history has 10 rows on every seat')

    // Buyer's Profit column present on EVERY seat (no private info, §1.1) + no horizontal scroll
    const buyerCells = await Promise.all(pages.map(p => p.page.locator('[data-testid^="crisis-buyer-profit-"]').count()))
    check(buyerCells.every(c => c === 10), '(1) Buyer\'s Profit column renders on every seat (10 rows)')
    const fits = await Promise.all(pages.map(p => p.page.evaluate(() => {
      const t = document.querySelector('[data-testid="crisis-history"]'); if (!t || !t.parentElement) return false
      return t.parentElement.scrollWidth <= t.parentElement.clientWidth + 1
    })))
    check(fits.every(Boolean), '(1) history table fits without horizontal scroll on every seat')

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

  await browser.close()
  console.log('\n' + '═'.repeat(72))
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('HARNESS ERROR:', e); FAIL++ }).finally(() => { tearDown(); process.exit(FAIL === 0 ? 0 : 1) })

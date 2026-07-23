// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS ROBOT MODE — the BROWSER runner (§5.5). Fills N seats of a live Crisis game
// with robots that PLAY THROUGH THE REAL UI in headed, tiled Chromium windows Elena can
// watch. Per seat the driver:
//   1. mints a token + drives login→KC→prep→attendance→ready via the EXISTING launcher
//      (POST /api/student-url {mode:'ready'}) — nothing reimplemented here.
//   2. opens a tiled headed window at the ?token= game URL.
//   3. waits for the game to start (the instructor matches + clicks "Start game" on the
//      dashboard), then runs the read → decide → ACT-VIA-UI → wait loop until finished.
//
// READ PATH (§5.5 — the whole point): it reads window.__crisisState DIRECTLY (exactly what
// getRoundView returns). NO testid scraping — a label/testid rename cannot break it.
// ACT PATH: bids/allocations/fixes go THROUGH THE UI (fill the input, click the button) —
// that is what makes a robot run a real test of the frontend.
//
// STRATEGY: the SAME decide() the server seat-filler uses — imported INWARD from
// functions/lib (Slice-1 finding: no mirror). Each seat draws a fixed Seller type once
// (used iff it becomes a Seller); the Buyer runs the buyer default.
//
// Usage: node robot-driver.mjs --instance <id> [--seats 3] [--pace watch|fast]
//                              [--launcher http://localhost:5180] [--screen 1920x1080]
// Prereq: functions built (npm run build in ../functions), launcher running, and from the
// dashboard the instructor generates an attendance code, then matches + starts the game.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import {
  drawSellerType, sellerDefaultBid, sellerDefaultFix, buyerDefaultAllocation,
} from '../functions/lib/round/decide.js'
import { DEFAULT_CRISIS_SETTINGS as S } from '../functions/lib/round/settings.js'

// Playwright is resolved from games/crisis/node_modules (installed for the harnesses); the
// bot dir has none of its own. createRequire walks up from here to find it.
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

// ── CLI ──────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
  }
  return a
}
const args = parseArgs(process.argv.slice(2))
const INSTANCE = args.instance
const SEATS = Math.max(1, Math.min(16, Number(args.seats) || 3))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  process.exit(1)
}

const THINK = PACE === 'watch' ? { min: 5000, max: 15000 } : { min: 700, max: 1400 }
const POLL_MS = 1500
const GAME_START_TIMEOUT_MS = 15 * 60 * 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const thinkTime = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))

// ── grid tiling ──────────────────────────────────────────────────────────────────
function gridCell(index, count) {
  const n = Math.max(1, count | 0)
  const cols = COLS_OVERRIDE ?? Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cellW = Math.floor(SCREEN_W / cols), cellH = Math.floor(SCREEN_H / rows)
  const GUTTER = 6
  return { x: (index % cols) * cellW, y: Math.floor(index / cols) * cellH, w: cellW - GUTTER, h: cellH - GUTTER }
}

// ── launcher reuse ─────────────────────────────────────────────────────────────────
async function mintReadyUrl(index) {
  const res = await fetch(`${LAUNCHER}/api/student-url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_instance_id: INSTANCE, index, mode: 'ready' }),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { throw new Error(`launcher → ${res.status}: ${text.slice(0, 160)}`) }
  if (json.error) throw new Error(json.error)
  return json // { name, url }
}
const launcherReachable = async () => { try { return (await fetch(`${LAUNCHER}/api/games`)).ok } catch { return false } }

// ── read: window.__crisisState (NO scraping) ────────────────────────────────────────
const readState = (page) => page.evaluate(() => window.__crisisState ?? null)

// ── decide via the SHARED decide()/primitives, then ACT through the UI ───────────────
function priorFixCounts(history) {
  let f1 = 0, f2 = 0
  for (const h of history) { if (h.crisisOccurred && h.fixed.s1) f1++; if (h.crisisOccurred && h.fixed.s2) f2++ }
  return { f1, f2 }
}
async function actViaUI(page, view, seatType) {
  if (view.owes === 'bid') {
    const bid = sellerDefaultBid(seatType, Math.random, S) // Seller: bid from the seat's FIXED type
    await page.fill('[data-testid="crisis-bid-input"]', String(bid))
    await page.click('[data-testid="crisis-submit"]')
    return `bid ${bid}`
  }
  if (view.owes === 'allocation') {
    const { f1, f2 } = priorFixCounts(view.history)
    const { a1, a2 } = buyerDefaultAllocation(view.currentBids.s1, view.currentBids.s2, f1, f2, S)
    await page.fill('[data-testid="crisis-alloc-1"]', String(a1))
    await page.fill('[data-testid="crisis-alloc-2"]', String(a2))
    await page.click('[data-testid="crisis-submit"]')
    return `allocate ${a1}/${a2}`
  }
  if (view.owes === 'fix') {
    const fix = sellerDefaultFix(seatType)
    await page.click(fix ? '[data-testid="crisis-fix-yes"]' : '[data-testid="crisis-fix-no"]')
    return `fix ${fix ? 'yes' : 'no'}`
  }
  return null
}

// ── per-seat play loop ───────────────────────────────────────────────────────────────
async function playSeat(seat) {
  const { page, label, type } = seat
  try {
    await page.waitForFunction(() => !!window.__crisisState, null, { timeout: GAME_START_TIMEOUT_MS })
  } catch { console.error(`  [${label}] game never started within timeout.`); return }
  console.log(`  [${label}] game started — playing (seat type ${type}).`)

  while (true) {
    let view; try { view = await readState(page) } catch { await sleep(POLL_MS); continue }
    if (!view) { await sleep(POLL_MS); continue }
    if (view.status === 'finished') { console.log(`  [${label}] FINISHED as ${view.role}.`); break }
    if (view.owes === null) { await sleep(POLL_MS); continue }

    await sleep(thinkTime())
    let fresh; try { fresh = await readState(page) } catch { await sleep(POLL_MS); continue }
    if (!fresh || fresh.status === 'finished' || fresh.owes === null) continue
    try {
      const desc = await actViaUI(page, fresh, type)
      if (desc) console.log(`  [${label}] round ${fresh.round} (${fresh.role}): ${desc}`)
    } catch (e) { console.error(`  [${label}] action failed: ${e.message}`) }
    await sleep(POLL_MS)
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nCrisis robot mode — instance ${INSTANCE}, ${SEATS} seats, pace=${PACE}\n`)
  if (!(await launcherReachable())) { console.error(`Launcher not reachable at ${LAUNCHER}. Start it first.`); process.exit(1) }

  console.log('Phase A — minting tokens + driving seats to ready (login → KC → prep → attendance)…')
  const seats = []
  for (let i = 0; i < SEATS; i++) {
    try {
      const { name, url } = await mintReadyUrl(i)
      seats.push({ index: i, name, url, label: `seat ${i + 1}/${name}`, type: drawSellerType(Math.random) })
      console.log(`  ✓ seat ${i + 1} ready — ${name}`)
    } catch (e) { console.error(`  ✗ seat ${i + 1} drive-to-ready failed: ${e.message}`) }
  }
  if (!seats.length) { console.error('\nNo seats reached ready. (Has the instructor generated an attendance code?)'); process.exit(1) }

  console.log('\nPhase B — opening headed windows…')
  for (const seat of seats) {
    try {
      const cell = gridCell(seat.index, seats.length)
      const browser = await chromium.launch({ headless: false, args: [`--window-position=${cell.x},${cell.y}`, `--window-size=${cell.w},${cell.h}`] })
      const page = await (await browser.newContext({ viewport: null })).newPage()
      await page.goto(seat.url, { waitUntil: 'domcontentloaded' })
      seat.browser = browser; seat.page = page
      console.log(`  ✓ window open — ${seat.name}`)
    } catch (e) { console.error(`  ✗ window for ${seat.name} failed: ${e.message}`) }
  }
  const live = seats.filter((s) => s.page)
  if (!live.length) { console.error('\nNo windows opened.'); process.exit(1) }

  console.log(`\n${live.length} windows are on the waiting-to-match screen.`)
  console.log('From the Crisis instructor dashboard now:  (1) Trigger matching   (2) Click "Start game".')
  console.log('Robots start playing the moment the game screen appears.\n')

  await Promise.allSettled(live.map((seat) => playSeat(seat)))
  console.log('\nAll seats finished. Windows left OPEN on their final screens. Ctrl-C to exit.')
  await new Promise(() => {})
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })

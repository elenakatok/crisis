// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS Slice 2 — round-loop harness. Self-boots the emulator (build functions, start
// auth/functions/firestore/database) and drives the SAME callable names the Slice-3 UI
// will invoke — openRound / submitBid / submitAllocation / submitFix / checkRoundClock /
// getRoundView / getInstructorRoundView — NEVER the machine directly (the banked SAA
// lesson: a harness that calls the function under the button can pass while the button is
// dead).
//
//   node crisis-round-loop.mjs        (env KEEP=1 leaves the stack up)
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT   = 'crisis-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const PORTS     = [9101, 5005, 8082, 9002]

// A virtual clock far ahead of any real Date.now()-based deadline, so a checkRoundClock
// with this `now_ms` always crosses the stage deadline. Advance it (> stage 120s) per tick.
let VT = Date.now() + 1_000_000_000
const tickNow = () => { const t = VT; VT += 200_000; return t }

// ── tiny assert framework ─────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (cond, name) => { if (cond) { PASS++; console.log(`  ✓ ${name}`) } else { FAIL++; console.log(`  ✗ FAIL: ${name}`) } }

// ── callable + REST helpers ───────────────────────────────────────────────────────
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev     = (gid, extra = {})      => ({ _dev: { game_instance_id: gid }, ...extra })

async function seedGroup(gid, pids) {
  const res = await fetch(`${FUNCTIONS}/seedGroupForTest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_instance_id: gid, group_id: 'g', player_participants: pids }),
  })
  return res.ok
}
async function fsGet(gid, suffix) {
  const res = await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}`, { headers: { Authorization: 'Bearer owner' } })
  return res.ok ? res.json() : null
}

// ── domain helpers (act by ROLE — roles are assigned late, so we read them back) ──
const PIDS = ['pa', 'pb', 'pc']
const open   = (gid, seed, now) => callFn('openRound', asDev(gid, { group_id: 'g', _dev: { game_instance_id: gid, seed, ...(now != null ? { now_ms: now } : {}) } }))
const iview  = (gid) => callFn('getInstructorRoundView', asDev(gid, { group_id: 'g' }))
const sview  = (gid, pid) => callFn('getRoundView', asStudent(gid, pid, { group_id: 'g' }))
const bid    = (gid, pid, amt, now) => callFn('submitBid', asStudent(gid, pid, { group_id: 'g', bid: amt, ...(now != null ? { _dev: { participant_id: pid, game_instance_id: gid, now_ms: now } } : {}) }))
const alloc  = (gid, pid, a1, a2, now) => callFn('submitAllocation', asStudent(gid, pid, { group_id: 'g', a1, a2, ...(now != null ? { _dev: { participant_id: pid, game_instance_id: gid, now_ms: now } } : {}) }))
const fix    = (gid, pid, f, now) => callFn('submitFix', asStudent(gid, pid, { group_id: 'g', fixed: f, ...(now != null ? { _dev: { participant_id: pid, game_instance_id: gid, now_ms: now } } : {}) }))
const tick   = (gid, now) => callFn('checkRoundClock', asDev(gid, { group_id: 'g', _dev: { game_instance_id: gid, now_ms: now } }))

/** role → pid, read from the instructor view after open (roles assigned late). */
async function roleMap(gid) {
  const v = (await iview(gid)).result
  const m = {}
  for (const s of v.seats) m[s.role] = s.participantId
  return m
}

/** Drive one full round of human play; returns the post-round instructor view. */
async function playRound(gid, rm, { b1, b2, a1, a2, f1, f2 }) {
  await bid(gid, rm.seller1, b1)
  await bid(gid, rm.seller2, b2)
  await alloc(gid, rm.buyer, a1, a2)
  let v = (await iview(gid)).result
  if (v.stage === 'fixing') {
    for (const s of v.seats) {
      if (s.role === 'seller1' && a1 > 0) await fix(gid, rm.seller1, f1 ?? false)
      if (s.role === 'seller2' && a2 > 0) await fix(gid, rm.seller2, f2 ?? false)
    }
  }
  return (await iview(gid)).result
}

/** Find a seed whose ROUND-1 crisis draw == want, using a throwaway instance. */
async function seedForRound1Crisis(want) {
  for (let seed = 1; seed < 400; seed++) {
    const gid = `probe-${want}-${seed}`
    await seedGroup(gid, PIDS)
    await open(gid, seed)
    const rm = await roleMap(gid)
    await bid(gid, rm.seller1, 15)
    await bid(gid, rm.seller2, 15)
    await alloc(gid, rm.buyer, 50, 50)
    const v = (await iview(gid)).result
    const gotCrisis = v.stage === 'fixing'
    const advancedNoCrisis = v.round === 2
    if (want && gotCrisis) return seed
    if (!want && advancedNoCrisis) return seed
  }
  throw new Error(`no seed found for crisis=${want}`)
}

// ── stack lifecycle ───────────────────────────────────────────────────────────────
const children = []
function freePorts() { for (const p of PORTS) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ }
    if (Date.now() - start > maxMs) throw new Error(`${label} never ready`)
    await sleep(600)
  }
}
async function bringUp() {
  banner('BOOT — build functions, boot emulators (auth/functions/firestore/database)')
  freePorts(); await sleep(1000)
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'round-loop-emu.log'), 'a')
  const child = spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT],
    { cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog] })
  children.push(child)
  await waitHttp('http://localhost:8082/', 'firestore')
  await waitHttp('http://localhost:9002/.json', 'database')
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ }
    if (Date.now() - start > 120_000) throw new Error('functions never finished loading')
    await sleep(800)
  }
  await sleep(1000)
  console.log('  Stack ready ✅')
}
function tearDown() {
  if (process.env.KEEP === '1') return
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } }
  freePorts()
}

// ── the suite ───────────────────────────────────────────────────────────────────
async function main() {
  await bringUp()

  // (1) clean 10-round playthrough, 3 humans, no timeouts
  banner('(1) clean 10-round playthrough — 3 humans, no timeouts')
  {
    const gid = 'clean'
    await seedGroup(gid, PIDS)
    const o = await open(gid, 1)
    check(o.ok && o.result?.ok, 'openRound ok')
    const rm = await roleMap(gid)
    check(rm.buyer && rm.seller1 && rm.seller2 && new Set([rm.buyer, rm.seller1, rm.seller2]).size === 3, 'roles assigned late — 1 buyer + 2 distinct sellers')
    let v
    for (let r = 1; r <= 10; r++) v = await playRound(gid, rm, { b1: 15, b2: 18, a1: 60, a2: 40, f1: true, f2: false })
    check(v.status === 'finished', 'finished after exactly 10 rounds')
    check(v.history.length === 10, 'history has 10 rows')
    check(v.history.every(h => h.bids.s1 === 15 && h.bids.s2 === 18), 'every row records the submitted bids')
  }

  // (2) group locks at first submission
  banner('(2) group locks at first submission (§6)')
  {
    const gid = 'lock'
    await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    check((await fsGet(gid, 'groups/g'))?.fields?.seats_locked_at == null, 'not locked before any submission')
    await bid(gid, rm.seller1, 15)
    check((await fsGet(gid, 'groups/g'))?.fields?.seats_locked_at != null, 'seats_locked_at stamped on first submission')
  }

  // (3) timeout at BIDDING — idle sellers get defaults, stage closes automatically
  banner('(3) timeout at each stage — BIDDING')
  {
    const gid = 't-bid'
    await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    const t = await tick(gid, tickNow())
    check(t.result?.closed, 'clock closed the bidding stage')
    const v = (await iview(gid)).result
    check(v.stage === 'allocation', 'advanced to allocation')
    check(v.seats.find(s => s.role === 'seller1').timeouts.some(e => e.stage === 'bidding'), 'seller1 bidding timeout recorded (round+stage)')
    check(v.seats.find(s => s.role === 'seller2').timeouts.some(e => e.stage === 'bidding'), 'seller2 bidding timeout recorded')
  }

  // (4) timeout at ALLOCATION — buyer default
  banner('(4) timeout at each stage — ALLOCATION')
  {
    const gid = 't-alloc'
    await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    await bid(gid, rm.seller1, 14); await bid(gid, rm.seller2, 25)
    const t = await tick(gid, tickNow())
    check(t.result?.closed, 'clock closed the allocation stage')
    const v = (await iview(gid)).result
    check(v.seats.find(s => s.role === 'buyer').timeouts.some(e => e.stage === 'allocation'), 'buyer allocation timeout recorded')
  }

  // (5) timeout at FIXING — required sellers defaulted
  banner('(5) timeout at each stage — FIXING (crisis round)')
  {
    const seed = await seedForRound1Crisis(true)
    const gid = 't-fix'
    await seedGroup(gid, PIDS); await open(gid, seed)
    const rm = await roleMap(gid)
    await bid(gid, rm.seller1, 25); await bid(gid, rm.seller2, 14) // real bids: ≥20 fix / <20 no-fix
    await alloc(gid, rm.buyer, 50, 50)
    check((await iview(gid)).result.stage === 'fixing', 'crisis → fixing stage')
    const t = await tick(gid, tickNow())
    check(t.result?.closed, 'clock closed the fixing stage')
    const v = (await iview(gid)).result
    check(v.history.length === 1, 'round resolved via defaults')
    check(v.history[0].fixed.s1 === true && v.history[0].fixed.s2 === false, 'fix derived from real bids (25→fix, 14→no)')
  }

  // (6) every seat times out in the same round
  banner('(6) every seat times out in the same round')
  {
    const seed = await seedForRound1Crisis(true)
    const gid = 'allto'
    await seedGroup(gid, PIDS); await open(gid, seed)
    await tick(gid, tickNow()) // bidding defaults
    check((await iview(gid)).result.stage === 'allocation', 'bidding auto-closed')
    await tick(gid, tickNow()) // allocation default → crisis draw → fixing
    check((await iview(gid)).result.stage === 'fixing', 'allocation auto-closed → fixing')
    await tick(gid, tickNow()) // fixing defaults → resolve
    const v = (await iview(gid)).result
    check(v.round === 2 && v.history.length === 1, 'round fully resolved from defaults')
    check(v.history[0].defaulted.buyer && v.history[0].defaulted.s1 && v.history[0].defaulted.s2, 'all three roles marked defaulted')
  }

  // (7) no-crisis round skips fixing
  banner('(7) no-crisis round skips stage 3')
  {
    const seed = await seedForRound1Crisis(false)
    const gid = 'nocrisis'
    await seedGroup(gid, PIDS); await open(gid, seed)
    const rm = await roleMap(gid)
    await bid(gid, rm.seller1, 15); await bid(gid, rm.seller2, 15)
    await alloc(gid, rm.buyer, 50, 50)
    const v = (await iview(gid)).result
    check(v.round === 2 && v.history.length === 1, 'resolved straight to round 2 (no fix stage)')
    check(v.history[0].crisisOccurred === false, 'round recorded no crisis')
  }

  // (8) a seller with 0 units — fixing must not wait on them
  banner('(8) a Seller allocated 0 units has no fix decision')
  {
    const seed = await seedForRound1Crisis(true)
    const gid = 'zero'
    await seedGroup(gid, PIDS); await open(gid, seed)
    const rm = await roleMap(gid)
    await bid(gid, rm.seller1, 15); await bid(gid, rm.seller2, 22)
    await alloc(gid, rm.buyer, 100, 0) // seller2 gets 0
    const v1 = (await iview(gid)).result
    check(v1.stage === 'fixing' && v1.pendingSeats.length === 1, 'only ONE seat pending in fixing (the 0-unit seller excluded)')
    const r = await fix(gid, rm.seller2, true) // 0-unit seller tries to fix
    check(r.result?.ok === false, '0-unit seller fix rejected')
    await fix(gid, rm.seller1, true) // the only required seat acts → round closes
    check((await iview(gid)).result.round === 2, 'round closed without ever waiting on the 0-unit seller')
  }

  // (9) idempotency — firing the timeout twice must not double-advance
  banner('(9) idempotency — checkRoundClock fired twice')
  {
    const gid = 'idem'
    await seedGroup(gid, PIDS); await open(gid, 1)
    const now = tickNow()
    const t1 = await tick(gid, now)
    const roundAfter1 = (await iview(gid)).result.round
    const stageAfter1 = (await iview(gid)).result.stage
    const t2 = await tick(gid, now) // SAME now_ms → new deadline is in the future → no-op
    const v = (await iview(gid)).result
    check(t1.result?.closed === true, 'first tick closed the stage')
    check(t2.result?.closed === false, 'second tick (same clock) is a no-op')
    check(v.round === roundAfter1 && v.stage === stageAfter1, 'state unchanged by the duplicate tick — no double advance')
  }

  // (10) history is identical for all three seats (§1.1)
  banner('(10) history identical for all three seats (no private info)')
  {
    const gid = 'hist'
    await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    await playRound(gid, rm, { b1: 14, b2: 25, a1: 80, a2: 20, f1: false, f2: true })
    const hs = []
    for (const pid of PIDS) hs.push(JSON.stringify((await sview(gid, pid)).result.history))
    check(hs[0] === hs[1] && hs[1] === hs[2], 'all three getRoundView histories are byte-identical')
    // sealed bidding: mid-bidding a seat cannot see the other's pending bid
    const gid2 = 'sealed'
    await seedGroup(gid2, PIDS); await open(gid2, 1)
    const rm2 = await roleMap(gid2)
    await bid(gid2, rm2.seller1, 15)
    check((await sview(gid2, rm2.buyer)).result.currentBids === null, 'bids hidden mid-bidding (sealed)')
    await bid(gid2, rm2.seller2, 22)
    check((await sview(gid2, rm2.buyer)).result.currentBids != null, 'bids revealed once bidding closes')
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main()
  .catch(err => { console.error('HARNESS ERROR:', err); FAIL++ })
  .finally(() => { tearDown(); process.exit(FAIL === 0 ? 0 : 1) })

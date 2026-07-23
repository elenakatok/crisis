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
import http from 'node:http'
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

// ── Slice 4 dashboard helpers (the SAME callable the live panel invokes) ──────────
const dash = (gid) => callFn('getCrisisDashboard', asDev(gid, {}))
const groupN = (d, n) => d.groups.find(g => g.groupNumber === n)

function encVal(v) {
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'string')  return { stringValue: v }
  if (typeof v === 'number')  return { integerValue: String(v) }
  throw new Error('encVal')
}
async function fsWrite(gid, suffix, obj) {
  const fields = {}; for (const [k, v] of Object.entries(obj)) fields[k] = encVal(v)
  await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) })
}

// group-parameterized variants (multi-group instances)
const seedG   = (gid, groupId, pids) => fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: groupId, player_participants: pids }) })
const openG   = (gid, groupId, seed) => callFn('openRound', { _dev: { game_instance_id: gid, seed }, group_id: groupId })
const iviewG  = (gid, groupId) => callFn('getInstructorRoundView', { _dev: { game_instance_id: gid }, group_id: groupId })
const bidG    = (gid, groupId, pid, amt) => callFn('submitBid', { _test: { participant_id: pid, game_instance_id: gid }, group_id: groupId, bid: amt })
const allocG  = (gid, groupId, pid, a1, a2) => callFn('submitAllocation', { _test: { participant_id: pid, game_instance_id: gid }, group_id: groupId, a1, a2 })
const fixG    = (gid, groupId, pid, f) => callFn('submitFix', { _test: { participant_id: pid, game_instance_id: gid }, group_id: groupId, fixed: f })
async function roleMapG(gid, groupId) { const v = (await iviewG(gid, groupId)).result; const m = {}; for (const s of v.seats) m[s.role] = s.participantId; return m }

// ── Slice 5 bot helpers (drive the REAL matcher + the real bot runner) ────────────
const arrVal = (f) => (f?.arrayValue?.values ?? []).map(v => v.stringValue)
const seedRoster = (gid, pids) => fetch(`${FUNCTIONS}/seedRosterForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, participant_ids: pids }) })
const match      = (gid) => callFn('triggerMatching', asDev(gid, {}))          // the REAL chained matcher (the Match button's callable)
const runBots    = async (gid, groupId) => { const r = await fetch(`${FUNCTIONS}/runBotActionsForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: groupId }) }); return (await r.json())?.data ?? {} }
const rosterOf   = (gid) => callFn('getRoster', asDev(gid, {}))
async function groupDoc(gid, groupId) { return (await fsGet(gid, `groups/${groupId}`))?.fields ?? {} }
async function botPidsOf(gid, groupId) { return new Set(arrVal((await groupDoc(gid, groupId)).bot_participants)) }

/** Drive a mixed group to finish: humans act via callables, bots via the real bot runner. */
async function driveMixedToFinish(gid, groupId, humanPlan = { bid: 15, a1: 50, a2: 50, fix: true }, maxSteps = 400) {
  const botPids = await botPidsOf(gid, groupId)
  for (let step = 0; step < maxSteps; step++) {
    const v = (await iviewG(gid, groupId)).result
    if (v.status === 'finished') return v
    for (const seat of v.pendingSeats) {
      const s = v.seats.find(x => x.seat === seat)
      if (!s || botPids.has(s.participantId)) continue // a bot — it acts via runBots
      if (v.stage === 'bidding') await bidG(gid, groupId, s.participantId, humanPlan.bid)
      else if (v.stage === 'allocation') await allocG(gid, groupId, s.participantId, humanPlan.a1, humanPlan.a2)
      else if (v.stage === 'fixing') await fixG(gid, groupId, s.participantId, humanPlan.fix)
    }
    await runBots(gid, groupId) // bot seats act (idempotent)
  }
  return (await iviewG(gid, groupId)).result
}

// ── mock classroom callback — captures the pushed GameResults (the gradebook payload) ──
const CB_PORT = 5098
let captured = []
let cbServer = null
function startCallback() {
  return new Promise((res) => {
    cbServer = http.createServer((req, r) => {
      let b = ''; req.on('data', (c) => (b += c))
      req.on('end', () => { try { captured.push(JSON.parse(b)) } catch { /* */ } ; r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"ok":true}') })
    })
    cbServer.listen(CB_PORT, '127.0.0.1', res)
  })
}
/** Run scoreAndRecord pushing to the mock callback; returns the captured GameResults. */
async function scoreWithCapture(gid) {
  captured = []
  await callFn('scoreAndRecord', { _dev: { game_instance_id: gid, callback_url: `http://localhost:${CB_PORT}`, callback_secret: 'test' } })
  await sleep(600) // let the per-record POSTs land
  return captured
}

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
  if (cbServer) try { cbServer.close() } catch { /* */ }
  if (process.env.KEEP === '1') return
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } }
  freePorts()
}

// ── the suite ───────────────────────────────────────────────────────────────────
async function main() {
  await bringUp()
  await startCallback()

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

  // ══ SLICE 4 — the instructor dashboard WINDOW (getCrisisDashboard, §4A) ══════════

  // (D1) mid-stage: dashboard names the correct waiting seat, and it CHANGES as players act
  banner('(D1) dashboard names the waiting seat, and it changes as players act')
  {
    const gid = 'dash-wait'; await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    let g = groupN((await dash(gid)).result, 1)
    check(g.stage === 'bidding' && g.waitingOn.length === 2, '(D1) bidding → waiting on BOTH sellers')
    check(g.waitingOn.every(w => w.role === 'seller1' || w.role === 'seller2'), '(D1) waiting seats are the two sellers, named')
    await bid(gid, rm.seller1, 15)
    g = groupN((await dash(gid)).result, 1)
    check(g.waitingOn.length === 1 && g.waitingOn[0].role === 'seller2', '(D1) after seller1 bids → waiting on seller2 only')
    await bid(gid, rm.seller2, 18)
    g = groupN((await dash(gid)).result, 1)
    check(g.stage === 'allocation' && g.waitingOn.length === 1 && g.waitingOn[0].role === 'buyer', '(D1) allocation stage → waiting on the buyer')
  }

  // (D2) different groups on different rounds render correctly
  banner('(D2) two groups on different rounds')
  {
    const gid = 'dash-multi'
    await seedG(gid, 'gA', ['a1', 'a2', 'a3']); await seedG(gid, 'gB', ['b1', 'b2', 'b3'])
    await openG(gid, 'gA', 1); await openG(gid, 'gB', 1)
    // advance gA into round 2 (no crisis path or crisis path — drive generically)
    const rmA = await roleMapG(gid, 'gA')
    await bidG(gid, 'gA', rmA.seller1, 15); await bidG(gid, 'gA', rmA.seller2, 15)
    await allocG(gid, 'gA', rmA.buyer, 50, 50)
    let vA = (await iviewG(gid, 'gA')).result
    if (vA.stage === 'fixing') { for (const s of vA.pendingSeats) await fixG(gid, 'gA', (await roleMapG(gid, 'gA'))[vA.seats.find(x => x.seat === s).role], true) }
    const d = (await dash(gid)).result
    const gA = d.groups.find(x => x.groupId === 'gA'), gB = d.groups.find(x => x.groupId === 'gB')
    check(gA.round === 2 && gB.round === 1, '(D2) group A on round 2, group B on round 1')
    check(d.groups.length === 2, '(D2) both groups listed')
  }

  // (D3) a 0-unit seller is NOT shown as waited-on during the fix stage
  banner('(D3) 0-unit seller not shown as waited-on in fix')
  {
    // find a crisis seed
    let seed = null
    for (let s = 1; s < 400 && seed === null; s++) {
      const g = `dp-${s}`; await seedGroup(g, PIDS); await open(g, s)
      const rm = await roleMap(g); await bid(g, rm.seller1, 15); await bid(g, rm.seller2, 15); await alloc(g, rm.buyer, 50, 50)
      if ((await iview(g)).result.stage === 'fixing') seed = s
    }
    const gid = 'dash-zero'; await seedGroup(gid, PIDS); await open(gid, seed)
    const rm = await roleMap(gid)
    await bid(gid, rm.seller1, 15); await bid(gid, rm.seller2, 22); await alloc(gid, rm.buyer, 100, 0)
    const g = groupN((await dash(gid)).result, 1)
    check(g.stage === 'fixing', '(D3) group in fix stage')
    check(g.waitingOn.length === 1 && g.waitingOn[0].role === 'seller1', '(D3) waiting on ONLY the seller with units (0-unit seller excluded)')
  }

  // (D4) timeout counts render per participant
  banner('(D4) timeout counts render per participant')
  {
    const gid = 'dash-to'; await seedGroup(gid, PIDS); await open(gid, 1)
    await tick(gid, tickNow()) // both sellers time out bidding
    const g = groupN((await dash(gid)).result, 1)
    const sellers = g.seats.filter(s => s.role !== 'buyer')
    check(sellers.every(s => s.timeoutCount === 1), '(D4) each seller shows timeoutCount 1')
    check(sellers[0].timeouts[0].stage === 'bidding' && typeof sellers[0].timeouts[0].round === 'number', '(D4) timeout carries round + stage (§3.3), not a boolean')
  }

  // (D5) clock ON renders a deadline; clock OFF renders none
  banner('(D5) clock ON vs OFF on the dashboard')
  {
    const gOn = 'dash-on'; await seedGroup(gOn, PIDS); await open(gOn, 1)
    let g = groupN((await dash(gOn)).result, 1)
    check(g.clockEnabled === true && typeof g.stageDeadlineMs === 'number', '(D5) clock ON → deadline present')
    const gOff = 'dash-off'; await seedGroup(gOff, PIDS); await fsWrite(gOff, 'config/main', { clock_mode: 'off' }); await open(gOff, 1)
    g = groupN((await dash(gOff)).result, 1)
    check(g.clockEnabled === false && g.stageDeadlineMs === null, '(D5) clock OFF → no deadline (null)')
  }

  // (D6) a finished group renders as finished
  banner('(D6) finished group')
  {
    const gid = 'dash-fin'; await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    for (let r = 1; r <= 10; r++) await playRound(gid, rm, { b1: 15, b2: 18, a1: 60, a2: 40, f1: true, f2: false })
    const g = groupN((await dash(gid)).result, 1)
    check(g.status === 'finished', '(D6) dashboard shows the group finished')
  }

  // (D7) BOT FILTER in place ahead of Slice 5 — an is_bot seat is hidden
  banner('(D7) bot filter (ahead of Slice 5): is_bot seat hidden from the dashboard')
  {
    const gid = 'dash-bot'; await seedGroup(gid, PIDS)
    await fsWrite(gid, 'participants/pb', { is_bot: true }) // mark one seat a bot
    await open(gid, 1)
    const g = groupN((await dash(gid)).result, 1)
    check(g.seats.length === 2, '(D7) bot seat filtered out — only 2 seats shown (of 3)')
    check(!g.seats.some(s => s.participantId === 'pb'), '(D7) the bot participant is absent from seat rows')
    check(g.waitingOn.length <= 2 && g.waitingOn.every(w => w.role !== null), '(D7) waitingOn is drawn only from the shown (non-bot) seats')
  }

  // ══ SLICE 5 — BOTS (server seat-filler; ONE decide() shared with the browser driver) ══

  const HIGH = (b) => b >= 22 && b <= 27
  const LOW  = (b) => b >= 12 && b <= 17
  async function botTypesOf(gid, groupId) {
    const gd = await groupDoc(gid, groupId); const out = {}
    const bt = gd.bot_types?.mapValue?.fields ?? {}
    for (const [pid, v] of Object.entries(bt)) out[pid] = v.stringValue
    return out
  }
  /** Open with a seed that puts pid into wantRole (roles are assigned late by seed). */
  async function openForRole(gid, groupId, pid, wantRole) {
    for (let seed = 1; seed < 300; seed++) {
      await openG(gid, groupId, seed)
      const v = (await iviewG(gid, groupId)).result
      if (v.seats.find(s => s.participantId === pid)?.role === wantRole) return seed
    }
    throw new Error(`no seed put ${pid} in ${wantRole}`)
  }

  // (B1) 2 humans + 1 bot, full 10 rounds
  banner('(B1) mixed group: 2 humans + 1 bot, full 10 rounds')
  {
    const gid = 'bot-2h1b'; await seedRoster(gid, ['h1', 'h2']); const m = await match(gid)
    check(m.result?.remainder?.created && m.result.remainder.bots === 1, '(B1) matcher bot-filled remainder: 2 humans + 1 bot')
    const groupId = m.result.remainder.group_id
    await openG(gid, groupId, 1)
    const v = await driveMixedToFinish(gid, groupId)
    check(v.status === 'finished' && v.history.length === 10, '(B1) ran to completion, 10 rounds')
  }

  // (B2) 1 human + 2 bots, full 10 rounds (also the ONE-human group, §5.4)
  banner('(B2) 1 human + 2 bots, full 10 rounds (one-human group allowed)')
  {
    const gid = 'bot-1h2b'; await seedRoster(gid, ['solo']); const m = await match(gid)
    check(m.result?.remainder?.bots === 2, '(B2) 1 human + 2 bots formed (no minimum-humans guard)')
    const groupId = m.result.remainder.group_id
    await openG(gid, groupId, 1)
    const v = await driveMixedToFinish(gid, groupId)
    check(v.status === 'finished' && v.history.length === 10, '(B2) one-human group ran to completion')
  }

  // (B3)+(B5) bot type HELD CONSTANT all 10 rounds; HIGH bids [22,27]+always fix, LOW [12,17]+never
  banner('(B3/B5) bot seller type held constant 10 rounds; HIGH/LOW bid ranges + fix behaviour')
  {
    const gid = 'bot-type'; await seedRoster(gid, ['buyerh']); const m = await match(gid)
    const groupId = m.result.remainder.group_id
    // put the human in the BUYER seat so BOTH bots are sellers
    await openForRole(gid, groupId, 'buyerh', 'buyer')
    const types = await botTypesOf(gid, groupId)
    const v = await driveMixedToFinish(gid, groupId)
    check(v.status === 'finished', '(B3) mixed bot-seller game finished')
    // map each bot seat → role → its per-round bids/fixes from history
    const iv = (await iviewG(gid, groupId)).result
    let checkedSellers = 0
    for (const s of iv.seats) {
      if (s.role === 'buyer') continue
      const type = types[s.participantId]; if (!type) continue // human seller (none here)
      const key = s.role === 'seller1' ? 's1' : 's2'
      const bids = v.history.map(h => h.bids[key])
      const inRange = type === 'high' ? bids.every(HIGH) : bids.every(LOW)
      check(inRange, `(B5) bot seller (${type}) bid in range every round: ${bids.join(',')}`)
      check(new Set(bids).size >= 1 && bids.every(b => (type === 'high' ? HIGH(b) : LOW(b))), `(B3) type CONSTANT across all 10 rounds (no flip)`)
      const fixes = v.history.filter(h => h.crisisOccurred).map(h => h.fixed[key])
      check(type === 'high' ? fixes.every(f => f === true) : fixes.every(f => f === false), `(B5) bot seller (${type}) ${type === 'high' ? 'always fixes' : 'never fixes'}`)
      checkedSellers++
    }
    check(checkedSellers === 2, '(B3/B5) both bot sellers analysed')
  }

  // (B6) bot BUYER runs the buyer default (80 to the lower bid)
  banner('(B6) bot buyer: 80 to the lower bid')
  {
    const gid = 'bot-buyer'; await seedRoster(gid, ['sellerh']); const m = await match(gid)
    const groupId = m.result.remainder.group_id
    // human is a seller → a BOT is the buyer
    await openForRole(gid, groupId, 'sellerh', 'seller1')
    const botPids = await botPidsOf(gid, groupId)
    const iv0 = (await iviewG(gid, groupId)).result
    const buyerSeat = iv0.seats.find(s => s.role === 'buyer')
    check(botPids.has(buyerSeat.participantId), '(B6) the buyer seat is a bot')
    const v = await driveMixedToFinish(gid, groupId)
    // human seller1 bids 15 (driveMixed default); bot seller2 bids in its range. Buyer default: 80 to lower.
    const okAlloc = v.history.every(h => {
      const lowerIsS1 = h.bids.s1 <= h.bids.s2
      return lowerIsS1 ? (h.allocation.a1 >= h.allocation.a2) : (h.allocation.a2 >= h.allocation.a1)
    })
    check(okAlloc, '(B6) bot buyer gave the MAJORITY to the lower bid every round')
  }

  // (B7) IDEMPOTENCY — fire the bot runner twice, no double-apply
  banner('(B7) idempotency — bot action fired twice must not double-apply')
  {
    const gid = 'bot-idem'; await seedRoster(gid, ['buyerh']); const m = await match(gid)
    const groupId = m.result.remainder.group_id
    await openForRole(gid, groupId, 'buyerh', 'buyer') // both bots sellers, both owe a bid now
    const r1 = await runBots(gid, groupId)
    const after1 = (await iviewG(gid, groupId)).result
    const r2 = await runBots(gid, groupId) // duplicate delivery
    const after2 = (await iviewG(gid, groupId)).result
    check(r1.acted === 2, '(B7) first pass: both bot sellers acted')
    check(r2.acted === 0 && r2.skipped === 2, '(B7) second pass (retry): NO re-action (both already acted)')
    check(after1.stage === after2.stage && after1.round === after2.round, '(B7) state unchanged by the duplicate — no double-advance')
  }

  // (B8) bots EXCLUDED from scoreAndRecord
  banner('(B8) bots excluded from scoreAndRecord')
  {
    const gid = 'bot-score'; await seedRoster(gid, ['solo']); const m = await match(gid)
    const groupId = m.result.remainder.group_id
    await openG(gid, groupId, 1); await driveMixedToFinish(gid, groupId)
    const scored = await callFn('scoreAndRecord', { _dev: { game_instance_id: gid, callback_url: '' } })
    check(scored.result?.ok && scored.result.scored === 1, '(B8) exactly 1 scored (the human) — bots excluded')
    const botPids = [...await botPidsOf(gid, groupId)]
    const botDoc = await fsGet(gid, `participants/${botPids[0]}`)
    check(botDoc?.fields?.finalized_at == null && botDoc?.fields?.raw_score == null, '(B8) bot participant has no score written')
  }

  // (B9) bots HIDDEN on the dashboard (Slice-4 filter, now with REAL bots)
  banner('(B9) bots hidden on the dashboard (real bots present)')
  {
    const gid = 'bot-dash'; await seedRoster(gid, ['solo']); const m = await match(gid)
    const groupId = m.result.remainder.group_id
    await openG(gid, groupId, 1)
    const d = (await dash(gid)).result
    const g = d.groups.find(x => x.groupId === groupId)
    check(g.seats.length === 1 && !g.seats.some(s => s.isBot), '(B9) only the 1 human seat shown (2 bots hidden)')
    check(g.waitingOn.every(w => w.role !== null), '(B9) waitingOn contains no bot seats')
  }

  // (B10) remainder groups: class sizes 4,5,7,10 → correct bot counts, CONCENTRATED
  banner('(B10) remainder bot counts (4,5,7,10) — concentrated in one group')
  {
    const cases = [[4, 2], [5, 1], [7, 2], [10, 2]]
    for (const [n, expectBots] of cases) {
      const gid = `bot-rem-${n}`
      await seedRoster(gid, Array.from({ length: n }, (_, i) => `p${i}`))
      await match(gid)
      const groups = (await rosterOf(gid)).result.groups
      const counts = []
      for (const g of groups) { const d = await groupDoc(gid, g.group_id); counts.push(Number(d.bot_count?.integerValue ?? 0)) }
      const totalBots = counts.reduce((a, b) => a + b, 0)
      const groupsWithBots = counts.filter(c => c > 0).length
      check(totalBots === expectBots, `(B10) n=${n} → ${expectBots} bots total`)
      check(groupsWithBots === 1, `(B10) n=${n} → bots concentrated in exactly ONE group`)
    }
  }

  // (B11) timeout fill REDRAWS the type per round (the other half of §5.2)
  banner('(B11) timeout fill redraws type per round (vs bot fixed)')
  {
    // find a 3-human seed where a fully-timed-out seller's bids span BOTH ranges over 10 rounds
    let found = null
    for (let seed = 1; seed < 200 && !found; seed++) {
      const gid = `to-${seed}`; await seedGroup(gid, PIDS); await open(gid, seed)
      // drive all 10 rounds purely by the clock (every seat times out every stage)
      let vt = tickNow()
      for (let guard = 0; guard < 60; guard++) {
        const v = (await iview(gid)).result
        if (v.status === 'finished') break
        await tick(gid, vt); vt += 200_000
      }
      const v = (await iview(gid)).result
      if (v.status !== 'finished') continue
      // seller1 seat bids across rounds (all timeout-defaulted)
      const b1 = v.history.map(h => h.bids.s1)
      if (b1.some(HIGH) && b1.some(LOW)) { found = { gid, b1 }; break }
    }
    check(!!found, '(B11) timeout-defaulted seller drew BOTH high and low across rounds — per-round redraw (not fixed)')
  }

  // ══ SLICE 6 — timeout recording → gradebook, rounds_played_vs_bot, clock switch ══

  // (S1) timeout COUNT + ROUND NUMBERS reach the gradebook payload (§3.3, not a boolean)
  banner('(S1) timeout round-numbers reach the gradebook payload')
  {
    const gid = 'grade-to'; await seedGroup(gid, PIDS); await open(gid, 1)
    // time out the WHOLE game via the clock — every seat defaults every stage
    let vt = tickNow()
    for (let g = 0; g < 80; g++) { const v = (await iview(gid)).result; if (v.status === 'finished') break; await tick(gid, vt); vt += 200_000 }
    const recs = await scoreWithCapture(gid)
    const rec = recs.find(c => PIDS.includes(c.participant_id))
    check(!!rec && typeof rec.details?.timeout_count === 'number' && rec.details.timeout_count > 0, '(S1) gradebook payload carries timeout_count > 0')
    check(!!rec && Array.isArray(rec.details?.timeout_rounds) && rec.details.timeout_rounds.length > 0, '(S1) timeout_rounds carries the ROUND NUMBERS (not a boolean)')
    check(!!rec && Array.isArray(rec.details?.timeout_events) && rec.details.timeout_events.every(e => typeof e.round === 'number' && typeof e.stage === 'string'), '(S1) timeout_events carries {round, stage}')
    check(!!rec && rec.details?.rounds_played === 10, '(S1) rounds_played reaches the gradebook')
    check(!!rec && rec.status === 'completed' && rec.normalized_score === 0, '(S1) participation-only: present → normalized 0 (NO automatic zero for timeouts)')
  }

  // (S2) rounds_played_vs_bot — visible for a bot-filled group, 0 for all-human (§5.4)
  banner('(S2) rounds_played_vs_bot reaches the gradebook (bot-filled vs all-human)')
  {
    const gid = 'grade-bot'; await seedRoster(gid, ['solo']); const m = await match(gid); const groupId = m.result.remainder.group_id
    await openG(gid, groupId, 1); await driveMixedToFinish(gid, groupId)
    const recs = await scoreWithCapture(gid)
    const rec = recs.find(c => c.participant_id === 'solo')
    check(recs.length === 1, '(S2) bot-filled group → exactly the 1 human pushed (bots excluded)')
    check(!!rec && rec.details?.rounds_played_vs_bot === 10, '(S2) bot-filled → rounds_played_vs_bot=10 (visible, never blocked)')

    const gid2 = 'grade-human'; await seedGroup(gid2, PIDS); await open(gid2, 1); const rm = await roleMap(gid2)
    for (let rd = 1; rd <= 10; rd++) await playRound(gid2, rm, { b1: 15, b2: 18, a1: 60, a2: 40, f1: true, f2: false })
    const recs2 = await scoreWithCapture(gid2)
    const rec2 = recs2.find(c => PIDS.includes(c.participant_id))
    check(!!rec2 && rec2.details?.rounds_played_vs_bot === 0, '(S2) all-human group → rounds_played_vs_bot=0')
  }

  // (S3) clock switch — the SAME callables the ClockSwitch UI invokes (getGameConfig/updateGameConfig)
  banner('(S3) clock switch ON/OFF settable + honoured at openRound')
  {
    const gid = 'clk-off'; await seedGroup(gid, PIDS)
    await callFn('updateGameConfig', { _dev: { game_instance_id: gid }, clock_mode: 'off' })
    const cfg = (await callFn('getGameConfig', { _dev: { game_instance_id: gid } })).result
    check(cfg.clock_mode === 'off', '(S3) updateGameConfig set clock_mode=off; getGameConfig reads it back')
    const oOff = await open(gid, 1)
    check(oOff.result.clockEnabled === false, '(S3) OFF honoured at openRound (clockEnabled false)')
    // and a stalled clock never fires when OFF
    const t = await tick(gid, tickNow())
    check(t.result?.closed === false && t.result?.reason === 'clock_off', '(S3) OFF → checkRoundClock never times out')

    const gid2 = 'clk-on'; await seedGroup(gid2, PIDS)
    await callFn('updateGameConfig', { _dev: { game_instance_id: gid2 }, clock_mode: 'on' })
    const oOn = await open(gid2, 1)
    check(oOn.result.clockEnabled === true, '(S3) ON honoured at openRound (clockEnabled true)')
  }

  // ══ SLICE 7 — REPORTS (getCrisisReport, the callable the Reports page invokes) ══
  const report = (gid) => callFn('getCrisisReport', asDev(gid, {}))
  const sumOf = (a) => a.reduce((x, y) => x + y, 0)

  // (R1) known dataset: bids 12/20, allocation 80/20 (ASYMMETRIC), S1 always fixes, S2 never
  banner('(R1) reports on a KNOWN dataset — sums, weighted buyer price, fixing %')
  {
    const gid = 'rep1'; await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    for (let rd = 1; rd <= 10; rd++) await playRound(gid, rm, { b1: 12, b2: 20, a1: 80, a2: 20, f1: true, f2: false })
    const hist = (await iview(gid)).result.history
    const rep = (await report(gid)).result
    const S1 = rep.students.find(s => s.role === 'Seller 1'), S2 = rep.students.find(s => s.role === 'Seller 2'), B = rep.students.find(s => s.role === 'Buyer')
    const faced = hist.filter(h => h.crisisOccurred).length
    const noCrisis = hist.filter(h => !h.crisisOccurred).length

    check(rep.includedGroups === 1 && rep.omittedBotGroups === 0, '(R1) all-human group included')
    check(Math.abs(B.averageBid - 13.6) < 1e-9, '(R1) buyer allocation-weighted avg price = 13.6 (NOT the unweighted mean 16)')
    check(Math.abs(rep.classSummary.averageBid - 16) < 1e-9, '(R1) class average bid = 16 (grand mean of 12 & 20)')
    check(S1.averageBid === 12 && S2.averageBid === 20, '(R1) seller average bids 12 / 20')
    check(S1.averageAllocation === 80 && S2.averageAllocation === 20, '(R1) seller average allocations 80 / 20')
    check(S1.proportionFixed === (faced > 0 ? 1 : null), '(R1) Seller 1 fixed ALL crises → 100% (denominator = crises FACED)')
    check(S2.proportionFixed === (faced > 0 ? 0 : null), '(R1) Seller 2 fixed NONE → 0%')
    check(noCrisis === 0 || S1.proportionFixed === 1, '(R1) a no-crisis round does NOT dilute the fixing denominator')
    // class figures are SUMS (verified differentially against the resolved history)
    check(rep.classSummary.totalBuyerProfit === sumOf(hist.map(h => h.profits.buyer)), '(R1) class total BUYER profit = SUM over rounds')
    check(rep.classSummary.totalSellerProfit === sumOf(hist.map(h => h.profits.seller1 + h.profits.seller2)), '(R1) class total SELLER profit = SUM (both sellers)')
    check(rep.groups[0].table.buyerProfit === sumOf(hist.map(h => h.profits.buyer)), '(R1) group table buyer profit correct')
  }

  // (R1b) mixed fixing — a seller who fixes SOME crises → partial %, computed differentially
  banner('(R1b) partial fixing rate (fixes some crises)')
  {
    const gid = 'rep1b'; await seedGroup(gid, PIDS); await open(gid, 1)
    const rm = await roleMap(gid)
    for (let rd = 1; rd <= 10; rd++) await playRound(gid, rm, { b1: 15, b2: 15, a1: 50, a2: 50, f1: rd % 2 === 0, f2: false })
    const hist = (await iview(gid)).result.history
    const rep = (await report(gid)).result
    const S1 = rep.students.find(s => s.role === 'Seller 1')
    // expected S1 fixing = (crisis rounds where round is even) / (crisis rounds), units always 50
    let faced = 0, fixed = 0
    for (const h of hist) if (h.crisisOccurred) { faced++; if (h.round % 2 === 0) fixed++ }
    const expected = faced === 0 ? null : fixed / faced
    check(S1.proportionFixed === expected, `(R1b) Seller 1 partial fixing rate correct (${fixed}/${faced})`)
  }

  // (R2) bots excluded entirely — a bot-filled group is OMITTED from all reports
  banner('(R2) bots excluded — bot-filled group omitted entirely')
  {
    const gid = 'rep2'; await seedRoster(gid, ['h1', 'h2', 'h3', 'h4']); await match(gid)
    const groups = (await rosterOf(gid)).result.groups
    for (const gg of groups) { await openG(gid, gg.group_id, 1); await driveMixedToFinish(gid, gg.group_id) }
    const rep = (await report(gid)).result
    check(rep.includedGroups === 1 && rep.omittedBotGroups === 1, '(R2) 1 human group included, 1 bot group omitted')
    check(rep.groups.length === 1, '(R2) only the all-human group in the report')
    check(rep.students.length === 3, '(R2) exactly the 3 humans of the all-human group')
    check(!rep.students.some(s => s.participantId.startsWith('bot_')), '(R2) no bot rows anywhere')
    check(!rep.students.some(s => s.participantId === 'h4'), '(R2) the human IN the bot group is excluded (whole group omitted)')
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main()
  .catch(err => { console.error('HARNESS ERROR:', err); FAIL++ })
  .finally(() => { tearDown(); process.exit(FAIL === 0 ? 0 : 1) })

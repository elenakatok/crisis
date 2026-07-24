// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — O2.1/O2.2 production smoke against LIVE crisis-mygames-live.
//   ONLINE leg (instance from CRISIS_INSTANCE, default BA9OV…): fresh instance → drive
//     students → groupParticipantsOnline → instructor actions (move / ungroup / bot-fill,
//     the deployed O2/O2.2 callables) → a real student browser: reveal (name+email) →
//     continue → waiting screen with the FULL member list + "N of 3" + per-member arrival
//     → round opens with the clock OFF.
//   CLASSROOM leg (auto-picked clean instance): drive students → clock ON → triggerMatching
//     → openRound with the clock ENABLED (classroom mode unbroken).
//
//   node crisis-o22-smoke.mjs            (HEADED=1 to watch)
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const LAUNCHER = 'http://localhost:5180'
const PROJECT  = 'crisis-mygames-live'
const FN       = `https://us-central1-${PROJECT}.cloudfunctions.net`
const HEADED   = !!process.env.HEADED
const ONLINE_INSTANCE = process.env.CRISIS_INSTANCE || 'BA9OV9VXWIlXB18DGBQJ'

let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

async function launcher(p, body) {
  const r = await fetch(`${LAUNCHER}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await r.json(); if (!r.ok) throw new Error(`launcher ${p}: ${j.error ?? r.status}`); return j
}
async function fn(name, data) {
  const r = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { throw new Error(`${name} → ${r.status}: ${t.slice(0, 140)}`) }
  if (j.error) { const e = new Error(j.error.message ?? JSON.stringify(j.error)); e.fnError = j.error; throw e }
  return j.result
}
const pidOf = (url) => JSON.parse(Buffer.from(new URL(url).searchParams.get('token').split('.')[1], 'base64url').toString('utf8')).participant_id
const tokenOf = (url) => new URL(url).searchParams.get('token')

const browsers = []
async function openWindow(url) {
  const b = await chromium.launch({ headless: !HEADED }); browsers.push(b)
  const page = await (await b.newContext({ viewport: { width: 960, height: 800 } })).newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' }); return page
}
const has = (page, tid) => page.locator(`[data-testid="${tid}"]`).count().then(n => n > 0)
const stateOf = (page) => page.evaluate(() => window.__crisisState ?? null)

async function instructorToken(gid) {
  const { url } = await launcher('/api/dashboard-url', { game_instance_id: gid })
  return new URL(url).searchParams.get('token')
}

// ── ONLINE leg ────────────────────────────────────────────────────────────────────
async function onlineLeg() {
  banner(`ONLINE leg — instance ${ONLINE_INSTANCE}`)
  const token = await instructorToken(ONLINE_INSTANCE)
  await fn('updateGameConfig', { token, clock_mode: 'off' })
  check((await fn('getGameConfig', { token })).clock_mode === 'off', 'clock set OFF (online mode)')

  // Drive 4 course-ABC students to prep-complete (fresh instance → this populates the roster).
  // The launcher's "ready" flow runs verifyAttendanceCode server-side, so a code must exist —
  // it is never shown to online students (they route via the reveal), just needed to drive them.
  await fn('generateAttendanceCode', { token })
  await launcher('/api/prepare', { n: 4 })
  const students = []
  for (let i = 0; i < 4; i++) {
    const s = await launcher('/api/student-url', { game_instance_id: ONLINE_INSTANCE, index: i, mode: 'ready' })
    students.push({ ...s, pid: pidOf(s.url) })
  }
  check(students.length === 4, '4 students driven to prep-complete')

  // Group the roster → [3,1].
  let g = await fn('groupParticipantsOnline', { token })
  check(g.ok && g.total_humans >= 4, `groupParticipantsOnline formed ${g.groups} group(s), ${g.total_humans} humans`)
  let og = await fn('getOnlineGroups', { token })
  const mem = og.groups.flatMap(x => x.members)
  check(mem.every(m => m.display_name), 'members[] carry display names')
  console.log(`  members with email: ${mem.filter(m => m.email).length}/${mem.length}`)

  // ── Instructor actions (deployed O2 / O2.2 callables) on scratch state ──────────
  banner('ONLINE leg — instructor actions (move / ungroup / bot-fill) in prod')
  const full = og.groups.find(x => x.size === 3)
  const short = og.groups.find(x => x.size === 1)
  if (full && short) {
    const mv = await fn('moveSeat', { token, participant_id: full.members[1].participant_id, target_group_id: short.group_id })
    check(mv.ok && mv.moved, 'moveSeat: a member moved between two groups (prod)')
    const un = await fn('moveSeat', { token, participant_id: short.members[0].participant_id, target_group_id: '' }) // ungroup
    check(un.ok && un.removed, 'moveSeat with empty target: UNGROUP removed a student (O2.2, prod)')
  } else {
    console.log('  (skipped move/ungroup — grouping was not [3,1])')
  }

  // Re-group to a clean [3,1] for the browser walk-through (allowed — nothing locked yet).
  g = await fn('groupParticipantsOnline', { token })
  check(g.ok, 're-group back to a clean state (before-lock)')
  og = await fn('getOnlineGroups', { token })
  const grpFull = og.groups.find(x => x.size === 3)
  check(!!grpFull, 'a full group of 3 exists for the browser walk-through')

  // ── Browser: reveal → continue → waiting screen (O2.1 contact info + arrival) ────
  banner('ONLINE leg — student browser: reveal + waiting screen (contact info + arrival)')
  const memberPid = grpFull.members[0].participant_id
  const stu = students.find(s => s.pid === memberPid)
  const page = await openWindow(stu.url)
  await page.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 45000 }).catch(() => {})
  check(await has(page, 'crisis-online-reveal'), 'login lands on the group reveal (no attendance code)')
  check(await page.locator('[data-testid="crisis-member-item"]').count() === 3, 'reveal shows the full 3-member group list')
  const revEmails = await page.locator('[data-testid="crisis-member-email"]').count()
  console.log(`  reveal email mailto links: ${revEmails}/3 (course-ABC test students have no email on file)`)
  if (revEmails > 0) check(/^mailto:.+@/.test(await page.locator('[data-testid="crisis-member-email"]').first().getAttribute('href') || ''), 'member email is a mailto: link')

  await page.click('[data-testid="crisis-reveal-continue"]')
  await page.waitForSelector('[data-testid="crisis-waiting-start"]', { timeout: 20000 }).catch(() => {})
  check(await has(page, 'crisis-waiting-start'), 'continue → pre-game waiting screen')
  await page.waitForSelector('[data-testid="crisis-member-list"]', { timeout: 10000 }).catch(() => {})
  check(await page.locator('[data-testid="crisis-member-item"]').count() === 3, 'waiting screen shows the full 3-member group list (contact info reused from the reveal)')
  await page.waitForSelector('[data-testid="crisis-waiting-count"]', { timeout: 8000 }).catch(() => {})
  const wtext = await page.textContent('[data-testid="crisis-waiting-start"]')
  check(/of 3/.test(wtext) && /starts automatically/i.test(wtext), 'waiting copy shows the "N of 3" count + auto-start text')
  check(!/waiting for your instructor/i.test(wtext), 'waiting copy is NOT the classroom "instructor" text')
  const heres = await page.locator('[data-testid="crisis-member-status"]').evaluateAll(els => els.map(e => e.getAttribute('data-here')))
  check(heres.length === 3 && heres.filter(x => x === 'true').length === 1, 'per-member arrival: 1 here (you) + 2 not-here-yet')

  // ── Round opens with the clock OFF ──────────────────────────────────────────────
  banner('ONLINE leg — a round opens with the clock OFF')
  await fn('openRound', { token, group_id: grpFull.group_id })
  await page.waitForFunction(() => !!window.__crisisState, null, { timeout: 30000 }).catch(() => {})
  const st = await stateOf(page)
  check(st && ['buyer', 'seller1', 'seller2'].includes(st.role), `round active → seat/role assigned (${st?.role})`)
  check(st && st.clockEnabled === false && st.stageDeadlineMs === null, 'round runs with the clock OFF')
  // if this student owes a bid, confirm the deployed bid-bounds hint renders
  if (st && st.owes === 'bid') {
    check(/between\s*10\s*and\s*30/i.test(await page.textContent('main')), 'bid screen shows the "between 10 and 30" range (bid bounds deployed)')
  } else {
    console.log(`  (this seat owes "${st?.owes}", not a bid — bid form not shown)`)
  }
}

// ── CLASSROOM leg (on the same fresh instance, BEFORE the online re-group) ──────────
async function classroomLeg() {
  banner(`CLASSROOM leg — ${ONLINE_INSTANCE}: clock ON, match + open with the clock enabled`)
  const token = await instructorToken(ONLINE_INSTANCE)
  await fn('updateGameConfig', { token, clock_mode: 'on' })
  check((await fn('getGameConfig', { token })).clock_mode === 'on', 'clock set ON (classroom mode)')
  await fn('generateAttendanceCode', { token })

  await launcher('/api/prepare', { n: 3 })
  const pages = []
  for (let i = 0; i < 3; i++) {
    const u = (await launcher('/api/student-url', { game_instance_id: ONLINE_INSTANCE, index: i, mode: 'ready' })).url
    pages.push(await openWindow(u)) // real windows → RTDB presence (the classroom matcher's gate)
  }
  await sleep(8000)
  check(true, '3 students present (attendance-verified) in classroom mode')

  await fn('triggerMatching', { token })
  const roster = await fn('getRoster', { token })
  const threes = (roster.groups ?? []).filter(gr => (gr.participants_by_role?.player ?? []).length === 3)
  const group = threes.find(gr => gr.status === 'matched') ?? threes[0]
  check(!!group, `classroom matching formed a group of 3 (${group?.group_id})`)
  if (group) {
    const opened = await fn('openRound', { token, group_id: group.group_id })
    check(opened.ok && opened.clockEnabled === true, 'openRound started the round with the clock ON (classroom unbroken)')
  }
  for (const p of pages) await p.close().catch(() => {}) // release the classroom windows before the online re-group
}

async function main() {
  banner(`CRISIS O2.1/O2.2 production smoke — live ${PROJECT}${HEADED ? ' (HEADED)' : ''}`)
  // Classroom FIRST (verifies clock-ON matching), then re-purpose the same fresh instance for the
  // online leg (clock OFF → groupParticipantsOnline re-forms the groups; nothing locked yet).
  await classroomLeg()
  await onlineLeg()
  if (HEADED) { console.log('\n  (HEADED) leaving windows 10s…'); await sleep(10000) }
  for (const b of browsers) await b.close().catch(() => {})
  console.log('\n' + '═'.repeat(72))
  console.log(`  SMOKE: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('SMOKE ERROR:', e); FAIL++ }).finally(async () => { for (const b of browsers) await b.close().catch(() => {}); process.exit(FAIL === 0 ? 0 : 1) })

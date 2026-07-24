// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — ONLINE-MODE production smoke (Slice O1). Against LIVE crisis-mygames-live.
// Verifies the deployed online path end-to-end: clock OFF → groupParticipantsOnline
// (deploy-time pre-grouping of the roster, role assigned at grouping) → getOnlineGroups
// (denormalized members[] the reveal reads) → a REAL student browser lands on the group
// REVEAL (not the attendance-code screen) → continue → members strip → an active round
// with the clock OFF. Round-to-finish play is already prod-verified (Slice-3 smoke); this
// smoke targets the NEW online routing + grouping only.
//
//   node crisis-online-smoke.mjs            (HEADED=1 to watch)
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const LAUNCHER = 'http://localhost:5180'
const PROJECT  = 'crisis-mygames-live'
const FN       = `https://us-central1-${PROJECT}.cloudfunctions.net`
const HEADED   = !!process.env.HEADED

let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(72) + '\n' + m + '\n' + '─'.repeat(72))
const check = (c, n) => { if (c) { PASS++; console.log(`  ✓ ${n}`) } else { FAIL++; console.log(`  ✗ FAIL: ${n}`) } }

async function launcher(pathname, body) {
  const res = await fetch(`${LAUNCHER}${pathname}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json()
  if (!res.ok) throw new Error(`launcher ${pathname}: ${j.error ?? res.status}`)
  return j
}
async function fn(name, data) {
  const res = await fetch(`${FN}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  const text = await res.text()
  let j; try { j = JSON.parse(text) } catch { throw new Error(`${name} → ${res.status}: ${text.slice(0, 160)}`) }
  if (j.error) { const e = new Error(j.error.message ?? JSON.stringify(j.error)); e.fnError = j.error; throw e }
  return j.result
}
// Decode participant_id from a launch JWT (no verification — we just need the id).
function pidOf(url) {
  const token = new URL(url).searchParams.get('token')
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  return payload.participant_id
}

const browsers = []
async function openWindow(url) {
  const browser = await chromium.launch({ headless: !HEADED })
  browsers.push(browser)
  const page = await (await browser.newContext({ viewport: { width: 900, height: 760 } })).newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  return page
}
const has = (page, tid) => page.locator(`[data-testid="${tid}"]`).count().then(n => n > 0)
const stateOf = (page) => page.evaluate(() => window.__crisisState ?? null)

async function main() {
  banner(`CRISIS ONLINE smoke — live ${PROJECT}${HEADED ? ' (HEADED)' : ''}`)

  const { instances } = await launcher('/api/instances?game=crisis')
  if (!instances?.length) throw new Error('No Crisis instance in course ABC.')

  // Try each not_started instance until one groups cleanly (a prior played game leaves
  // LOCKED groups → groupParticipantsOnline correctly refuses; move to the next).
  let inst = null, token = null, group = null
  for (const cand of instances) {
    const { url: dashUrl } = await launcher('/api/dashboard-url', { game_instance_id: cand.game_instance_id })
    const tok = new URL(dashUrl).searchParams.get('token')

    await fn('updateGameConfig', { token: tok, clock_mode: 'off' })
    const cfg = await fn('getGameConfig', { token: tok })
    if (cfg.clock_mode !== 'off') continue

    try {
      const g = await fn('groupParticipantsOnline', { token: tok })
      inst = cand; token = tok; group = g
      console.log(`  using instance ${cand.game_instance_id} ("${cand.title}", ${cand.participantCount} participants)`)
      break
    } catch (e) {
      if (/lock/i.test(e.message)) { console.log(`  ${cand.game_instance_id} has locked groups (prior game) — trying next`); continue }
      throw e
    }
  }
  check(!!inst, 'clock set OFF + groupParticipantsOnline ran on a live instance')
  if (!inst) throw new Error('No groupable instance (all have locked groups). Ask Elena for a fresh Crisis instance.')

  // ── Backend: grouping + denormalized members ────────────────────────────────────
  banner('backend — groupParticipantsOnline / getOnlineGroups (deploy-time pre-grouping)')
  check(group.ok && group.groups >= 1, `grouping formed ${group.groups} groups (${group.full_groups} full, short ${group.short_group_size ?? 'none'}, ${group.total_humans} humans)`)

  const og = await fn('getOnlineGroups', { token })
  check(og.clock_mode === 'off', 'getOnlineGroups reports clock_mode=off')
  check(og.groups.length === group.groups, 'getOnlineGroups returns every formed group')
  const allMembers = og.groups.flatMap(g => g.members)
  check(allMembers.length === group.total_humans, 'members[] covers every grouped human')
  check(allMembers.every(m => m.participant_id && typeof m.display_name === 'string'), 'every member has participant_id + display_name')
  check(allMembers.every(m => !m.participant_id.startsWith('bot_')), 'members[] is bot-free')
  const noDup = new Set(allMembers.map(m => m.participant_id)).size === allMembers.length
  check(noDup, 'no participant appears in two groups')
  const withEmail = allMembers.filter(m => m.email).length
  console.log(`  members with an email on file: ${withEmail}/${allMembers.length}`)

  // Drive 3 fresh course-ABC students to prep-complete (role='player' via assignRole), so
  // after the reveal they land in the game rather than the KC flow.
  await launcher('/api/prepare', { n: 3 })
  const students = []
  for (let i = 0; i < 3; i++) {
    const s = await launcher('/api/student-url', { game_instance_id: inst.game_instance_id, index: i, mode: 'ready' })
    students.push({ ...s, pid: pidOf(s.url) })
  }
  check(students.length === 3, '3 students driven to prep-complete (assignRole→KC→prep→confirm)')

  // They joined the roster AFTER the first grouping, so re-group to fold them in (allowed —
  // nothing has locked yet). This also exercises the re-run-before-lock path in prod.
  const regroup = await fn('groupParticipantsOnline', { token })
  check(regroup.ok, 're-group (before any lock) folded the new students in')
  const og2 = await fn('getOnlineGroups', { token })

  // Each driven student is now grouped, role='player' (assigned at grouping), and appears in
  // members[] with their roster name.
  const roster = await fn('getRoster', { token })
  const rosterById = new Map((roster.participants ?? []).map(p => [p.participant_id, p]))
  for (const s of students) {
    const p = rosterById.get(s.pid)
    check(!!p && p.role === 'player' && !!p.group_id, `student ${s.name} → role=player + group_id`)
    const inMembers = og2.groups.some(g => g.members.some(m => m.participant_id === s.pid))
    check(inMembers, `student ${s.name} appears in a group's members[]`)
  }

  // Pick a driven student who landed in a FULL (size-3) group so openRound can start.
  const target = students
    .map(s => ({ s, g: og2.groups.find(g => g.members.some(m => m.participant_id === s.pid)) }))
    .find(x => x.g && x.g.size === 3)
  check(!!target, 'at least one driven student is in a full group of 3')

  // ── Browser: the online routing (the key change) ────────────────────────────────
  banner('browser — student login lands on the REVEAL (no attendance-code screen)')
  const url0 = students.find(s => s.pid === target.s.pid).url
  const page = await openWindow(url0)
  await page.waitForSelector('[data-testid="crisis-online-reveal"]', { timeout: 45000 }).catch(() => {})
  check(await has(page, 'crisis-online-reveal'), 'online login landed on the group reveal')
  check(!(await has(page, 'crisis-waiting-start')), 'not straight into the game — the reveal gates first')
  // No attendance-code screen anywhere in online mode.
  const codeInputs = await page.locator('input[placeholder*="ABJKM"], input[maxlength="6"]').count()
  check(codeInputs === 0, 'NO attendance-code entry screen (online has no code)')
  const revealTxt = await page.textContent('[data-testid="crisis-online-reveal"]')
  check(revealTxt.includes(target.s.name), `reveal shows the student's own name (${target.s.name})`)
  const emailLinks = await page.locator('[data-testid="crisis-reveal-email"]').count()
  console.log(`  reveal rendered ${emailLinks} mailto email link(s)`)
  if (emailLinks > 0) {
    const href = await page.locator('[data-testid="crisis-reveal-email"]').first().getAttribute('href')
    check(/^mailto:.+@/.test(href || ''), 'member email renders as a mailto: link')
  }

  // Continue → the game pre-round screen + the persistent members strip.
  await page.click('[data-testid="crisis-reveal-continue"]')
  await page.waitForSelector('[data-testid="crisis-waiting-start"]', { timeout: 20000 }).catch(() => {})
  check(await has(page, 'crisis-waiting-start'), 'continue → pre-game waiting screen (prep already complete)')
  await page.waitForSelector('[data-testid="crisis-members-strip"]', { timeout: 10000 }).catch(() => {})
  check(await has(page, 'crisis-members-strip'), 'persistent members strip renders before round 1')

  // ── Round opens with the clock OFF (online) ─────────────────────────────────────
  banner('browser — an online round runs with the clock OFF')
  await fn('openRound', { token, group_id: target.g.group_id })
  await page.waitForFunction(() => !!window.__crisisState, null, { timeout: 30000 }).catch(() => {})
  const st = await stateOf(page)
  check(st && ['buyer', 'seller1', 'seller2'].includes(st.role), `round active → seat/role assigned late (${st?.role})`)
  check(st && st.clockEnabled === false && st.stageDeadlineMs === null, 'round runs with the clock OFF (no deadline)')
  await sleep(500)
  check(!(await has(page, 'crisis-members-strip')), 'members strip hidden once the round is active')

  if (HEADED) { console.log('\n  (HEADED) leaving the window open 10s…'); await sleep(10000) }
  for (const b of browsers) await b.close().catch(() => {})
  console.log('\n' + '═'.repeat(72))
  console.log(`  ONLINE SMOKE: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('SMOKE ERROR:', e); FAIL++ }).finally(async () => { for (const b of browsers) await b.close().catch(() => {}); process.exit(FAIL === 0 ? 0 : 1) })

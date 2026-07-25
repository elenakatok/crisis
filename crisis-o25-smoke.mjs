// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — O2.5 / O3 / instructor-email production smoke against LIVE crisis-mygames-live.
// One fresh instance (CRISIS_INSTANCE, default lzqS9Irt50FFRFMD8mLv). Covers, in one linear flow:
//   • instructor-email auto-populate — syncRoster stores the course owner; the flag mailto To:
//     is that auto-synced address (no manual Settings entry).
//   • flag flow (O3) — flagGroup writes the flag, ⚑ shows on the instructor strip, and goes
//     STALE (⚑ disappears) once the group LOCKS at first submission (its bots submit at Start class).
//   • classroom fill (O2.5C) — topUpGroupWithBots on a short group with the clock ON (the
//     formerly-stale "Bot top-up is an online-mode action" bug).
//   • human-replaces-bot (O2.5B) — moveSeat into a full-with-bot group evicts a bot.
//   • Start class (O2.5D) — startAllGroups opens full groups, skips short, and a re-press starts a
//     group made ready since (bot-filled). The dashboard button is present + enabled.
//   • assignment-status report (O3) — getOnlineReport + the Reports "Assignment status" tile.
//
// The FLAG group is a controlled [1 driven human + 2 bots] group (moveSeat→new + topUp): we hold
// the human's token, and its bots auto-submit at Start class → the group LOCKS → the flag goes stale.
//
// DESTRUCTIVE + SINGLE-USE: this starts real games (locks groups), so run it ONCE on a FRESH
// instance (all groups not_started / no locks). Override the target with CRISIS_INSTANCE=<id>.
//
//   CRISIS_INSTANCE=<fresh id> node crisis-o25-smoke.mjs            (HEADED=1 to watch)
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'
import { setTimeout as sleep } from 'node:timers/promises'

const LAUNCHER = 'http://localhost:5180'
const PROJECT = 'crisis-mygames-live'
const FN = `https://us-central1-${PROJECT}.cloudfunctions.net`
const HEADED = !!process.env.HEADED
const INSTANCE = process.env.CRISIS_INSTANCE || 'lzqS9Irt50FFRFMD8mLv'

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
const tokenOf = (url) => new URL(url).searchParams.get('token')
const pidOf = (url) => JSON.parse(Buffer.from(tokenOf(url).split('.')[1], 'base64url').toString('utf8')).participant_id

const browsers = []
async function openWindow(url) {
  const b = await chromium.launch({ headless: !HEADED }); browsers.push(b)
  const page = await (await b.newContext({ viewport: { width: 1100, height: 900 } })).newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' }); return page
}
const has = (page, tid) => page.locator(`[data-testid="${tid}"]`).count().then(n => n > 0)

async function main() {
  banner(`CRISIS O2.5/O3/email production smoke — live ${PROJECT} · instance ${INSTANCE}${HEADED ? ' (HEADED)' : ''}`)
  const dashLaunch = await launcher('/api/dashboard-url', { game_instance_id: INSTANCE })
  const token = tokenOf(dashLaunch.url)

  // ── Setup: clock OFF, sync the roster (stores the owner email), pre-group everyone ──────────
  banner('SETUP — clock OFF, syncRoster (auto-populate owner email), groupParticipantsOnline')
  await fn('updateGameConfig', { token, clock_mode: 'off' })
  const sr = await fn('syncRoster', { token })
  check(sr.ok, `syncRoster ok (${sr.synced} new / ${sr.skipped} existing) — also stores the course owner's email on the instance`)
  // Settings override is blank on a fresh instance — so whatever the flag mailto uses MUST be the
  // auto-synced course owner (this is the instance-agnostic proof of auto-populate).
  const cfg0 = await fn('getGameConfig', { token })
  check(!String(cfg0.instructor_email ?? '').trim(), 'Settings instructor_email is BLANK (no manual entry) — any mailto address therefore comes from the sync')
  await fn('generateAttendanceCode', { token }) // 'ready' mode drives students server-side; never shown online
  await launcher('/api/prepare', { n: 4 })
  const students = []
  for (let i = 0; i < 4; i++) { const s = await launcher('/api/student-url', { game_instance_id: INSTANCE, index: i, mode: 'ready' }); students.push({ token: tokenOf(s.url), pid: pidOf(s.url) }) }
  const g = await fn('groupParticipantsOnline', { token })
  check(g.ok && g.groups >= 3, `groupParticipantsOnline formed ${g.groups} groups from ${g.total_humans} humans`)

  // ── Controlled FLAG group: a driven student in their own group + 2 bots (their bots will submit
  //    at Start class → the group locks → the flag goes stale) ─────────────────────────────────
  const reporter = students[0]
  const nw = await fn('moveSeat', { token, participant_id: reporter.pid, target_group_id: 'new' })
  check(nw.ok && nw.created, 'moved the reporter into their own new group')
  const R = nw.new_group
  const rfill = await fn('topUpGroupWithBots', { token, group_id: R })
  check(rfill.ok && rfill.added === 2, 'bot-filled the reporter\'s group → [1 human + 2 bots]')

  // ── FLAG + EMAIL ────────────────────────────────────────────────────────────────────────
  banner('FLAG + EMAIL — flagGroup writes the flag; mailto To: is the auto-synced owner email')
  const fr = await fn('flagGroup', { token: reporter.token })
  check(fr.ok, 'flagGroup succeeded (flag written)')
  check(typeof fr.instructor_email === 'string' && /@/.test(fr.instructor_email), `flag mailto To: is a real address — the AUTO-SYNCED course owner (Settings was blank): ${fr.instructor_email}`)
  const flagNum = fr.group_number
  check((await fn('getOnlineReport', { token })).counts.flagged >= 1, 'getOnlineReport shows a live flagged group')

  // ── Switch to CLASSROOM (the flag persists; ⚑ still renders until the group locks) ──────────
  await fn('updateGameConfig', { token, clock_mode: 'on' })
  check((await fn('getGameConfig', { token })).clock_mode === 'on', 'clock switched ON (classroom) — the flag record persists')

  // ── Dashboard browser: ⚑ on the strip + the "Start class" control ───────────────────────────
  banner('DASHBOARD — ⚑ on the strip + "Start class" button present/enabled (classroom)')
  const dashUrl = (await launcher('/api/dashboard-url', { game_instance_id: INSTANCE })).url
  const dash = await openWindow(dashUrl)
  dash.on('dialog', d => d.accept())
  await dash.waitForSelector('[data-testid="crisis-live-summary"]', { timeout: 45000 }).catch(() => {})
  await dash.waitForSelector(`[data-testid="crisis-flag-indicator-${flagNum}"]`, { timeout: 20000 }).catch(() => {})
  check(await has(dash, `crisis-flag-indicator-${flagNum}`), `⚑ "student flagged" shows on Group ${flagNum}'s strip line`)
  check(await has(dash, 'crisis-start-class'), '"Start class" button present on the dashboard (classroom)')
  check(!(await dash.locator('[data-testid="crisis-start-class"]').isDisabled()), 'Start class is enabled (full groups are ready)')
  // the reporter's group shows a bot seat picture ("3/3 · 2 bots") — never mistaken for short
  const seatTexts = await dash.locator('[data-testid^="crisis-seats-"]').allTextContents()
  check(seatTexts.some(t => /3\/3 · \d bot/.test(t)), `a bot-filled group shows its seat picture with the bot count [${seatTexts.filter(t => /bot/.test(t)).join(' | ')}]`)

  // ── classroom fill (Elena bug) + human-replaces-bot (clock ON) ──────────────────────────────
  banner('CLASSROOM FILL + HUMAN-REPLACES-BOT (clock ON)')
  let og = await fn('getOnlineGroups', { token })
  let shortG = og.groups.find(x => x.size < 3 && x.group_id !== R)
  if (!shortG) { const donor = og.groups.find(x => x.size === 3 && x.group_id !== R); await fn('moveSeat', { token, participant_id: donor.members[donor.members.length - 1].participant_id, target_group_id: '' }); og = await fn('getOnlineGroups', { token }); shortG = og.groups.find(x => x.size < 3 && x.group_id !== R) }
  const fill = await fn('topUpGroupWithBots', { token, group_id: shortG.group_id })
  check(fill.ok && fill.added >= 1, `topUpGroupWithBots WORKS with the clock ON (added ${fill.added}) — the formerly-stale "online-mode action" bug is gone`)
  const donorFull = og.groups.find(x => x.size === 3 && x.group_id !== R && x.group_id !== shortG.group_id)
  const ev = await fn('moveSeat', { token, participant_id: donorFull.members[donorFull.members.length - 1].participant_id, target_group_id: shortG.group_id })
  check(ev.ok && ev.moved && !!ev.evicted_bot, `human-replaces-bot: moving a human into the full-with-bot group EVICTED a bot (${ev.evicted_bot})`)
  const drained = donorFull.group_id // a human left → now short → a Start-class "skipped_short"

  // ── START CLASS press 1: starts every FULL group, skips the short one(s) ─────────────────────
  banner('START CLASS — press 1 (starts full, skips short)')
  og = await fn('getOnlineGroups', { token })
  const fullCount = og.groups.filter(x => x.size === 3).length
  const shortCount = og.groups.filter(x => x.size < 3).length
  const s1 = await fn('startAllGroups', { token })
  check(s1.ok && s1.started === fullCount, `Start class started every full group (${s1.started} of ${fullCount} full)`)
  check(s1.skipped_short === shortCount && s1.groups.some(x => x.groupId === drained && x.result === 'skipped_short'), `skipped the ${shortCount} short group(s) incl. the drained one`)
  check(s1.groups.some(x => x.groupId === R && x.result === 'started'), 'the flagged reporter-group was started (its bots will now submit → it locks)')

  // ── ⚑ goes stale once the reporter-group locks (its bots submit ~12-25s after open) ──────────
  banner('STALE — ⚑ disappears once the flagged group LOCKS at first submission')
  await dash.waitForFunction((n) => !document.querySelector(`[data-testid="crisis-flag-indicator-${n}"]`), flagNum, { timeout: 60000 }).catch(() => {})
  check(!(await has(dash, `crisis-flag-indicator-${flagNum}`)), `⚑ disappeared once Group ${flagNum} locked (flag went stale automatically, no clear action)`)

  // ── START CLASS press 2: bot-fill the drained group, re-press → ONLY it starts ──────────────
  banner('START CLASS — press 2 (re-press starts a newly-ready group; running untouched)')
  const fill2 = await fn('topUpGroupWithBots', { token, group_id: drained })
  check(fill2.ok && fill2.added >= 1, `bot-filled the drained group (added ${fill2.added}) → now ready`)
  const s2 = await fn('startAllGroups', { token })
  check(s2.started === 1 && s2.groups.some(x => x.groupId === drained && x.result === 'started'), 'the re-press started ONLY the newly-ready group')
  check(s2.already_running >= 1 && !s2.groups.some(x => x.result === 'started' && x.groupId !== drained), 'already-running groups were left untouched (already_running)')

  // ── Assignment-status report (callable + the Reports tile) ──────────────────────────────────
  banner('ASSIGNMENT-STATUS REPORT — getOnlineReport + the Reports "Assignment status" tile')
  const rpt = await fn('getOnlineReport', { token })
  check(rpt.ok && rpt.counts.inProgress >= 1, `getOnlineReport: ${rpt.counts.inProgress} in-progress, ${rpt.counts.neverStarted} not-started, ${rpt.groups.length} groups`)
  check(rpt.groups.some(x => x.groupId === R && x.flagged), 'the report keeps the flagged group on record (flag history survives the lock)')
  check(rpt.students.length >= 6, `the per-student status table has ${rpt.students.length} rows`)
  const rp = await openWindow(dashUrl.replace('/dashboard', '/reports'))
  await rp.waitForSelector('[data-testid="tile-online"]', { timeout: 45000 }).catch(() => {})
  check(await has(rp, 'tile-online'), 'Reports page has the "Assignment status" tile')
  await rp.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="tile-online"]')?.textContent ?? ''), null, { timeout: 12000 }).catch(() => {})
  await rp.click('text=Assignment status').catch(() => {})
  await rp.waitForSelector('[data-testid="crisis-status-table"]', { timeout: 12000 }).catch(() => {})
  check(await has(rp, 'crisis-status-table'), 'the "Assignment status" table renders')
  check(await rp.locator('[data-testid^="status-row-"]').count() >= 6, 'the status table lists the per-student rows')

  if (HEADED) { console.log('\n  (HEADED) leaving windows 10s…'); await sleep(10000) }
  for (const b of browsers) await b.close().catch(() => {})
  console.log('\n' + '═'.repeat(72))
  console.log(`  SMOKE: ${PASS} passed, ${FAIL} failed`)
  console.log('═'.repeat(72))
}

main().catch(e => { console.error('SMOKE ERROR:', e); FAIL++ }).finally(async () => { for (const b of browsers) await b.close().catch(() => {}); process.exit(FAIL === 0 ? 0 : 1) })

/* eslint-disable */
'use strict'

// Match Now — "entered the code = matched" (Elena, 2026-10-05; game-server ≥ v0.30.0).
//
// A student who entered the attendance code but is NOT connected at the instant of the
// click must still be matched. Found live in Grays 2.0: one phone mid-reload dropped a
// confirmed student and cost the class a clean grouping. In a robot-filled game the same
// drop would also have put a robot in that student's seat.
//
// DEFINITION-DRIVEN and self-seeding (Admin SDK, no per-game seed endpoint), so the same
// file runs in every game that matches through the shared `triggerMatching` name:
//   - reads the role and group size from lib/gameDefinition.js;
//   - if lib/matchWithBots.js exists, also checks the robot-filled remainder, that the
//     PREVIEW flag writes nothing (it must not trigger the robot fill), and that RE-MATCH
//     is refused.
//
// Run (from the game's root, after `npm run build` in functions/):
//   firebase emulators:exec --only functions,firestore,database --project <project> \
//     "node functions/test/matchPresenceIntegration.cjs"

const path = require('path')
const fs = require('fs')
const admin = require('firebase-admin')

const root = path.join(__dirname, '../..')
const ports = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).emulators
// The project the emulator was started with (a template has no real project id).
const PROJECT = process.env.GCLOUD_PROJECT || JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects.default
process.env.FIRESTORE_EMULATOR_HOST = `localhost:${ports.firestore.port}`
process.env.FIREBASE_DATABASE_EMULATOR_HOST = `localhost:${ports.database.port}`
const BASE = `http://localhost:${ports.functions.port}/${PROJECT}/us-central1`

const defModule = require('../lib/gameDefinition.js')
const def = Object.values(defModule).find(v => v && typeof v === 'object' && v.composition && v.roles)
const ROLE = def.roles.roles[0].key
const SIZE = def.composition[ROLE]
const CAP = def.perRoleCap ?? Infinity
const ROBOTS = fs.existsSync(path.join(__dirname, '../lib/matchWithBots.js'))
const FIELD = `${ROLE}_participants`

admin.initializeApp({ projectId: PROJECT })
const db = admin.firestore()
// The functions emulator may use either RTDB namespace; seed presence in both.
const rtdbs = [PROJECT, `${PROJECT}-default-rtdb`].map(ns =>
  admin.initializeApp({ projectId: PROJECT, databaseURL: `http://localhost:${ports.database.port}?ns=${ns}` }, ns).database())

let passed = 0, failed = 0
const ok = (label, cond, extra) => {
  if (cond) { console.log(`  [PASS] ${label}`); passed++ }
  else      { console.log(`  [FAIL] ${label}${extra !== undefined ? ` — ${extra}` : ''}`); failed++ }
}
async function call(name, body) {
  const r = await fetch(`${BASE}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: body }) })
  const j = await r.json()
  if (j.result !== undefined) return j.result
  return { ok: false, error: typeof j.error === 'string' ? j.error : (j.error?.message ?? JSON.stringify(j)) }
}
/** n students who have all entered the code; every one connected except `offline`. */
async function seed(gameId, n, offline) {
  const inst = db.collection('game_instances').doc(gameId)
  const now = admin.firestore.Timestamp.now()
  const batch = db.batch()
  const ids = Array.from({ length: n }, (_, i) => `s${String(i + 1).padStart(2, '0')}`)
  batch.set(inst, { game_instance_id: gameId }, { merge: true })
  for (const id of ids) batch.set(inst.collection('participants').doc(id), {
    participant_id: id, game_instance_id: gameId, role: ROLE, display_name: `Student ${id}`,
    prep_status: 'complete', knowledge_check_score: 1, confirmed_ready_at: now, attendance_confirmed_at: now,
  })
  await batch.commit()
  const presence = {}
  for (const id of ids) if (id !== offline) presence[id] = { online: true, last_seen: Date.now() }
  for (const r of rtdbs) await r.ref(`presence/${gameId}`).set(presence)
  return ids
}
async function state(gameId) {
  const inst = db.collection('game_instances').doc(gameId)
  const [gs, ps] = await Promise.all([inst.collection('groups').get(), inst.collection('participants').get()])
  const participants = ps.docs.map(d => d.data())
  return { groups: gs.docs.map(d => d.data()), humans: participants.filter(p => p.is_bot !== true), robots: participants.filter(p => p.is_bot === true) }
}
const seatsOf = (g) => (g[FIELD] ?? []).length

async function main() {
  console.log(`\n═══ ${def.game_id ?? PROJECT}: Match Now — the code is presence (groups of ${SIZE} ${ROLE}${ROBOTS ? ', robot-filled remainder' : ''}) ═══`)

  console.log('\n── A. Two full groups; one confirmed student is NOT connected ──')
  const a = `mp_full_${Date.now()}`
  const idsA = await seed(a, SIZE * 2, 's01')
  const pv = await call('triggerMatching', { _dev: { game_instance_id: a }, preview: true })
  ok(`preview: ${idsA.length} entered the code → 2 complete groups`, pv.ok === true && pv.preview?.confirmed === idsA.length && pv.preview.groups === 2, JSON.stringify(pv).slice(0, 220))
  ok('preview names the not-connected student', pv.preview?.not_connected?.map(p => p.participant_id).join() === 's01')
  let st = await state(a)
  ok('preview wrote NOTHING (no groups, no robots, nobody assigned)', st.groups.length === 0 && st.robots.length === 0 && st.humans.every(p => p.group_id == null))

  const m = await call('triggerMatching', { _dev: { game_instance_id: a } })
  st = await state(a)
  ok(`match → 2 groups of ${SIZE}, no robots`, m.ok === true && st.groups.length === 2 && st.groups.every(g => seatsOf(g) === SIZE) && st.robots.length === 0, m.error ?? JSON.stringify(st.groups.map(seatsOf)))
  ok('the not-connected student is in a group', st.humans.find(p => p.participant_id === 's01')?.group_id != null)
  ok('every student is in exactly one group', st.humans.every(p => st.groups.filter(g => (g[FIELD] ?? []).includes(p.participant_id)).length === 1))

  console.log('\n── B. One student more than two full groups; that student is NOT connected ──')
  const b = `mp_plus1_${Date.now()}`
  const n = SIZE * 2 + 1
  const idsB = await seed(b, n, 's01')
  if (ROBOTS) {
    const pvB = await call('triggerMatching', { _dev: { game_instance_id: b }, preview: true })
    ok(`preview: says the leftover student gets ${SIZE - 1} robot${SIZE - 1 === 1 ? '' : 's'}`, pvB.ok === true && typeof pvB.preview?.extras_note === 'string' && pvB.preview.extras_note.includes(`${SIZE - 1} robot`), JSON.stringify(pvB.preview ?? pvB).slice(0, 220))
    st = await state(b)
    ok('preview wrote NOTHING — in particular it did not run the robot fill', st.groups.length === 0 && st.robots.length === 0)
    const rm = await call('triggerMatching', { _dev: { game_instance_id: b }, rematch: true })
    ok(`re-match is refused (${rm.ok === false ? rm.error : 'UNEXPECTED OK'})`, rm.ok === false && (await state(b)).groups.length === 0)

    const mB = await call('triggerMatching', { _dev: { game_instance_id: b } })
    st = await state(b)
    ok(`match → 3 groups, each with ${SIZE} seats`, mB.ok === true && st.groups.length === 3 && st.groups.every(g => seatsOf(g) === SIZE), mB.error ?? JSON.stringify(st.groups.map(seatsOf)))
    ok('EVERY student is grouped, the not-connected one included', st.humans.length === n && st.humans.every(p => p.group_id != null))
    ok(`exactly ${SIZE - 1} robot${SIZE - 1 === 1 ? '' : 's'}, all in the one remainder group`, st.robots.length === SIZE - 1 && new Set(st.robots.map(r => r.group_id)).size === 1)
    const again = await call('triggerMatching', { _dev: { game_instance_id: b } })
    const st2 = await state(b)
    ok('pressing Match again changes nothing', again.ok === true && st2.groups.length === 3 && st2.robots.length === st.robots.length)
  } else {
    const mB = await call('triggerMatching', { _dev: { game_instance_id: b } })
    st = await state(b)
    const placed = st.humans.filter(p => p.group_id != null).length
    if (CAP > SIZE) {
      ok(`match → 2 groups, the extra student joins one (sizes ${st.groups.map(seatsOf).sort().join(', ')})`, mB.ok === true && st.groups.length === 2 && placed === n, mB.error)
    } else {
      // Group size is LOCKED (perRoleCap === composition): the one leftover student waits.
      ok(`match → 2 groups of ${SIZE}; group size is locked, so exactly one student is left over`, mB.ok === true && st.groups.length === 2 && st.groups.every(g => seatsOf(g) === SIZE) && placed === n - 1, `${mB.error ?? ''} placed ${placed}/${n}`)
    }
  }

  console.log(`\n═══ ${passed}/${passed + failed} checks passed ═══\n`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch(err => { console.error('FATAL', err); process.exit(1) })

// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS round-loop CALLABLES (Slice 2) — a thin, server-authoritative Firestore shell
// over the PURE machine (round/machine.ts). Each action reads the state doc, calls
// applyAction/expireStage, and writes the new state in ONE transaction, so "the last
// action closes the stage" and "the clock closes the stage" are both race-safe. NOTHING
// resolves on a client.
//
// State doc: game_instances/{iid}/crisis_round/{groupId}
//   { state: CrisisState, group_id, pid_by_seat, seat_by_pid, stage_deadline_ms, ... }
//
// THE CLOCK (eBay hard-close pattern, reused — NOT reinvented): each stage carries a
// server deadline (`stage_deadline_ms`). Only the CLOCK closes on timeout: checkRoundClock
// (and getRoundView, resolve-on-read) compares the SERVER clock to the deadline and, if
// passed, applies the Slice-1 defaults to the idle required seats and advances. One person
// can never stall the group.
//
// THREE BOT SEAMS kept clean for Slice 5 (do not build bots here):
//   1. applySeatAction — the auth-free action core; a bot writes through the SAME logic.
//   2. buildSeatView (machine) — per-seat state readable with no browser/auth.
//   3. seats are identified by INDEX (pid_by_seat / seat_by_pid); zero presence/heartbeat.
// ═══════════════════════════════════════════════════════════════════════════════

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, extractInstructorGameId } from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'
import { DEFAULT_CRISIS_SETTINGS } from './round/settings'
import {
  openRoundState, applyAction, expireStage, buildSeatView, roleOfSeat, requiredSeats,
  type CrisisState, type SeatAction,
} from './round/machine'
import {
  buyerDefaultAllocation, sellerDefaultBid, sellerDefaultFix, makeRng, type SellerType,
} from './round/decide'
import { enqueueBotTask } from './botTasks'

const isEmu = () => process.env.FUNCTIONS_EMULATOR === 'true'
const authHeaderOf = (req: CallableRequest): string | undefined =>
  req.rawRequest.headers.authorization as string | undefined
const CORS = { cors: crisisGameDef.corsOrigins }

const NUM_ROUNDS_DEFAULT = 10
const STAGE_SECONDS_DEFAULT = 120

/**
 * The clock the SERVER reads. In the emulator ONLY, a `_dev.now_ms` override lets the
 * harness advance virtual time deterministically; in prod it is always Date.now(). The
 * server is still the sole time authority — no client-supplied time is trusted in prod.
 */
function nowMs(data: Record<string, unknown>): number {
  if (isEmu()) {
    const dev = data['_dev'] as Record<string, unknown> | undefined
    if (dev && typeof dev['now_ms'] === 'number') return dev['now_ms'] as number
  }
  return Date.now()
}

/** Stable per-group seed so crisis draws + role assignment are reproducible and idempotent. */
function hashString(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function stateDoc(iid: string, groupId: string) {
  return admin.firestore().collection('game_instances').doc(iid).collection('crisis_round').doc(groupId)
}

interface StoredDoc {
  state: CrisisState
  group_id: string
  pid_by_seat: Record<string, string>
  seat_by_pid: Record<string, number>
  stage_seconds: number
  /** Clock ON (classroom) vs OFF (online). OFF → no deadline, stages never time out. */
  clock_enabled: boolean
  /** null when the clock is off (online play) — the UI renders no clock at all. */
  stage_deadline_ms: number | null
  /** When the current stage opened (ms) — the bot resolve-on-read backstop's overdue clock. */
  stage_opened_ms: number
  /** Seats filled by server bots (§5.1). [] for all-human groups. */
  bot_seats?: number[]
  /** seat (string) → the bot Seller's FIXED type (§5.2 — drawn once at formation). */
  bot_type_by_seat?: Record<string, SellerType>
}

/** A fresh stage deadline, or null when the clock is off. */
function nextDeadline(stored: StoredDoc, clockNowMs: number): number | null {
  return stored.clock_enabled ? clockNowMs + stored.stage_seconds * 1000 : null
}

const hasBots = (stored: StoredDoc): boolean => (stored.bot_seats?.length ?? 0) > 0

/**
 * Full stored payload for a wholesale (no-merge) write. `stageOpenedMs` is passed only
 * when a stage just closed (a new stage opened); otherwise the running value is kept.
 */
function storedPayload(stored: StoredDoc, newState: CrisisState, deadlineMs: number | null, stageOpenedMs?: number) {
  return {
    state: newState,
    group_id: stored.group_id,
    pid_by_seat: stored.pid_by_seat,
    seat_by_pid: stored.seat_by_pid,
    stage_seconds: stored.stage_seconds,
    clock_enabled: stored.clock_enabled,
    stage_deadline_ms: deadlineMs,
    stage_opened_ms: stageOpenedMs ?? stored.stage_opened_ms,
    bot_seats: stored.bot_seats ?? [],
    bot_type_by_seat: stored.bot_type_by_seat ?? {},
    updated_at: FieldValue.serverTimestamp(),
  }
}

// ── openRound (instructor): assign seats + LATE roles, start round 1 ─────────────
export const openRound = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const iid = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  const instanceRef = admin.firestore().collection('game_instances').doc(iid)
  const [groupSnap, configSnap] = await Promise.all([
    instanceRef.collection('groups').doc(groupId).get(),
    instanceRef.collection('config').doc('main').get(),
  ])
  if (!groupSnap.exists) throw new HttpsError('not-found', 'Group not found.')
  const playerPids = (groupSnap.data()?.['player_participants'] as string[] | undefined) ?? []
  if (playerPids.length !== 3) throw new HttpsError('failed-precondition', 'Crisis groups are exactly 3 players.')

  const cfg = (configSnap.data() ?? {}) as Record<string, unknown>
  const numRounds = Number(cfg['num_rounds'] ?? NUM_ROUNDS_DEFAULT) || NUM_ROUNDS_DEFAULT
  const stageSeconds = Number(cfg['round_seconds'] ?? STAGE_SECONDS_DEFAULT) || STAGE_SECONDS_DEFAULT
  const clockEnabled = (cfg['clock_mode'] ?? 'on') !== 'off'

  // Seat = array position (0..2). Roles are assigned LATE inside openRoundState (§2).
  const pidBySeat: Record<string, string> = {}
  const seatByPid: Record<string, number> = {}
  playerPids.forEach((pid, i) => { pidBySeat[String(i)] = pid; seatByPid[pid] = i })

  // Bots (§5.1): map the group's bot pids → seats + their FIXED type (drawn at formation).
  const botPids = new Set((groupSnap.data()?.['bot_participants'] as string[] | undefined) ?? [])
  const botTypesByPid = (groupSnap.data()?.['bot_types'] as Record<string, SellerType> | undefined) ?? {}
  const botSeats: number[] = []
  const botTypeBySeat: Record<string, SellerType> = {}
  playerPids.forEach((pid, i) => {
    if (botPids.has(pid)) { botSeats.push(i); botTypeBySeat[String(i)] = botTypesByPid[pid] ?? 'low' }
  })

  const devSeed = isEmu() ? (data['_dev'] as Record<string, unknown> | undefined)?.['seed'] : undefined
  const seed = typeof devSeed === 'number' ? devSeed : hashString(groupId)

  const now = nowMs(data)
  const state = openRoundState([0, 1, 2], seed, numRounds)
  await stateDoc(iid, groupId).set({
    state,
    group_id: groupId,
    pid_by_seat: pidBySeat,
    seat_by_pid: seatByPid,
    stage_seconds: stageSeconds,
    clock_enabled: clockEnabled,
    stage_deadline_ms: clockEnabled ? now + stageSeconds * 1000 : null,
    stage_opened_ms: now,
    bot_seats: botSeats,
    bot_type_by_seat: botTypeBySeat,
    updated_at: FieldValue.serverTimestamp(),
  })
  // Schedule the first bot pass (round 1). No-op for all-human groups; the emulator (no
  // Cloud Tasks) relies on runBotActionsForTest / the resolve-on-read backstop instead.
  if (botSeats.length > 0) await enqueueBotTask(iid, groupId, state.round, state.stage)
  return { ok: true as const, round: state.round, stage: state.stage, clockEnabled, botSeats: botSeats.length }
})

// ── the auth-free action core (BOT SEAM #1 — shared by human callables AND, in Slice 5,
// the bot runner). The caller has ALREADY established WHO is acting. buildAction may
// return null (bot "no move") → nothing written. ──────────────────────────────────
export async function applySeatAction(
  iid: string,
  groupId: string,
  participantId: string,
  buildAction: (seat: number, state: CrisisState) => SeatAction | null,
  clockNowMs: number,
) {
  const db = admin.firestore()
  const ref = stateDoc(iid, groupId)
  const instanceRef = db.collection('game_instances').doc(iid)
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Round not started.')
    const stored = snap.data() as StoredDoc
    const seat = stored.seat_by_pid[participantId]
    if (seat === undefined) throw new HttpsError('permission-denied', 'You are not in this group.')

    const action = buildAction(seat, stored.state)
    if (action === null) return { ok: true as const, skipped: true, stageClosed: false, finished: false, hasBots: hasBots(stored), round: stored.state.round, stage: stored.state.stage }

    const wasFirstAction = stored.state.round === 1 && stored.state.everActed.length === 0
    const result = applyAction(stored.state, seat, action, DEFAULT_CRISIS_SETTINGS)
    if (!result.ok) return { ok: false as const, reason: result.reason }

    // A new stage/round opened → fresh deadline + fresh stage_opened_ms; else keep them.
    const deadline = result.stageClosed ? nextDeadline(stored, clockNowMs) : stored.stage_deadline_ms
    const openedMs = result.stageClosed ? clockNowMs : stored.stage_opened_ms
    tx.set(ref, storedPayload(stored, result.state, deadline, openedMs))

    // Groups lock at first submission (§6): stamp the group doc once round-1 play begins.
    if (wasFirstAction) {
      tx.set(instanceRef.collection('groups').doc(groupId), { seats_locked_at: FieldValue.serverTimestamp() }, { merge: true })
    }
    if (result.finished) writeEndOutcomes(tx, instanceRef, stored, result.state)

    return { ok: true as const, skipped: false, stageClosed: result.stageClosed, finished: result.finished, hasBots: hasBots(stored), round: result.state.round, stage: result.state.stage }
  })

  // Post-commit: a stage just closed in a group that has bots and is still running → schedule
  // the next bot pass (idempotent, deduped by round+stage). Best-effort; the backstop covers a miss.
  if (outcome.ok && !outcome.skipped && outcome.stageClosed && !outcome.finished && outcome.hasBots) {
    await enqueueBotTask(iid, groupId, outcome.round, outcome.stage)
  }
  return outcome
}

// ── THE BOT RUNNER (§5.1) — ONE decide(), consumed here AND by the browser driver ──
// A bot's decision is the §3.2 default table with its FIXED Seller type (§5.2 — timeout
// fill would draw the type fresh PER ROUND; a bot holds it all 10 rounds). buildBotAction
// picks the action the bot owes this stage; runBotActions writes it through applySeatAction
// (the SAME transaction core a human hits — no HTTP fake). IDEMPOTENT by construction: a
// bot that already acted this stage produces owes===null / an already-acted reject → no write.

/** Raw prior-fix counts per seller across closed rounds (§3.2 note — count, not rate). */
function priorFixCounts(state: CrisisState): { f1: number; f2: number } {
  let f1 = 0, f2 = 0
  for (const h of state.history) {
    if (h.crisisOccurred && h.fixed.s1) f1++
    if (h.crisisOccurred && h.fixed.s2) f2++
  }
  return { f1, f2 }
}

/** The bot's action for the current stage, or null if it owes nothing right now. */
function buildBotAction(seat: number, state: CrisisState, botType: SellerType): SeatAction | null {
  if (roleOfSeat(state, seat) === null) return null
  const owes = buildSeatView(state, seat).owes
  if (owes === null) return null
  if (owes === 'bid') {
    // Seller: bid from the FIXED type; the VALUE is redrawn within range each round.
    const rng = makeRng((state.seed + state.round * 15485863 + seat * 32452843) | 0)
    return { kind: 'bid', bid: sellerDefaultBid(botType, rng, DEFAULT_CRISIS_SETTINGS) }
  }
  if (owes === 'fix') {
    return { kind: 'fix', fixed: sellerDefaultFix(botType) } // HIGH always fixes, LOW never
  }
  // Buyer default: 80 to the lower bid; ties by prior-fix count; full tie → 50/50.
  const { f1, f2 } = priorFixCounts(state)
  const { a1, a2 } = buyerDefaultAllocation(state.bids[state.seller1Seat], state.bids[state.seller2Seat], f1, f2, DEFAULT_CRISIS_SETTINGS)
  return { kind: 'allocation', a1, a2 }
}

/** Run one bot-action pass for a group: each bot seat that owes an action writes it. */
export async function runBotActions(iid: string, groupId: string) {
  const snap = await stateDoc(iid, groupId).get()
  if (!snap.exists) return { acted: 0, skipped: 0, status: 'not_found' as const }
  const stored = snap.data() as StoredDoc
  const botSeats = stored.bot_seats ?? []
  if (stored.state.status !== 'in_progress' || botSeats.length === 0) {
    return { acted: 0, skipped: 0, status: stored.state.status }
  }
  let acted = 0, skipped = 0
  for (const seat of botSeats) {
    const pid = stored.pid_by_seat[String(seat)]
    if (!pid) { skipped++; continue }
    const botType = stored.bot_type_by_seat?.[String(seat)] ?? 'low'
    // Each bot acts in its OWN transaction — a duplicate delivery (Cloud Tasks retry)
    // re-reads and applyAction rejects "already acted" → a no-op, never a double action.
    const r = await applySeatAction(iid, groupId, pid, (s, st) => buildBotAction(s, st, botType), Date.now())
    if (r.ok && !r.skipped) acted++
    else skipped++
  }
  return { acted, skipped, status: 'in_progress' as const }
}

/** Resolve-on-read backstop: rescue an OVERDUE bot pass (a missed Cloud Task) BEFORE the
 *  clock could time the bot out — so a bot always acts with its fixed type, and the clock
 *  only ever defaults a genuinely-absent HUMAN. Gated on stage_opened_ms so it does not
 *  defeat the plausible-pacing delay. */
const BOT_BACKSTOP_MS = 28_000
async function backstopBots(iid: string, groupId: string, stored: StoredDoc, clockNowMs: number): Promise<void> {
  if (stored.state.status !== 'in_progress' || !hasBots(stored)) return
  if (clockNowMs - stored.stage_opened_ms < BOT_BACKSTOP_MS) return
  const anyBotOwes = (stored.bot_seats ?? []).some((seat) => buildSeatView(stored.state, seat).owes !== null)
  if (!anyBotOwes) return
  await runBotActions(iid, groupId)
}

// ── shared student wrapper: auth, then the auth-free core ─────────────────────────
async function applyStudentAction(
  request: CallableRequest,
  build: (seat: number, state: CrisisState) => SeatAction,
) {
  const data = request.data as Record<string, unknown>
  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')
  const r = await applySeatAction(gameInstanceId, groupId, participantId, build, nowMs(data))
  if (!r.ok) return { ok: false as const, reason: r.reason }
  return { ok: true as const, stageClosed: r.stageClosed, finished: r.finished, round: r.round, stage: r.stage }
}

// ── student action callables (the SAME names the Slice-3 UI will invoke) ──────────
export const submitBid = onCall(CORS, async (request) => {
  const bid = Number((request.data as Record<string, unknown>)['bid'])
  return applyStudentAction(request, () => ({ kind: 'bid', bid }))
})

export const submitAllocation = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const a1 = Number(data['a1']); const a2 = Number(data['a2'])
  return applyStudentAction(request, () => ({ kind: 'allocation', a1, a2 }))
})

export const submitFix = onCall(CORS, async (request) => {
  const fixed = Boolean((request.data as Record<string, unknown>)['fixed'])
  return applyStudentAction(request, () => ({ kind: 'fix', fixed }))
})

// ── checkRoundClock: the deadline-observed close (eBay pattern). Any group member OR the
// harness invokes it; if the server deadline has passed and the stage is still open, apply
// the Slice-1 defaults to idle required seats and advance. Idempotent — a second fire after
// the stage already advanced sees a fresh (unexpired) deadline and no-ops. ───────────────
async function tickClock(iid: string, groupId: string, clockNowMs: number) {
  const db = admin.firestore()
  const ref = stateDoc(iid, groupId)
  const instanceRef = db.collection('game_instances').doc(iid)
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) return { ok: true as const, closed: false, reason: 'not_started' }
    const stored = snap.data() as StoredDoc
    if (stored.state.status !== 'in_progress') return { ok: true as const, closed: false, reason: 'finished' }
    // Clock OFF (online play) → stages never time out; only real actions close them.
    if (!stored.clock_enabled || stored.stage_deadline_ms === null) return { ok: true as const, closed: false, reason: 'clock_off' }
    if (clockNowMs < stored.stage_deadline_ms) return { ok: true as const, closed: false, reason: 'not_expired' }

    const result = expireStage(stored.state, DEFAULT_CRISIS_SETTINGS)
    const deadline = nextDeadline(stored, clockNowMs)
    const openedMs = result.stageClosed ? clockNowMs : stored.stage_opened_ms
    tx.set(ref, storedPayload(stored, result.state, deadline, openedMs))
    if (result.finished) writeEndOutcomes(tx, instanceRef, stored, result.state)
    return { ok: true as const, closed: result.stageClosed, finished: result.finished, round: result.state.round, stage: result.state.stage }
  })
}

/** Read-then-backstop: run an overdue bot pass BEFORE the clock tick (bots act with their
 *  fixed type before the clock could default them). Best-effort; ignore contention. */
async function backstopThenTick(iid: string, groupId: string, clockNowMs: number): Promise<void> {
  try {
    const snap = await stateDoc(iid, groupId).get()
    if (snap.exists) await backstopBots(iid, groupId, snap.data() as StoredDoc, clockNowMs)
  } catch { /* another writer won */ }
  try { await tickClock(iid, groupId, clockNowMs) } catch { /* another writer won */ }
}

export const checkRoundClock = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  // Accept either student or instructor auth — the clock is not privileged.
  let iid: string
  try {
    iid = (await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))).gameInstanceId
  } catch {
    iid = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  }
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')
  return tickClock(iid, groupId, nowMs(data))
})

// ── getRoundView (student): the per-seat projection + resolve-on-read clock check ─
export const getRoundView = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  // Resolve-on-read: rescue an overdue bot pass, THEN advance a genuinely stalled clock.
  await backstopThenTick(gameInstanceId, groupId, nowMs(data))

  const snap = await stateDoc(gameInstanceId, groupId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Round not started.')
  const stored = snap.data() as StoredDoc
  const seat = stored.seat_by_pid[participantId]
  if (seat === undefined) throw new HttpsError('permission-denied', 'You are not in this group.')

  return {
    ok: true as const,
    ...buildSeatView(stored.state, seat),
    clockEnabled: stored.clock_enabled,
    stageDeadlineMs: stored.clock_enabled ? stored.stage_deadline_ms : null,
  }
})

// ── getInstructorRoundView (instructor): all seats + roles + timeouts (dashboard/harness) ─
export const getInstructorRoundView = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const iid = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  await backstopThenTick(iid, groupId, nowMs(data))
  const snap = await stateDoc(iid, groupId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Round not started.')
  const stored = snap.data() as StoredDoc
  const st = stored.state
  const seats = [0, 1, 2].map((seat) => ({
    seat,
    participantId: stored.pid_by_seat[String(seat)] ?? null,
    role: roleOfSeat(st, seat),
    timeouts: st.timeouts[seat] ?? [],
  }))
  return {
    ok: true as const,
    status: st.status, round: st.round, numRounds: st.numRounds, stage: st.stage,
    seats,
    pendingSeats: st.status === 'in_progress' ? requiredSeats(st).filter((s) => buildSeatView(st, s).owes !== null) : [],
    history: st.history,
    clockEnabled: stored.clock_enabled,
    stageDeadlineMs: stored.clock_enabled ? stored.stage_deadline_ms : null,
  }
})

// ── getCrisisDashboard (instructor): the §4A live WINDOW over EVERY group ─────────
// A read-only overview — NO controls. For each group it answers Elena's question
// ("who is holding things up?"): the current round, the current stage, and WHICH SEAT
// the stage is waiting on (that data already exists — it is the stage-close condition).
// Plus timeout counts (§3.3) and whether a crisis occurred this round.
//
// BOTS ARE FILTERED OUT (§5.3): a participant with is_bot:true is removed from the seat
// rows AND from waitingOn, even though it is a real seat in the group and round record.
// Built now, ahead of Slice 5, so the filter never has to be retrofitted onto a live path.
export const getCrisisDashboard = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const iid = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const instanceRef = admin.firestore().collection('game_instances').doc(iid)

  const [groupsSnap, roundsSnap, participantsSnap] = await Promise.all([
    instanceRef.collection('groups').get(),
    instanceRef.collection('crisis_round').get(),
    instanceRef.collection('participants').get(),
  ])

  // Resolve-on-read backstop: the dashboard polls ~2s, a reliable place to rescue an
  // overdue bot pass. Fire-and-await; the freshly-acted state surfaces on the next poll.
  const now = nowMs(data)
  await Promise.all(roundsSnap.docs.map((r) => backstopBots(iid, r.id, r.data() as StoredDoc, now).catch(() => {})))

  // participant → { name, isBot }
  const meta = new Map<string, { name: string; isBot: boolean }>()
  for (const p of participantsSnap.docs) {
    const d = p.data() as Record<string, unknown>
    const name = (((d['display_name'] ?? d['name'] ?? '') as string).trim()) || `${p.id.slice(0, 6)}…`
    meta.set(p.id, { name, isBot: d['is_bot'] === true })
  }

  const roundByGroup = new Map<string, StoredDoc>()
  for (const r of roundsSnap.docs) roundByGroup.set(r.id, r.data() as StoredDoc)

  // Stable group numbers by sorted group_id (matches getReportData).
  const sortedGroupIds = groupsSnap.docs.map(g => g.id).sort((a, b) => a.localeCompare(b))
  const groupNumber = new Map(sortedGroupIds.map((id, i) => [id, i + 1]))

  const groups = groupsSnap.docs.map((gdoc) => {
    const gid = gdoc.id
    const gStatus = (gdoc.data()['status'] as string | undefined) ?? 'matched'
    const stored = roundByGroup.get(gid)

    if (!stored) {
      // Matched but the round loop hasn't been opened — a startable (launcher) group.
      return {
        groupId: gid, groupNumber: groupNumber.get(gid) ?? null,
        status: 'not_started' as const, startable: gStatus === 'matched',
        round: null, numRounds: null, stage: null, crisisOccurred: null,
        clockEnabled: null, stageDeadlineMs: null, seats: [], waitingOn: [],
      }
    }

    const st = stored.state
    // Seat rows — BOTS FILTERED OUT (§5.3).
    const seats = [0, 1, 2].map((seat) => {
      const pid = stored.pid_by_seat[String(seat)]
      const m = pid ? meta.get(pid) : undefined
      const timeouts = st.timeouts[seat] ?? []
      const waiting = st.status === 'in_progress' && buildSeatView(st, seat).owes !== null
      return { seat, role: roleOfSeat(st, seat), participantId: pid ?? null, name: m?.name ?? null, isBot: m?.isBot ?? false, timeoutCount: timeouts.length, timeouts, waiting }
    }).filter(s => !s.isBot)

    // "Who is holding it up" — pending HUMAN seats only.
    const waitingOn = seats.filter(s => s.waiting).map(s => ({ role: s.role, name: s.name }))

    return {
      groupId: gid, groupNumber: groupNumber.get(gid) ?? null,
      status: st.status, startable: false,
      round: st.round, numRounds: st.numRounds, stage: st.stage,
      crisisOccurred: st.crisisOccurred,
      clockEnabled: stored.clock_enabled,
      stageDeadlineMs: stored.clock_enabled ? stored.stage_deadline_ms : null,
      seats, waitingOn,
    }
  }).sort((a, b) => (a.groupNumber ?? Infinity) - (b.groupNumber ?? Infinity))

  return { ok: true as const, groups }
})

// ── on FINISH: denormalize participation metadata + mark the group completed ──────
// Scoring is participation-only (spec §4), so the group outcome is a placeholder; the
// generic finalize / scoreAndRecord path just needs a completed group with an outcome.
// Records §3.3: timeout_count (+ the round/stage list), rounds_played, rounds_played_vs_bot
// (0 in Slice 2 — bots arrive in Slice 5).
function writeEndOutcomes(
  tx: FirebaseFirestore.Transaction,
  instanceRef: FirebaseFirestore.DocumentReference,
  stored: StoredDoc,
  state: CrisisState,
) {
  // Bots (§5.4) are in the group for all 10 rounds, so a HUMAN in a bot-filled group
  // played every round against a bot — visible, never blocked (Elena judges the lesson).
  const botSeats = new Set(stored.bot_seats ?? [])
  const groupHasBots = botSeats.size > 0
  for (const [seatStr, pid] of Object.entries(stored.pid_by_seat)) {
    const seat = Number(seatStr)
    if (botSeats.has(seat)) continue        // bots carry NO gradebook metadata (excluded downstream)
    const timeouts = state.timeouts[seat] ?? []
    const role = roleOfSeat(state, seat)
    const roundsVsBot = groupHasBots ? state.numRounds : 0
    // The `details` blob is what toGameResult forwards to the gradebook (metadata, NOT a
    // score). §3.3: timeout is a COUNT PLUS the round numbers — never a boolean.
    const details = {
      crisis_role: role,
      timeout_count: timeouts.length,
      timeout_rounds: timeouts.map((t) => t.round),  // the round numbers → gradebook
      timeout_events: timeouts,                       // {round, stage}[]
      rounds_played: state.numRounds,
      rounds_played_vs_bot: roundsVsBot,
    }
    tx.set(instanceRef.collection('participants').doc(pid), {
      crisis_role: role,
      timeout_count: timeouts.length,
      timeout_events: timeouts,
      rounds_played: state.numRounds,
      rounds_played_vs_bot: roundsVsBot,
      total_profit: totalProfitForSeat(state, seat),
      details,
    }, { merge: true })
  }
  tx.set(instanceRef.collection('groups').doc(stored.group_id), {
    status: 'completed',
    agreement_reached: true,
    outcome: { placeholder_result: 0 },      // participation-only; content is scoring-irrelevant
    crisis_finished_at: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** A seat's cumulative profit across all rounds (a GAME result / debrief figure, NOT a grade). */
function totalProfitForSeat(state: CrisisState, seat: number): number {
  let total = 0
  for (const h of state.history) {
    if (seat === h.buyerSeat) total += h.profits.buyer
    else if (seat === h.seller1Seat) total += h.profits.seller1
    else if (seat === h.seller2Seat) total += h.profits.seller2
  }
  return total
}

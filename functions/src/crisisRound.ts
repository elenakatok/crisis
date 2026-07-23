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
  stage_deadline_ms: number
}

/** Full stored payload for a wholesale (no-merge) write. */
function storedPayload(stored: StoredDoc, newState: CrisisState, deadlineMs: number) {
  return {
    state: newState,
    group_id: stored.group_id,
    pid_by_seat: stored.pid_by_seat,
    seat_by_pid: stored.seat_by_pid,
    stage_seconds: stored.stage_seconds,
    stage_deadline_ms: deadlineMs,
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

  // Seat = array position (0..2). Roles are assigned LATE inside openRoundState (§2).
  const pidBySeat: Record<string, string> = {}
  const seatByPid: Record<string, number> = {}
  playerPids.forEach((pid, i) => { pidBySeat[String(i)] = pid; seatByPid[pid] = i })

  const devSeed = isEmu() ? (data['_dev'] as Record<string, unknown> | undefined)?.['seed'] : undefined
  const seed = typeof devSeed === 'number' ? devSeed : hashString(groupId)

  const state = openRoundState([0, 1, 2], seed, numRounds)
  await stateDoc(iid, groupId).set({
    state,
    group_id: groupId,
    pid_by_seat: pidBySeat,
    seat_by_pid: seatByPid,
    stage_seconds: stageSeconds,
    stage_deadline_ms: nowMs(data) + stageSeconds * 1000,
    updated_at: FieldValue.serverTimestamp(),
  })
  return { ok: true as const, round: state.round, stage: state.stage }
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
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Round not started.')
    const stored = snap.data() as StoredDoc
    const seat = stored.seat_by_pid[participantId]
    if (seat === undefined) throw new HttpsError('permission-denied', 'You are not in this group.')

    const action = buildAction(seat, stored.state)
    if (action === null) return { ok: true as const, skipped: true, stageClosed: false, finished: false }

    const wasFirstAction = stored.state.round === 1 && stored.state.everActed.length === 0
    const result = applyAction(stored.state, seat, action, DEFAULT_CRISIS_SETTINGS)
    if (!result.ok) return { ok: false as const, reason: result.reason }

    // A new stage/round opened → fresh deadline; else keep the running one.
    const deadline = result.stageClosed ? clockNowMs + stored.stage_seconds * 1000 : stored.stage_deadline_ms
    tx.set(ref, storedPayload(stored, result.state, deadline))

    // Groups lock at first submission (§6): stamp the group doc once round-1 play begins.
    if (wasFirstAction) {
      tx.set(instanceRef.collection('groups').doc(groupId), { seats_locked_at: FieldValue.serverTimestamp() }, { merge: true })
    }
    if (result.finished) writeEndOutcomes(tx, instanceRef, stored, result.state)

    return { ok: true as const, skipped: false, stageClosed: result.stageClosed, finished: result.finished, round: result.state.round, stage: result.state.stage }
  })
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
    if (clockNowMs < stored.stage_deadline_ms) return { ok: true as const, closed: false, reason: 'not_expired' }

    const result = expireStage(stored.state, DEFAULT_CRISIS_SETTINGS)
    const deadline = clockNowMs + stored.stage_seconds * 1000
    tx.set(ref, storedPayload(stored, result.state, deadline))
    if (result.finished) writeEndOutcomes(tx, instanceRef, stored, result.state)
    return { ok: true as const, closed: result.stageClosed, finished: result.finished, round: result.state.round, stage: result.state.stage }
  })
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

  // Resolve-on-read: a polling student advances a genuinely stalled clock (same guard as
  // checkRoundClock — only closes if the deadline passed). Best-effort; ignore contention.
  try { await tickClock(gameInstanceId, groupId, nowMs(data)) } catch { /* another writer won */ }

  const snap = await stateDoc(gameInstanceId, groupId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Round not started.')
  const stored = snap.data() as StoredDoc
  const seat = stored.seat_by_pid[participantId]
  if (seat === undefined) throw new HttpsError('permission-denied', 'You are not in this group.')

  return { ok: true as const, ...buildSeatView(stored.state, seat), stageDeadlineMs: stored.stage_deadline_ms }
})

// ── getInstructorRoundView (instructor): all seats + roles + timeouts (dashboard/harness) ─
export const getInstructorRoundView = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const iid = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

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
    stageDeadlineMs: stored.stage_deadline_ms,
  }
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
  for (const [seatStr, pid] of Object.entries(stored.pid_by_seat)) {
    const seat = Number(seatStr)
    const timeouts = state.timeouts[seat] ?? []
    const role = roleOfSeat(state, seat)
    tx.set(instanceRef.collection('participants').doc(pid), {
      crisis_role: role,
      timeout_count: timeouts.length,
      timeout_events: timeouts,               // {round, stage}[] — a count PLUS the rounds (§3.3)
      rounds_played: state.numRounds,
      rounds_played_vs_bot: 0,                // Slice 5 (bots) will set this
      total_profit: totalProfitForSeat(state, seat),
      details: { crisis_role: role, timeout_count: timeouts.length, rounds_played: state.numRounds },
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

// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS round-loop STATE MACHINE (Slice 2) — PURE transitions over a plain state
// object. The Firestore/clock shell (crisisRound.ts) just reads → apply → writes in a
// transaction; NOTHING resolves on a client. Same shape as SAA's roundLoop.ts.
//
// Ten rounds, three SEATS (index 0..2), roles assigned LATE at open (§2). Each round has
// ordered stages (§1.2):
//   bidding    — both Seller seats submit a price (SEALED: neither sees the other first)
//   allocation — the Buyer seat splits 100 units (§1.3-validated)
//   [crisis draw — 50%, server-side, per group per round]
//   fixing     — ONLY if a crisis occurred; each Seller with >0 units decides to fix
//   → resolve (Slice-1 resolveRound), record history, advance or finish.
//
// A stage closes when EVERY REQUIRED seat has acted OR the clock expires (expireStage
// applies the Slice-1 default to each non-actor). "Required" is COMPUTED, never assumed —
// a Seller allocated 0 units has NO fix decision and is never waited on. Closing is
// idempotent: expireStage only ever touches the CURRENT stage, so a double-fire advances
// once (the shell's transaction serialises concurrent fires).
//
// All randomness (crisis draw, timeout type draws, role shuffle) is derived
// DETERMINISTICALLY from `seed` in the state, so a replay/idempotent re-run draws
// identically. No Math.random / Date here.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CrisisRoundSettings } from './settings'
import { resolveRound } from './resolver'
import { validateAllocation } from './allocation'
import {
  buyerDefaultAllocation, sellerDefaultBid, sellerDefaultFix,
  sellerFixFromBid, makeRng, type SellerType,
} from './decide'

export type Stage = 'bidding' | 'allocation' | 'fixing'
export type Status = 'in_progress' | 'finished'

/** One completed round, exactly what the Slice-3 history table renders (everyone sees it). */
export interface RoundRecord {
  round: number
  buyerSeat: number
  seller1Seat: number
  seller2Seat: number
  bids: { s1: number; s2: number }
  allocation: { a1: number; a2: number }
  crisisOccurred: boolean
  /** As-applied fix decisions (false for a 0-unit seller / no crisis). */
  fixed: { s1: boolean; s2: boolean }
  profits: { seller1: number; seller2: number; buyer: number }
  /** Which ROLE's decision was filled by a default this round (timeout). */
  defaulted: { s1: boolean; s2: boolean; buyer: boolean }
}

export interface TimeoutRecord { round: number; stage: Stage }

export interface CrisisState {
  status: Status
  numRounds: number
  round: number
  stage: Stage
  /** Deterministic draw seed (crisis + timeout types). Stored so replay is reproducible. */
  seed: number

  // ── seat → role (assigned LATE at open, §2) ──────────────────────────────────
  buyerSeat: number
  seller1Seat: number
  seller2Seat: number

  // ── current-round working set (cleared each round) ───────────────────────────
  /** seat → bid (seller seats). A key present means that seat has acted (or defaulted). */
  bids: Record<number, number>
  /** seat → type, set ONLY when a seller DEFAULTED its bid (row 1) — drives its fix later. */
  roundType: Record<number, SellerType>
  allocation: { a1: number; a2: number } | null
  crisisOccurred: boolean | null
  /** seat → fix decision. A key present means that seat has acted (or defaulted). */
  fixes: Record<number, boolean>
  /** Which role defaulted THIS round (reset each round; folded into the RoundRecord). */
  defaultedThisRound: { s1: boolean; s2: boolean; buyer: boolean }

  // ── accumulated ──────────────────────────────────────────────────────────────
  history: RoundRecord[]
  /** seat → its timeout log (count + round + stage; §3.3 — never a boolean). */
  timeouts: Record<number, TimeoutRecord[]>
  /** seats that submitted at least one REAL action across the game (rounds_played proxy). */
  everActed: number[]
}

// ── deterministic per-purpose RNG (idempotent draws) ────────────────────────────
function crisisRoll(seed: number, round: number): number {
  return makeRng((seed + round * 2654435761) | 0)()
}
function typeRoll(seed: number, round: number, seat: number): number {
  return makeRng((seed + round * 40503 + seat * 104729) | 0)()
}

/** Fisher–Yates shuffle of [0,1,2] seeded deterministically — the LATE role assignment. */
function assignRoles(seats: number[], roleSeed: number): { buyerSeat: number; seller1Seat: number; seller2Seat: number } {
  const rng = makeRng(roleSeed | 0)
  const a = [...seats]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return { buyerSeat: a[0], seller1Seat: a[1], seller2Seat: a[2] }
}

/**
 * Open a group's game at round 1. `seats` are the three seat indices (0..2). Roles are
 * assigned LATE here (§2) via a deterministic shuffle. `seed` feeds every later draw.
 */
export function openRoundState(seats: number[], seed: number, numRounds: number): CrisisState {
  if (seats.length !== 3) throw new Error('openRoundState: Crisis groups are exactly 3 seats.')
  const { buyerSeat, seller1Seat, seller2Seat } = assignRoles(seats, seed)
  return {
    status: 'in_progress',
    numRounds,
    round: 1,
    stage: 'bidding',
    seed,
    buyerSeat, seller1Seat, seller2Seat,
    bids: {},
    roundType: {},
    allocation: null,
    crisisOccurred: null,
    fixes: {},
    defaultedThisRound: { s1: false, s2: false, buyer: false },
    history: [],
    timeouts: Object.fromEntries(seats.map((s) => [s, []])),
    everActed: [],
  }
}

// ── seat/role helpers ───────────────────────────────────────────────────────────

export function roleOfSeat(state: CrisisState, seat: number): 'buyer' | 'seller1' | 'seller2' | null {
  if (seat === state.buyerSeat) return 'buyer'
  if (seat === state.seller1Seat) return 'seller1'
  if (seat === state.seller2Seat) return 'seller2'
  return null
}

/** Seats that MUST act to close the current stage — COMPUTED, never assumed. */
export function requiredSeats(state: CrisisState): number[] {
  switch (state.stage) {
    case 'bidding':
      return [state.seller1Seat, state.seller2Seat]
    case 'allocation':
      return [state.buyerSeat]
    case 'fixing': {
      // Only sellers allocated >0 units have a fix decision (§1.2 stage 3).
      const req: number[] = []
      if ((state.allocation?.a1 ?? 0) > 0) req.push(state.seller1Seat)
      if ((state.allocation?.a2 ?? 0) > 0) req.push(state.seller2Seat)
      return req
    }
  }
}

/** Has a given seat already acted (or been defaulted) in the current stage? */
export function seatHasActed(state: CrisisState, seat: number): boolean {
  switch (state.stage) {
    case 'bidding':  return state.bids[seat] !== undefined
    case 'allocation': return state.allocation !== null
    case 'fixing':   return state.fixes[seat] !== undefined
  }
}

/** Required seats that have NOT yet acted in the current stage. */
export function pendingSeats(state: CrisisState): number[] {
  return requiredSeats(state).filter((s) => !seatHasActed(state, s))
}

function allRequiredActed(state: CrisisState): boolean {
  return pendingSeats(state).length === 0
}

// ── actions ─────────────────────────────────────────────────────────────────────

export type SeatAction =
  | { kind: 'bid'; bid: number }
  | { kind: 'allocation'; a1: number; a2: number }
  | { kind: 'fix'; fixed: boolean }

export interface ApplyResult {
  ok: boolean
  reason?: string
  /** True when this action (or default) closed the current stage. */
  stageClosed: boolean
  /** True when the whole game finished on this transition. */
  finished: boolean
  state: CrisisState
}

const fail = (state: CrisisState, reason: string): ApplyResult =>
  ({ ok: false, reason, stageClosed: false, finished: false, state })

function clone(state: CrisisState): CrisisState {
  return structuredClone(state)
}

/**
 * Apply ONE seat's action. Validates role↔stage, not-already-acted, and the value
 * (integer bid; §1.3-legal allocation), records it, and closes the stage if this was the
 * last required action. Returns { ok:false, reason } WITHOUT recording on any rejection.
 */
export function applyAction(
  state: CrisisState, seat: number, action: SeatAction, s: CrisisRoundSettings,
): ApplyResult {
  if (state.status !== 'in_progress') return fail(state, 'The game has finished.')
  const role = roleOfSeat(state, seat)
  if (role === null) return fail(state, 'Not a seat in this group.')

  const next = clone(state)

  switch (action.kind) {
    case 'bid': {
      if (state.stage !== 'bidding') return fail(state, 'Not the bidding stage.')
      if (role !== 'seller1' && role !== 'seller2') return fail(state, 'Only Sellers bid.')
      if (state.bids[seat] !== undefined) return fail(state, 'You have already bid this round.')
      if (!Number.isInteger(action.bid) || action.bid < 0) return fail(state, 'A bid must be a whole, non-negative number.')
      next.bids[seat] = action.bid
      break
    }
    case 'allocation': {
      if (state.stage !== 'allocation') return fail(state, 'Not the allocation stage.')
      if (role !== 'buyer') return fail(state, 'Only the Buyer allocates.')
      if (state.allocation !== null) return fail(state, 'You have already allocated this round.')
      const check = validateAllocation(action.a1, action.a2, s)
      if (!check.ok) return fail(state, check.reason)
      next.allocation = { a1: action.a1, a2: action.a2 }
      break
    }
    case 'fix': {
      if (state.stage !== 'fixing') return fail(state, 'Not the fix stage.')
      if (role !== 'seller1' && role !== 'seller2') return fail(state, 'Only Sellers fix.')
      if (!requiredSeats(state).includes(seat)) return fail(state, 'You have no units this round — no fix decision.')
      if (state.fixes[seat] !== undefined) return fail(state, 'You have already decided this round.')
      next.fixes[seat] = action.fixed
      break
    }
  }

  if (!next.everActed.includes(seat)) next.everActed.push(seat)
  return closeStageIfReady(next, s)
}

/**
 * The CLOCK path: the stage's deadline passed. Fill every required-but-idle seat with its
 * Slice-1 default (per-round type draw for a no-bid seller — timeout scope, NOT bot),
 * record the timeout (§3.3), then close the stage. Idempotent: if the stage has no pending
 * seats (already closed/advanced) this is a no-op close.
 */
export function expireStage(state: CrisisState, s: CrisisRoundSettings): ApplyResult {
  if (state.status !== 'in_progress') return { ok: true, stageClosed: false, finished: false, state }
  const next = clone(state)

  for (const seat of pendingSeats(next)) {
    const role = roleOfSeat(next, seat)!
    if (next.stage === 'bidding') {
      // Row 1: draw a TYPE (per-round scope), default bid from it; fix comes from the type later.
      const type = typeRoll(next.seed, next.round, seat) < 0.5 ? 'high' as SellerType : 'low' as SellerType
      const rng = makeRng((next.seed + next.round * 7919 + seat * 611953) | 0)
      next.bids[seat] = sellerDefaultBid(type, rng, s)
      next.roundType[seat] = type
      if (role === 'seller1') next.defaultedThisRound.s1 = true
      else next.defaultedThisRound.s2 = true
    } else if (next.stage === 'allocation') {
      // Row 3: 80 to the lower bid; price-tie → more prior fixes; full tie → 50/50 (deterministic).
      const b1 = next.bids[next.seller1Seat]
      const b2 = next.bids[next.seller2Seat]
      const { f1, f2 } = priorFixCounts(next)
      next.allocation = buyerDefaultAllocation(b1, b2, f1, f2, s)
      next.defaultedThisRound.buyer = true
    } else {
      // fixing — Row 1 seller (defaulted bid) uses its type's fix; Row 2 (real bid) derives from bid.
      const type = next.roundType[seat]
      next.fixes[seat] = type !== undefined ? sellerDefaultFix(type) : sellerFixFromBid(next.bids[seat], s)
      if (role === 'seller1') next.defaultedThisRound.s1 = true
      else next.defaultedThisRound.s2 = true
    }
    next.timeouts[seat] = [...(next.timeouts[seat] ?? []), { round: next.round, stage: next.stage }]
  }

  return closeStageIfReady(next, s)
}

/** Raw prior-fix counts per seller across closed rounds (§3.2 note — count, not rate). */
function priorFixCounts(state: CrisisState): { f1: number; f2: number } {
  let f1 = 0, f2 = 0
  for (const h of state.history) {
    if (h.crisisOccurred && h.fixed.s1) f1++
    if (h.crisisOccurred && h.fixed.s2) f2++
  }
  return { f1, f2 }
}

/** If every required seat has acted, close the current stage and advance. */
function closeStageIfReady(state: CrisisState, s: CrisisRoundSettings): ApplyResult {
  if (!allRequiredActed(state)) {
    return { ok: true, stageClosed: false, finished: false, state }
  }
  const advanced = advanceAfterStage(state, s)
  return { ok: true, stageClosed: true, finished: advanced.status === 'finished', state: advanced }
}

/** Move past the just-closed stage: bidding→allocation→[crisis draw]→fixing→resolve→next. */
function advanceAfterStage(state: CrisisState, s: CrisisRoundSettings): CrisisState {
  const next = clone(state)

  if (next.stage === 'bidding') {
    next.stage = 'allocation'
    return next
  }

  if (next.stage === 'allocation') {
    // Chance node — 50% crisis, deterministic per (seed, round) so a re-run draws identically.
    next.crisisOccurred = crisisRoll(next.seed, next.round) < s.crisisProbability
    if (next.crisisOccurred && requiredFixSeats(next).length > 0) {
      next.stage = 'fixing'
      return next
    }
    // No crisis (or nobody has units to fix) → skip fixing, resolve now.
    return resolveAndAdvance(next, s)
  }

  // fixing closed → resolve.
  return resolveAndAdvance(next, s)
}

/** Sellers with >0 units (the fix-stage required seats), computed from the allocation. */
function requiredFixSeats(state: CrisisState): number[] {
  const req: number[] = []
  if ((state.allocation?.a1 ?? 0) > 0) req.push(state.seller1Seat)
  if ((state.allocation?.a2 ?? 0) > 0) req.push(state.seller2Seat)
  return req
}

/** Resolve the round via the Slice-1 resolver, push the history record, advance or finish. */
function resolveAndAdvance(state: CrisisState, s: CrisisRoundSettings): CrisisState {
  const next = clone(state)
  const alloc = next.allocation!
  const crisis = next.crisisOccurred ?? false

  const s1Fixed = next.fixes[next.seller1Seat] ?? false
  const s2Fixed = next.fixes[next.seller2Seat] ?? false

  const result = resolveRound({
    seller1: { bid: next.bids[next.seller1Seat], fixed: s1Fixed },
    seller2: { bid: next.bids[next.seller2Seat], fixed: s2Fixed },
    allocation: alloc,
    crisisOccurred: crisis,
  }, s)

  next.history.push({
    round: next.round,
    buyerSeat: next.buyerSeat,
    seller1Seat: next.seller1Seat,
    seller2Seat: next.seller2Seat,
    bids: result.bids,
    allocation: result.allocation,
    crisisOccurred: result.crisisOccurred,
    fixed: result.fixed,
    profits: { seller1: result.seller1Profit, seller2: result.seller2Profit, buyer: result.buyerProfit },
    defaulted: { ...next.defaultedThisRound },
  })

  // Advance to the next round, or finish after the last.
  if (next.round >= next.numRounds) {
    next.status = 'finished'
    return next
  }
  next.round += 1
  next.stage = 'bidding'
  next.bids = {}
  next.roundType = {}
  next.allocation = null
  next.crisisOccurred = null
  next.fixes = {}
  next.defaultedThisRound = { s1: false, s2: false, buyer: false }
  return next
}

// ── per-seat view (bot seam #2 + Slice-3 UI read path) ──────────────────────────
// A plain object a browser-free reader (bot / robot driver) or the student screen can
// consume. Respects SEALED bidding: another seat's current-round bid is NEVER exposed
// until the bidding stage has closed. Past rounds (history) are fully public (§1.1).

export interface SeatView {
  seat: number
  role: 'buyer' | 'seller1' | 'seller2'
  status: Status
  round: number
  numRounds: number
  stage: Stage
  /** The action THIS seat owes right now, or null (already acted / nothing required). */
  owes: 'bid' | 'allocation' | 'fix' | null
  /** Current-round bids — only after the bidding stage has closed (sealed until then). */
  currentBids: { s1: number; s2: number } | null
  currentAllocation: { a1: number; a2: number } | null
  crisisOccurred: boolean | null
  /** Full shared history — identical for every seat (§1.1). */
  history: RoundRecord[]
  /** Count-based waiting info (never another seat's pending value). */
  pendingCount: number
}

export function buildSeatView(state: CrisisState, seat: number): SeatView {
  const role = roleOfSeat(state, seat)
  if (role === null) throw new Error('buildSeatView: seat not in group.')

  const biddingClosed = state.stage !== 'bidding'
  const owes: SeatView['owes'] = (() => {
    if (state.status !== 'in_progress') return null
    if (!requiredSeats(state).includes(seat)) return null
    if (seatHasActed(state, seat)) return null
    return state.stage === 'bidding' ? 'bid' : state.stage === 'allocation' ? 'allocation' : 'fix'
  })()

  return {
    seat,
    role,
    status: state.status,
    round: state.round,
    numRounds: state.numRounds,
    stage: state.stage,
    owes,
    currentBids: biddingClosed
      ? { s1: state.bids[state.seller1Seat], s2: state.bids[state.seller2Seat] }
      : null,
    currentAllocation: state.allocation,
    crisisOccurred: state.crisisOccurred,
    history: state.history,
    pendingCount: pendingSeats(state).length,
  }
}

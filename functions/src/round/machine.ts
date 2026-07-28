// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS round loop — now an ADAPTER over @mygames/stage-engine (Slice 5a).
//
// The loop, stage ordering, history accumulation, the stage-scoped reveal, the
// defaults and the clock all run in the engine. What remains here is SHAPE.
//
// ⚠ THE STORED SHAPE AND THE PUBLIC SURFACE ARE UNCHANGED, ON PURPOSE. `CrisisState`
// keeps its field names; `openRoundState`, `applyAction`, `expireStage`,
// `buildSeatView`, `roleOfSeat`, `requiredSeats`, `SeatAction`, `SeatView` and
// `RoundRecord` keep their signatures. So crisisRound.ts, both reports and every
// harness assertion exercise the engine underneath without changing a line, and
// parity is structural rather than promised.
//
// The engine's `GameState` is derived per call and converted back. Everything is
// pure, so the round trip is lossless — and confining it to this file is what keeps
// ~170 reader call sites out of the migration's blast radius.
//
// ── THE ONE SEMANTIC CHANGE ──────────────────────────────────────────────────
// `crisisOccurred` is now drawn at ROUND OPEN rather than when the allocation stage
// closes. On the wire nothing moves — the reveal rule withholds it until the fixing
// stage — but a document written by the OLD machine carries `null` mid-round, and
// reading that as "no crisis" would skip the fixing stage and pay everyone wrongly,
// silently. Hence `schema` and `assertCurrentShape`.
//
// ── DROPPED ──────────────────────────────────────────────────────────────────
// `roundType`. The HIGH default bid range [22,27] and LOW [12,17] sit strictly
// either side of `fixBidThreshold` 20, so the bid alone determines a defaulted
// seller's fix. Proved exhaustively in spec.test.ts, not argued.
// ═══════════════════════════════════════════════════════════════════════════════

import {
  openGame, submit as engineSubmit, expireStage as engineExpire,
  buildSeatView as engineSeatView, requiredSeats as engineRequiredSeats,
  pendingSeats as enginePendingSeats,
  type GameState, type Seat,
} from '@mygames/stage-engine'
import { DEFAULT_CRISIS_SETTINGS, type CrisisRoundSettings } from './settings'
import { makeRng } from './decide'
import {
  makeCrisisSpec, priorFixCounts,
  FIELD_CRISIS, FIELD_PRIOR_FIX_1, FIELD_PRIOR_FIX_2,
  STAGE_ALLOCATION, STAGE_BIDDING, STAGE_FIXING,
  type CrisisAction, type CrisisEngineRecord, type CrisisResult, type CrisisRole,
} from './spec'

export type Stage = 'bidding' | 'allocation' | 'fixing'
export type Status = 'in_progress' | 'finished'
export type SeatAction = CrisisAction

const STAGE_ORDER = [STAGE_BIDDING, STAGE_ALLOCATION, STAGE_FIXING] as Stage[]

/** One completed round, exactly what the history table renders (everyone sees it). */
export interface RoundRecord {
  round: number
  buyerSeat: number
  seller1Seat: number
  seller2Seat: number
  bids: { s1: number; s2: number }
  allocation: { a1: number; a2: number }
  crisisOccurred: boolean
  fixed: { s1: boolean; s2: boolean }
  profits: { seller1: number; seller2: number; buyer: number }
  defaulted: { s1: boolean; s2: boolean; buyer: boolean }
}

export interface TimeoutRecord { round: number; stage: Stage }

/** Written by the post-migration machine. Absent ⇒ pre-migration ⇒ refused. */
export const STATE_SCHEMA = 2

export interface CrisisState {
  /** Shape marker. See `assertCurrentShape`. */
  schema: typeof STATE_SCHEMA
  status: Status
  numRounds: number
  round: number
  stage: Stage
  seed: number

  buyerSeat: number
  seller1Seat: number
  seller2Seat: number

  /** seat → bid. A key present means that seat has acted (or defaulted). */
  bids: Record<number, number>
  allocation: { a1: number; a2: number } | null
  /**
   * This round's chance node, drawn at ROUND OPEN. Never sent to a seat before the
   * fixing stage — `buildSeatView` routes it through the engine's reveal rule.
   */
  crisisOccurred: boolean | null
  /** seat → fix decision. */
  fixes: Record<number, boolean>
  defaultedThisRound: { s1: boolean; s2: boolean; buyer: boolean }

  history: RoundRecord[]
  /** seat → its timeout log (count + round + stage; §3.3 — never a boolean). */
  timeouts: Record<number, TimeoutRecord[]>
  /** Seats that submitted at least one REAL action. A default is never one. */
  everActed: number[]
}

// ── the loud precondition ──────────────────────────────────────────────────────

/**
 * Refuse a round document written before the migration.
 *
 * NO CONVERTER, by Elena's decision: Crisis instances are single-use — finalize kills
 * an instance and every prod smoke needs a fresh session — so a pre-migration
 * document cannot reach this code. A converter would handle a case that cannot occur
 * and could not be honestly tested.
 *
 * But the precondition must not be SILENT. The old shape carries
 * `crisisOccurred: null` mid-round; read that as "no crisis" and the fixing stage is
 * skipped and every payoff for the round is wrong, with nothing to notice. So an
 * unmarked document is refused by name.
 */
export function assertCurrentShape(state: unknown): asserts state is CrisisState {
  const s = state as Record<string, unknown> | null
  if (s && s['schema'] === STATE_SCHEMA) return
  const looksLegacy = !!s && 'stage' in s && 'numRounds' in s && s['schema'] === undefined
  throw new Error(
    looksLegacy
      ? '[crisis] this round was started before the stage-engine migration ' +
        '(round state has no schema marker). Its crisis draw follows the old ' +
        'timing and cannot be read safely by the new loop — start a fresh instance ' +
        'rather than resuming this one. Crisis instances are single-use by design.'
      : `[crisis] unrecognised round-state shape (schema=${String(s?.['schema'])}, ` +
        `expected ${STATE_SCHEMA}).`,
  )
}

// ── conversion: stored shape ⇄ engine state ────────────────────────────────────

type EngineState = GameState<CrisisAction, CrisisResult>

const roleBySeatOf = (s: CrisisState): Record<Seat, string> =>
  ({ [s.buyerSeat]: 'buyer', [s.seller1Seat]: 'seller1', [s.seller2Seat]: 'seller2' })

const seatsOf = (s: CrisisState): Seat[] =>
  [s.buyerSeat, s.seller1Seat, s.seller2Seat].sort((a, b) => a - b)

/** Rebuild one engine history record from a stored one. */
function toEngineRecord(h: RoundRecord, priorF1: number, priorF2: number): CrisisEngineRecord {
  const defaulted: Seat[] = []
  if (h.defaulted.s1) defaulted.push(h.seller1Seat)
  if (h.defaulted.s2) defaulted.push(h.seller2Seat)
  if (h.defaulted.buyer) defaulted.push(h.buyerSeat)
  return {
    round: h.round,
    roundFields: {
      [FIELD_CRISIS]: h.crisisOccurred,
      [FIELD_PRIOR_FIX_1]: priorF1,
      [FIELD_PRIOR_FIX_2]: priorF2,
    },
    submissions: {
      [STAGE_BIDDING]: { [h.seller1Seat]: { kind: 'bid', bid: h.bids.s1 }, [h.seller2Seat]: { kind: 'bid', bid: h.bids.s2 } },
      [STAGE_ALLOCATION]: { [h.buyerSeat]: { kind: 'allocation', a1: h.allocation.a1, a2: h.allocation.a2 } },
      ...(h.crisisOccurred
        ? { [STAGE_FIXING]: { [h.seller1Seat]: { kind: 'fix', fixed: h.fixed.s1 }, [h.seller2Seat]: { kind: 'fix', fixed: h.fixed.s2 } } }
        : {}),
    },
    result: {
      bids: h.bids, allocation: h.allocation, crisisOccurred: h.crisisOccurred,
      fixed: h.fixed, profits: h.profits,
    },
    defaulted: defaulted.sort((a, b) => a - b),
  }
}

export function toEngineState(s: CrisisState): EngineState {
  const seats = seatsOf(s)
  const roleBySeat = roleBySeatOf(s)

  // History carries the prior-fix counts each round SAW, so they are rebuilt by
  // replaying forward rather than stamped from the final totals.
  const history: CrisisEngineRecord[] = []
  for (const h of s.history) {
    const { f1, f2 } = priorFixCounts(history)
    history.push(toEngineRecord(h, f1, f2))
  }
  const { f1, f2 } = priorFixCounts(history)

  const submissions: Record<string, Record<Seat, CrisisAction>> = {}
  const bidEntries = Object.entries(s.bids)
  if (bidEntries.length > 0) {
    submissions[STAGE_BIDDING] = Object.fromEntries(
      bidEntries.map(([seat, bid]) => [Number(seat), { kind: 'bid', bid } as CrisisAction]),
    )
  }
  if (s.allocation !== null) {
    submissions[STAGE_ALLOCATION] = {
      [s.buyerSeat]: { kind: 'allocation', a1: s.allocation.a1, a2: s.allocation.a2 },
    }
  }
  const fixEntries = Object.entries(s.fixes)
  if (fixEntries.length > 0) {
    submissions[STAGE_FIXING] = Object.fromEntries(
      fixEntries.map(([seat, fixed]) => [Number(seat), { kind: 'fix', fixed } as CrisisAction]),
    )
  }

  const defaultedThisRound: Seat[] = []
  if (s.defaultedThisRound.s1) defaultedThisRound.push(s.seller1Seat)
  if (s.defaultedThisRound.s2) defaultedThisRound.push(s.seller2Seat)
  if (s.defaultedThisRound.buyer) defaultedThisRound.push(s.buyerSeat)

  return {
    status: s.status,
    round: s.round,
    stageIndex: Math.max(0, STAGE_ORDER.indexOf(s.stage)),
    seats,
    roleBySeat,
    horizonBySeat: Object.fromEntries(seats.map((seat) => [seat, s.numRounds])),
    seed: s.seed,
    roundFields: {
      [FIELD_CRISIS]: s.crisisOccurred,
      [FIELD_PRIOR_FIX_1]: f1,
      [FIELD_PRIOR_FIX_2]: f2,
    },
    submissions,
    defaultedThisRound: defaultedThisRound.sort((a, b) => a - b),
    timeouts: Object.entries(s.timeouts).flatMap(([seat, list]) =>
      list.map((t) => ({ round: t.round, stageId: t.stage, seat: Number(seat) })),
    ),
    history,
  }
}

export function fromEngineState(e: EngineState, prev: CrisisState): CrisisState {
  const roleSeat = (role: CrisisRole): number =>
    Number(Object.keys(e.roleBySeat).find((s) => e.roleBySeat[Number(s)] === role))
  const buyerSeat = roleSeat('buyer')
  const seller1Seat = roleSeat('seller1')
  const seller2Seat = roleSeat('seller2')

  const bids: Record<number, number> = {}
  for (const [seat, a] of Object.entries(e.submissions[STAGE_BIDDING] ?? {})) {
    if (a.kind === 'bid') bids[Number(seat)] = a.bid
  }
  const allocSub = (e.submissions[STAGE_ALLOCATION] ?? {})[buyerSeat]
  const allocation = allocSub && allocSub.kind === 'allocation' ? { a1: allocSub.a1, a2: allocSub.a2 } : null
  const fixes: Record<number, boolean> = {}
  for (const [seat, a] of Object.entries(e.submissions[STAGE_FIXING] ?? {})) {
    if (a.kind === 'fix') fixes[Number(seat)] = a.fixed
  }

  const defaulted = new Set(e.defaultedThisRound)
  const timeouts: Record<number, TimeoutRecord[]> = {}
  for (const seat of e.seats) timeouts[seat] = []
  for (const t of e.timeouts) {
    (timeouts[t.seat] ??= []).push({ round: t.round, stage: t.stageId as Stage })
  }

  const history: RoundRecord[] = (e.history as CrisisEngineRecord[]).map((h) => {
    const d = new Set(h.defaulted)
    return {
      round: h.round,
      buyerSeat, seller1Seat, seller2Seat,
      bids: h.result.bids,
      allocation: h.result.allocation,
      crisisOccurred: h.result.crisisOccurred,
      fixed: h.result.fixed,
      profits: h.result.profits,
      defaulted: { s1: d.has(seller1Seat), s2: d.has(seller2Seat), buyer: d.has(buyerSeat) },
    }
  })

  return {
    schema: STATE_SCHEMA,
    status: e.status,
    numRounds: e.horizonBySeat[e.seats[0]] ?? prev.numRounds,
    round: e.round,
    stage: STAGE_ORDER[e.stageIndex] ?? prev.stage,
    seed: e.seed,
    buyerSeat, seller1Seat, seller2Seat,
    bids,
    allocation,
    crisisOccurred: (e.roundFields[FIELD_CRISIS] as boolean | null | undefined) ?? null,
    fixes,
    defaultedThisRound: {
      s1: defaulted.has(seller1Seat), s2: defaulted.has(seller2Seat), buyer: defaulted.has(buyerSeat),
    },
    history,
    timeouts,
    everActed: prev.everActed,
  }
}

// ── spec reconstruction ────────────────────────────────────────────────────────

const specFor = (s: CrisisState, settings: CrisisRoundSettings) =>
  makeCrisisSpec({ settings, numRounds: s.numRounds, seed: s.seed })

// ── opening ────────────────────────────────────────────────────────────────────

/** Fisher–Yates over the seats, seeded — the LATE role assignment, unchanged. */
function assignRoles(seats: number[], roleSeed: number): { buyerSeat: number; seller1Seat: number; seller2Seat: number } {
  const rng = makeRng(roleSeed | 0)
  const a = [...seats]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return { buyerSeat: a[0], seller1Seat: a[1], seller2Seat: a[2] }
}

export function openRoundState(
  seats: number[], seed: number, numRounds: number,
  settings: CrisisRoundSettings = DEFAULT_CRISIS_SETTINGS,
): CrisisState {
  if (seats.length !== 3) throw new Error('openRoundState: Crisis groups are exactly 3 seats.')
  const roles = assignRoles(seats, seed)
  const roleBySeat: Record<Seat, string> = {
    [roles.buyerSeat]: 'buyer', [roles.seller1Seat]: 'seller1', [roles.seller2Seat]: 'seller2',
  }
  const engine = openGame(specFor(
    { numRounds, seed } as CrisisState, settings,
  ), { seats, roleBySeat, seed })

  const shell: CrisisState = {
    schema: STATE_SCHEMA,
    status: 'in_progress', numRounds, round: 1, stage: STAGE_BIDDING as Stage, seed,
    ...roles,
    bids: {}, allocation: null, crisisOccurred: null, fixes: {},
    defaultedThisRound: { s1: false, s2: false, buyer: false },
    history: [], timeouts: Object.fromEntries(seats.map((s) => [s, []])), everActed: [],
  }
  return fromEngineState(engine, shell)
}

// ── seat/role helpers (signatures unchanged) ───────────────────────────────────

export function roleOfSeat(state: CrisisState, seat: number): CrisisRole | null {
  if (seat === state.buyerSeat) return 'buyer'
  if (seat === state.seller1Seat) return 'seller1'
  if (seat === state.seller2Seat) return 'seller2'
  return null
}

export function requiredSeats(state: CrisisState, settings: CrisisRoundSettings = DEFAULT_CRISIS_SETTINGS): number[] {
  return engineRequiredSeats(specFor(state, settings), toEngineState(state))
}

export function seatHasActed(state: CrisisState, seat: number): boolean {
  switch (state.stage) {
    case STAGE_BIDDING: return state.bids[seat] !== undefined
    case STAGE_ALLOCATION: return state.allocation !== null
    default: return state.fixes[seat] !== undefined
  }
}

export function pendingSeats(state: CrisisState, settings: CrisisRoundSettings = DEFAULT_CRISIS_SETTINGS): number[] {
  return enginePendingSeats(specFor(state, settings), toEngineState(state))
}

// ── actions ────────────────────────────────────────────────────────────────────

export interface ApplyResult {
  ok: boolean
  reason?: string
  stageClosed: boolean
  finished: boolean
  state: CrisisState
}

/**
 * Apply ONE seat's action.
 *
 * ⚠ §3.10: legality comes from the engine's injected `validate` hook, never from a
 * second copy here. The bid bounds and their exact message live in spec.ts and are
 * reached through the engine, so the two sites cannot drift.
 */
export function applyAction(
  state: CrisisState, seat: number, action: SeatAction, s: CrisisRoundSettings,
): ApplyResult {
  const r = engineSubmit(specFor(state, s), toEngineState(state), seat, action)
  if (!r.ok) return { ok: false, reason: r.reason, stageClosed: false, finished: false, state }
  const everActed = state.everActed.includes(seat) ? state.everActed : [...state.everActed, seat]
  return {
    ok: true,
    stageClosed: r.stageClosed,
    finished: r.finished,
    state: { ...fromEngineState(r.state, state), everActed },
  }
}

/**
 * The CLOCK path. `everActed` is deliberately NOT updated — a default is a record of
 * absence, not an action, so a group whose members never turned up must not have its
 * seats lock.
 */
export function expireStage(state: CrisisState, s: CrisisRoundSettings): ApplyResult {
  if (state.status !== 'in_progress') {
    return { ok: true, stageClosed: false, finished: false, state }
  }
  const r = engineExpire(specFor(state, s), toEngineState(state))
  return {
    ok: true,
    stageClosed: r.stageClosed,
    finished: r.finished,
    state: fromEngineState(r.state, state),
  }
}

// ── the per-seat view ──────────────────────────────────────────────────────────

export interface SeatView {
  seat: number
  role: CrisisRole
  status: Status
  round: number
  numRounds: number
  stage: Stage
  owes: 'bid' | 'allocation' | 'fix' | null
  currentBids: { s1: number; s2: number } | null
  currentAllocation: { a1: number; a2: number } | null
  /**
   * ⚠ ABSENT — not null — until the fixing stage. The engine's reveal rule
   * (`visibleTo: []`, `revealAt: 'fixing'`) withholds the field entirely, so the key
   * is simply not on the object.
   *
   * PARITY: every consumer compares with strict `=== true` (CrisisGame.tsx:204,
   * CrisisLivePanel.tsx:77), so an absent key behaves exactly as the `null` the
   * pre-migration code sent — while the payload now carries no trace of the draw,
   * which `null` never quite did.
   */
  crisisOccurred?: boolean
  history: RoundRecord[]
  pendingCount: number
}

const OWES_BY_STAGE: Record<Stage, 'bid' | 'allocation' | 'fix'> = {
  bidding: 'bid', allocation: 'allocation', fixing: 'fix',
}

export function buildSeatView(
  state: CrisisState, seat: number, settings: CrisisRoundSettings = DEFAULT_CRISIS_SETTINGS,
): SeatView {
  const role = roleOfSeat(state, seat)
  if (role === null) throw new Error('buildSeatView: seat not in group.')

  const spec = specFor(state, settings)
  const engine = toEngineState(state)
  const view = engineSeatView(spec, engine, seat)

  const biddingClosed = state.stage !== STAGE_BIDDING
  const out: SeatView = {
    seat,
    role,
    status: state.status,
    round: state.round,
    numRounds: state.numRounds,
    stage: state.stage,
    owes: view.owes ? OWES_BY_STAGE[state.stage] : null,
    currentBids: biddingClosed
      ? { s1: state.bids[state.seller1Seat], s2: state.bids[state.seller2Seat] }
      : null,
    currentAllocation: state.allocation,
    history: state.history,
    pendingCount: enginePendingSeats(spec, engine).length,
  }
  // Absence, not emptiness: the key exists only when the reveal rule allows it.
  if (FIELD_CRISIS in view.fields) out.crisisOccurred = view.fields[FIELD_CRISIS] === true
  return out
}

/**
 * Is the crisis draw visible to the group yet? The instructor dashboard needs the
 * same answer the students get — showing "⚠ Crisis this round" while the Buyer is
 * still allocating would leak the draw through the instructor's screen.
 */
export function crisisVisible(state: CrisisState): boolean | null {
  if (state.status !== 'in_progress') return state.crisisOccurred
  return state.stage === STAGE_FIXING ? state.crisisOccurred : null
}

export { STAGE_BIDDING, STAGE_ALLOCATION, STAGE_FIXING }

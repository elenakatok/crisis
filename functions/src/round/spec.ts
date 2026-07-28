// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS AS A STAGE-ENGINE SPEC (Slice 5a).
//
// This DECLARES the game; @mygames/stage-engine runs it. Everything game-specific —
// payoffs, draws, the default table, legality — is INJECTED here and invoked by the
// engine, never computed by it.
//
// ⚠ PARITY IS THE POINT OF THIS SLICE. Nothing a student or instructor sees changes.
// Every number, message and draw below is the one Crisis already had; where the
// engine reaches something differently the comment says so, and a test proves the
// outcome is identical.
// ═══════════════════════════════════════════════════════════════════════════════

import type { Seat, StageGameSpec, StageContext, RoundRecord } from '@mygames/stage-engine'
import type { CrisisRoundSettings } from './settings'
import { validateAllocation } from './allocation'
import { resolveRound as resolveCrisisRound } from './resolver'
import {
  buyerDefaultAllocation, makeRng, sellerDefaultBid, sellerFixFromBid, type SellerType,
} from './decide'

export type CrisisRole = 'buyer' | 'seller1' | 'seller2'
export const CRISIS_ROLES: CrisisRole[] = ['buyer', 'seller1', 'seller2']

export const STAGE_BIDDING = 'bidding'
export const STAGE_ALLOCATION = 'allocation'
export const STAGE_FIXING = 'fixing'

/** One seat's submission. Field-for-field the pre-migration SeatAction. */
export type CrisisAction =
  | { kind: 'bid'; bid: number }
  | { kind: 'allocation'; a1: number; a2: number }
  | { kind: 'fix'; fixed: boolean }

/** What the injected resolver returns; the stored history record is built from it. */
export interface CrisisResult {
  bids: { s1: number; s2: number }
  allocation: { a1: number; a2: number }
  crisisOccurred: boolean
  fixed: { s1: boolean; s2: boolean }
  profits: { seller1: number; seller2: number; buyer: number }
}

export type CrisisEngineRecord = RoundRecord<CrisisAction, CrisisResult>
export type CrisisStageContext = StageContext<CrisisAction>

// ── round-state field names ────────────────────────────────────────────────────

/** DECLARED, and therefore subject to the reveal rules. */
export const FIELD_CRISIS = 'crisis_occurred'
/**
 * UNDECLARED bookkeeping. The Buyer's timeout default routes a price tie by prior
 * fix counts, which live in HISTORY — and a stage's `defaultFor` cannot see history
 * (StageContext carries only the current round). `openRound` CAN, so the counts are
 * computed there and ride roundFields.
 *
 * Undeclared is what keeps them private: `visibleFields` only ever exposes DECLARED
 * fields, so undeclared round state is server-side by construction and can reach no
 * seat's view. The leak test asserts it rather than trusting it.
 */
export const FIELD_PRIOR_FIX_1 = 'prior_fix_1'
export const FIELD_PRIOR_FIX_2 = 'prior_fix_2'

// ── the draws, byte-identical to the pre-migration machine ─────────────────────

/** Per-round crisis roll. Same constants as the old machine.ts:88. */
export const crisisRoll = (seed: number, round: number): number =>
  makeRng((seed + round * 2654435761) | 0)()

/** Per-round, per-seat type roll for a defaulted seller. Old machine.ts:91. */
export const typeRoll = (seed: number, round: number, seat: Seat): number =>
  makeRng((seed + round * 40503 + seat * 104729) | 0)()

/** Bid-value stream for a defaulted seller. Old machine.ts:261. */
export const defaultBidRng = (seed: number, round: number, seat: Seat) =>
  makeRng((seed + round * 7919 + seat * 611953) | 0)

// ── reading the engine's per-round submissions ────────────────────────────────

export function seatOfRole(roleBySeat: Readonly<Record<Seat, string>>, role: CrisisRole): Seat {
  const found = Object.keys(roleBySeat).find((s) => roleBySeat[Number(s)] === role)
  return found === undefined ? -1 : Number(found)
}

type Subs = Readonly<Record<string, Readonly<Record<Seat, CrisisAction>>>>

export function bidsOf(submissions: Subs, roleBySeat: Readonly<Record<Seat, string>>): { s1: number; s2: number } {
  const stage = submissions[STAGE_BIDDING] ?? {}
  const read = (role: CrisisRole) => {
    const a = stage[seatOfRole(roleBySeat, role)]
    return a && a.kind === 'bid' ? a.bid : 0
  }
  return { s1: read('seller1'), s2: read('seller2') }
}

export function allocationOf(submissions: Subs, roleBySeat: Readonly<Record<Seat, string>>): { a1: number; a2: number } | null {
  const a = (submissions[STAGE_ALLOCATION] ?? {})[seatOfRole(roleBySeat, 'buyer')]
  return a && a.kind === 'allocation' ? { a1: a.a1, a2: a.a2 } : null
}

export function fixesOf(submissions: Subs, roleBySeat: Readonly<Record<Seat, string>>): { s1: boolean; s2: boolean } {
  const stage = submissions[STAGE_FIXING] ?? {}
  const read = (role: CrisisRole) => {
    const a = stage[seatOfRole(roleBySeat, role)]
    return a && a.kind === 'fix' ? a.fixed : false
  }
  return { s1: read('seller1'), s2: read('seller2') }
}

/** Raw prior-fix counts across resolved rounds. Old machine.ts:287, unchanged. */
export function priorFixCounts(history: readonly CrisisEngineRecord[]): { f1: number; f2: number } {
  let f1 = 0, f2 = 0
  for (const h of history) {
    if (h.result.crisisOccurred && h.result.fixed.s1) f1++
    if (h.result.crisisOccurred && h.result.fixed.s2) f2++
  }
  return { f1, f2 }
}

// ── the spec ───────────────────────────────────────────────────────────────────

export interface CrisisSpecOptions {
  settings: CrisisRoundSettings
  numRounds: number
  /**
   * The group's draw seed.
   *
   * ⚠ PASSED IN RATHER THAN TAKEN FROM THE ENGINE'S rng — a parity decision, not a
   * convenience. The engine derives its per-round rng as
   * `makeRng(mix(seed, round * 2654435761))`; the pre-migration machine used
   * `makeRng((seed + round * 2654435761) | 0)`. Both are seeded and reproducible,
   * but they are DIFFERENT STREAMS, and adopting the engine's would silently change
   * which rounds carry a crisis for any given seed — taking every seed-pinned
   * harness assertion with it.
   *
   * The spec is built per group, where the seed is already known, so closing over it
   * reproduces every draw exactly and needs no shared-package change.
   */
  seed: number
}

export function makeCrisisSpec(
  { settings: s, numRounds, seed }: CrisisSpecOptions,
): StageGameSpec<CrisisAction, CrisisResult> {
  return {
    roles: CRISIS_ROLES,

    stages: [
      {
        // SEALED: both sellers act in ONE stage, so neither can see the other's bid.
        // Simultaneity by construction — what `currentBids: null` used to express.
        id: STAGE_BIDDING,
        actingRoles: ['seller1', 'seller2'],
        validate: (_seat, action) => {
          if (action.kind !== 'bid') return 'Only Sellers bid.'
          // §3.10: the CALLABLE invokes this rather than keeping its own copy, so the
          // two sites cannot drift. The message is the pre-migration one verbatim.
          if (!Number.isInteger(action.bid) || action.bid < s.sellerCost || action.bid > s.buyerValue) {
            return `Enter a whole number between ${s.sellerCost} and ${s.buyerValue} ` +
              `(your cost is ${s.sellerCost}, the buyer values each unit at ${s.buyerValue}).`
          }
          return null
        },
        defaultFor: (seat, ctx) => {
          // Row 1: draw a TYPE at per-round scope, default the bid from it.
          const type: SellerType = typeRoll(seed, ctx.round, seat) < 0.5 ? 'high' : 'low'
          return { kind: 'bid', bid: sellerDefaultBid(type, defaultBidRng(seed, ctx.round, seat), s) }
        },
      },
      {
        id: STAGE_ALLOCATION,
        actingRoles: ['buyer'],
        observes: [STAGE_BIDDING],
        validate: (_seat, action) => {
          if (action.kind !== 'allocation') return 'Only the Buyer allocates.'
          const check = validateAllocation(action.a1, action.a2, s)
          return check.ok ? null : check.reason
        },
        defaultFor: (_seat, ctx) => {
          // Row 3: 80 to the lower bid; price tie → more prior fixes; full tie → 50/50.
          const { s1, s2 } = bidsOf(ctx.submissions, ctx.roleBySeat)
          const f1 = Number(ctx.roundFields[FIELD_PRIOR_FIX_1] ?? 0)
          const f2 = Number(ctx.roundFields[FIELD_PRIOR_FIX_2] ?? 0)
          const { a1, a2 } = buyerDefaultAllocation(s1, s2, f1, f2, s)
          return { kind: 'allocation', a1, a2 }
        },
      },
      {
        id: STAGE_FIXING,
        actingRoles: ['seller1', 'seller2'],
        // The fix screen shows both bids AND the allocation, so it observes both.
        observes: [STAGE_BIDDING, STAGE_ALLOCATION],
        /**
         * Entered only when a crisis occurred AND the seller holds units. Narrowing
         * to [] when there was no crisis is what makes the engine SKIP the stage —
         * the same "no crisis → resolve now" jump advanceAfterStage used to make.
         */
        requiredSeats: (ctx) => {
          if (ctx.roundFields[FIELD_CRISIS] !== true) return []
          const alloc = allocationOf(ctx.submissions, ctx.roleBySeat)
          const out: Seat[] = []
          if ((alloc?.a1 ?? 0) > 0) out.push(seatOfRole(ctx.roleBySeat, 'seller1'))
          if ((alloc?.a2 ?? 0) > 0) out.push(seatOfRole(ctx.roleBySeat, 'seller2'))
          return out
        },
        validate: (_seat, action) => (action.kind === 'fix' ? null : 'Only Sellers fix.'),
        defaultFor: (seat, ctx) => {
          /**
           * Row 2, and now row 1 as well.
           *
           * The pre-migration machine kept a per-round `roundType` for a seller whose
           * BID had defaulted, and used `sellerDefaultFix(type)`; a seller who bid for
           * real used `sellerFixFromBid(bid)`. Both collapse to the bid: the HIGH
           * default range is [22,27] and LOW is [12,17] while `fixBidThreshold` is 20,
           * so every HIGH default bid is ≥ 20 and every LOW one is < 20 — and
           * `sellerFixFromBid` returns exactly what `sellerDefaultFix(type)` returned.
           *
           * `roundType` was therefore redundant state, and dropping it removes a field
           * the engine has no place for. NOT asserted by argument: spec.test.ts
           * enumerates every integer in both ranges and checks the two agree.
           */
          const role = ctx.roleBySeat[seat] as CrisisRole
          const { s1, s2 } = bidsOf(ctx.submissions, ctx.roleBySeat)
          return { kind: 'fix', fixed: sellerFixFromBid(role === 'seller1' ? s1 : s2, s) }
        },
      },
    ],

    fields: [
      /**
       * THE MID-ROUND REVEAL (Slice 1.5). Drawn at round open, so it exists on the
       * server before the Buyer allocates — and must reach NOBODY until the fixing
       * stage, where the sellers act on it. `revealAt` is INCLUSIVE of the named
       * stage and permanent for the rest of the round (§6.6.2).
       *
       * Pre-migration the same wire was achieved by drawing LATE, after allocation
       * closed. The observable result is identical; the leak test asserts it on the
       * payload rather than trusting the argument.
       */
      { name: FIELD_CRISIS, visibleTo: [], revealAt: STAGE_FIXING },
    ],

    roundCount: { mode: 'fixed', n: numRounds, display: 'shown', drawScope: 'group' },
    endCondition: { kind: 'fixedRounds' },
    groupSize: { n: 3 },
    hasClock: true,

    openRound: (ctx) => {
      const { f1, f2 } = priorFixCounts(ctx.history as readonly CrisisEngineRecord[])
      return {
        // The chance node. Same roll, same constants, same per-(seed, round) stream
        // as before — only the MOMENT moved, from allocation-close to round-open,
        // which the reveal rule then hides until the fixing stage.
        [FIELD_CRISIS]: crisisRoll(seed, ctx.round) < s.crisisProbability,
        [FIELD_PRIOR_FIX_1]: f1,
        [FIELD_PRIOR_FIX_2]: f2,
      }
    },

    resolveRound: (input) => {
      const bids = bidsOf(input.submissions, input.roleBySeat)
      const alloc = allocationOf(input.submissions, input.roleBySeat) ?? { a1: 0, a2: 0 }
      const fixes = fixesOf(input.submissions, input.roleBySeat)
      const crisisOccurred = input.roundFields[FIELD_CRISIS] === true

      // INVOKED, never computed here — the Slice-1 resolver is untouched.
      const r = resolveCrisisRound(
        {
          seller1: { bid: bids.s1, fixed: fixes.s1 },
          seller2: { bid: bids.s2, fixed: fixes.s2 },
          allocation: alloc,
          crisisOccurred,
        },
        s,
      )
      return {
        bids: r.bids,
        allocation: r.allocation,
        crisisOccurred: r.crisisOccurred,
        fixed: r.fixed,
        profits: { seller1: r.seller1Profit, seller2: r.seller2Profit, buyer: r.buyerProfit },
      }
    },
  }
}

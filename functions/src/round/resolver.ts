// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS round resolver (spec §1.4) — a PURE function: decisions in, payoffs out.
//
// The crisis DRAW is NOT the resolver's job — whether a crisis occurred is an INPUT
// (the Slice-2 round loop draws it). The resolver only computes payoffs from the three
// players' decisions plus that boolean.
//
// Seller i:
//   no crisis, or crisis not fixed by i:  (Bi − cost) · Ai
//   crisis occurred and i fixed it:       (Bi − cost − repair) · Ai
// Buyer:
//   (value − B1)·A1 + (value − B2)·A2
//     − buyerRepair·A1   if a crisis occurred and Seller 1 did not fix
//     − buyerRepair·A2   if a crisis occurred and Seller 2 did not fix
//
// A Seller allocated 0 units contributes 0 to every term (and has no fix decision),
// so no special-casing is needed — the arithmetic handles it.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CrisisRoundSettings } from './settings'
import { validateAllocation } from './allocation'

/** One Seller's decisions for a round. `fixed` is only meaningful if a crisis occurred. */
export interface SellerRoundDecision {
  /** Per-unit price, an integer. */
  bid: number
  /** Did this Seller fix the crisis on their own allocated units? (Ignored if no crisis.) */
  fixed: boolean
}

export interface RoundInput {
  seller1: SellerRoundDecision
  seller2: SellerRoundDecision
  /** The Buyer's split. Must be legal under §1.3 (validated here). */
  allocation: { a1: number; a2: number }
  /** Did a crisis occur this round? (Drawn by the round loop, not here.) */
  crisisOccurred: boolean
}

export interface RoundResult {
  seller1Profit: number
  seller2Profit: number
  buyerProfit: number
  // ── everything the history table (spec §1.2 step 5) needs to render the round ──
  bids: { s1: number; s2: number }
  allocation: { a1: number; a2: number }
  crisisOccurred: boolean
  /** Fix decisions AS APPLIED — false for a Seller with 0 units or when no crisis occurred. */
  fixed: { s1: boolean; s2: boolean }
}

/** Seller i's profit for the round (§1.4). */
function sellerProfit(
  bid: number, alloc: number, crisisOccurred: boolean, fixed: boolean, s: CrisisRoundSettings,
): number {
  if (alloc === 0) return 0
  const margin = crisisOccurred && fixed
    ? bid - s.sellerCost - s.sellerRepairCost
    : bid - s.sellerCost
  return margin * alloc
}

/**
 * Resolve one round into payoffs. Pure. Throws on an illegal allocation or non-integer
 * bid (the round loop validates first; this guard stops a bad input silently producing a
 * garbage grade — grading is participation-only, but the DISPLAYED profits must be right).
 */
export function resolveRound(input: RoundInput, s: CrisisRoundSettings): RoundResult {
  const { seller1, seller2, allocation, crisisOccurred } = input
  const { a1, a2 } = allocation

  const check = validateAllocation(a1, a2, s)
  if (!check.ok) throw new Error(`resolveRound: illegal allocation (${a1}, ${a2}) — ${check.reason}`)
  if (!Number.isInteger(seller1.bid) || !Number.isInteger(seller2.bid)) {
    throw new Error('resolveRound: seller bids must be integers.')
  }

  // A fix decision only "applies" when a crisis occurred AND the Seller has units.
  const s1Fixed = crisisOccurred && a1 > 0 && seller1.fixed
  const s2Fixed = crisisOccurred && a2 > 0 && seller2.fixed

  const seller1Profit = sellerProfit(seller1.bid, a1, crisisOccurred, seller1.fixed, s)
  const seller2Profit = sellerProfit(seller2.bid, a2, crisisOccurred, seller2.fixed, s)

  let buyerProfit = (s.buyerValue - seller1.bid) * a1 + (s.buyerValue - seller2.bid) * a2
  if (crisisOccurred && !seller1.fixed) buyerProfit -= s.buyerRepairCost * a1
  if (crisisOccurred && !seller2.fixed) buyerProfit -= s.buyerRepairCost * a2

  return {
    seller1Profit,
    seller2Profit,
    buyerProfit,
    bids: { s1: seller1.bid, s2: seller2.bid },
    allocation: { a1, a2 },
    crisisOccurred,
    fixed: { s1: s1Fixed, s2: s2Fixed },
  }
}

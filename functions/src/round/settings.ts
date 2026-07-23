// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS round settings (Slice 1) — the game constants as DATA, not magic numbers.
//
// Same discipline as eBay's auction resolver: every number the resolver and the
// default table use is a named setting, passed in, so a session can be re-parameterised
// without touching the formulas. Nothing here imports firebase or anything impure — this
// module (and decide.ts / resolver.ts / allocation.ts that consume it) is a PURE library
// that the server round loop (Slice 2), the seat-filler bot (Slice 5), and the browser
// robot driver (Slice 5) all import from ONE place. See §5.5 finding: no strategy mirror.
// ═══════════════════════════════════════════════════════════════════════════════

/** Inclusive integer range [min, max]. */
export interface IntRange {
  min: number
  max: number
}

export interface CrisisRoundSettings {
  // ── §1.1 economics ──────────────────────────────────────────────────────────
  /** Buyer's value per unit (30). */
  buyerValue: number
  /** Seller's cost per unit (10). */
  sellerCost: number
  /** A Seller's cost to fix a crisis, per allocated unit (5). */
  sellerRepairCost: number
  /** The Buyer's cost when a crisis on a Seller's units is NOT fixed, per unit (15). */
  buyerRepairCost: number
  /** Units in the contract the Buyer splits (100). */
  contractUnits: number
  /** Minimum non-zero allocation to a Seller (§1.3): each Ai is 0 or ≥ this (20). */
  minAllocation: number
  /**
   * Per-round crisis probability (0.5). The resolver does NOT use this — the crisis
   * outcome is an INPUT, not drawn here. It lives in settings for the Slice-2 round
   * loop (which draws) and for completeness.
   */
  crisisProbability: number

  // ── §3.2 default table parameters (the "competent default" = the bot strategy) ──
  /** HIGH-type default bid range (integers 22..27 inclusive). */
  highBid: IntRange
  /** LOW-type default bid range (integers 12..17 inclusive). */
  lowBid: IntRange
  /**
   * Seller "bid submitted, no fix decision" default (§3.2 row 2): fix iff bid ≥ this (20).
   * Derived from the ACTUAL bid — no fresh type draw.
   */
  fixBidThreshold: number
  /**
   * Buyer "no allocation" default (§3.2 row 3): units to the LOWER bid (80). The higher
   * bid gets contractUnits − this (20). A price tie routes by fix history; a full tie
   * falls to an even split (contractUnits / 2 each), which is legal under §1.3.
   */
  buyerDefaultMajority: number
}

export const DEFAULT_CRISIS_SETTINGS: CrisisRoundSettings = {
  buyerValue:        30,
  sellerCost:        10,
  sellerRepairCost:  5,
  buyerRepairCost:   15,
  contractUnits:     100,
  minAllocation:     20,
  crisisProbability: 0.5,

  highBid:           { min: 22, max: 27 },
  lowBid:            { min: 12, max: 17 },
  fixBidThreshold:   20,
  buyerDefaultMajority: 80,
}

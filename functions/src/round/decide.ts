// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS default table / bot STRATEGY (spec §3.2 + §5.2) — PURE, RNG-injectable.
//
// §5.2: "the default table IS the strategy." The same logic serves three consumers,
// which is why it lives here (inside functions/, importable by all three — see the §5.5
// finding: no mirror):
//   (a) Slice-2 round loop — invokes a default when a present-but-late player times out.
//   (b) Slice-5 seat-filler bot — a seat with no human, played every round.
//   (c) Slice-5 browser robot driver — watches games play themselves.
//
// ── TYPE-DRAW SCOPE is the caller's job, NOT baked in here (spec §3.2 / §5.2). ──
// A Seller default derives from a TYPE (high/low). WHEN that type is drawn differs:
//   • Timeout fill (present-but-late human): draw a fresh type PER ROUND.
//   • Bot (seat with no human):              draw ONCE at group formation, hold 10 rounds.
// So `decide()` for a Seller takes the type as an INPUT; drawing it is a separate call
// (`drawSellerType`). The caller draws at whatever scope it needs and passes the result.
//
// Randomness is injected as an `RNG` (a () => number in [0,1)), so tests are deterministic
// and a session can be replayed. `makeRng(seed)` is a small seeded generator for that.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CrisisRoundSettings } from './settings'

/** A uniform random source in [0, 1). Injected so callers control determinism/replay. */
export type RNG = () => number

/** A Seller's default "personality": a HIGH bidder who fixes, or a LOW bidder who doesn't. */
export type SellerType = 'high' | 'low'

// ── Seeded RNG (mulberry32) — deterministic, for tests and session replay ──────────
/** Build a deterministic RNG from an integer seed. Same seed → same stream. */
export function makeRng(seed: number): RNG {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform integer in [min, max] inclusive. */
function uniformInt(rng: RNG, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

// ── Seller defaults (§3.2 rows 1 & 2) ──────────────────────────────────────────

/** Draw a Seller type 50/50. The caller decides the SCOPE (per-round vs once-at-formation). */
export function drawSellerType(rng: RNG): SellerType {
  return rng() < 0.5 ? 'high' : 'low'
}

/** HIGH → integer bid uniform on [22,27]; LOW → integer bid uniform on [12,17]. */
export function sellerDefaultBid(type: SellerType, rng: RNG, s: CrisisRoundSettings): number {
  const range = type === 'high' ? s.highBid : s.lowBid
  return uniformInt(rng, range.min, range.max)
}

/** HIGH fixes, LOW does not. Coherent with the type — not an independent draw. */
export function sellerDefaultFix(type: SellerType): boolean {
  return type === 'high'
}

/**
 * Row 2: a Seller who submitted a bid but no fix decision. Derive fix from the ACTUAL bid
 * (bid ≥ fixBidThreshold → fix), with NO fresh type draw. Deterministic; no RNG.
 */
export function sellerFixFromBid(bid: number, s: CrisisRoundSettings): boolean {
  return bid >= s.fixBidThreshold
}

// ── Buyer default (§3.2 row 3) ──────────────────────────────────────────────────

/**
 * Row 3: the Buyer submitted no allocation. Give the majority (80) to the LOWER bid, the
 * minority (20) to the higher. On a PRICE TIE, the majority goes to the Seller who has
 * fixed MORE crises in prior rounds (raw count — §3.2 note). On a FULL tie (equal bids AND
 * equal fix counts, e.g. round 1 where no history exists) fall to an even split
 * (contractUnits / 2 each), which is legal under §1.3 — no special case, no coin flip.
 * Deterministic; no RNG.
 */
export function buyerDefaultAllocation(
  bid1: number, bid2: number, fixCount1: number, fixCount2: number, s: CrisisRoundSettings,
): { a1: number; a2: number } {
  const major = s.buyerDefaultMajority
  const minor = s.contractUnits - major

  if (bid1 < bid2) return { a1: major, a2: minor }
  if (bid2 < bid1) return { a1: minor, a2: major }

  // Price tie → the more reliable Seller (more prior fixes) gets the majority.
  if (fixCount1 > fixCount2) return { a1: major, a2: minor }
  if (fixCount2 > fixCount1) return { a1: minor, a2: major }

  // Still tied (round 1 falls straight through here) → even split.
  const half = s.contractUnits / 2
  return { a1: half, a2: half }
}

// ── decide() dispatcher over the whole §3.2 table ───────────────────────────────
// One entry point the runners share. Each situation maps to exactly one default action;
// the payoff resolver never carries any of this branching.

export type DefaultSituation =
  /** A Seller submitted nothing. `type` is supplied by the caller at its chosen scope. */
  | { kind: 'seller_no_bid'; type: SellerType }
  /** A Seller bid but gave no fix decision. */
  | { kind: 'seller_no_fix'; bid: number }
  /** The Buyer gave no allocation. `fixCount{1,2}` are raw prior-fix counts. */
  | { kind: 'buyer_no_allocation'; bid1: number; bid2: number; fixCount1: number; fixCount2: number }

export type DefaultDecision =
  | { kind: 'seller_bid'; bid: number; fixed: boolean }
  | { kind: 'seller_fix'; fixed: boolean }
  | { kind: 'buyer_allocation'; a1: number; a2: number }

/** Resolve a timeout/absence into the competent default action (§3.2). Pure. */
export function decide(sit: DefaultSituation, rng: RNG, s: CrisisRoundSettings): DefaultDecision {
  switch (sit.kind) {
    case 'seller_no_bid':
      return {
        kind: 'seller_bid',
        bid: sellerDefaultBid(sit.type, rng, s),
        fixed: sellerDefaultFix(sit.type),
      }
    case 'seller_no_fix':
      return { kind: 'seller_fix', fixed: sellerFixFromBid(sit.bid, s) }
    case 'buyer_no_allocation': {
      const { a1, a2 } = buyerDefaultAllocation(sit.bid1, sit.bid2, sit.fixCount1, sit.fixCount2, s)
      return { kind: 'buyer_allocation', a1, a2 }
    }
  }
}

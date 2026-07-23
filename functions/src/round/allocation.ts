// ═══════════════════════════════════════════════════════════════════════════════
// Allocation validator (spec §1.3) — a standalone pure function.
//
// The Buyer splits `contractUnits` (100) between the two Sellers. A legal allocation
// (A1, A2) satisfies:
//   • A1 + A2 === contractUnits exactly
//   • each Ai is an integer, either 0 or ≥ minAllocation (20)
// So the legal set is: (0,100), (100,0), and any pair both in [20,80] summing to 100
// — including (50,50).
//
// This is exported INDEPENDENTLY of the resolver because the student UI (Slice 3) reuses
// it to validate the Buyer's allocation before submit.
// ═══════════════════════════════════════════════════════════════════════════════

import type { CrisisRoundSettings } from './settings'

export type AllocationCheck =
  | { ok: true }
  | { ok: false; reason: string }

/** Is `n` a finite, non-negative integer? */
function isNonNegInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0
}

/**
 * Validate a Buyer allocation (a1, a2) against §1.3. Pure; no throw.
 * Returns { ok:true } or { ok:false, reason } with a student-facing reason.
 */
export function validateAllocation(a1: number, a2: number, s: CrisisRoundSettings): AllocationCheck {
  if (!isNonNegInt(a1) || !isNonNegInt(a2)) {
    return { ok: false, reason: 'Each allocation must be a whole, non-negative number of units.' }
  }
  if (a1 + a2 !== s.contractUnits) {
    return { ok: false, reason: `The two allocations must add up to exactly ${s.contractUnits} units.` }
  }
  for (const a of [a1, a2]) {
    if (a !== 0 && a < s.minAllocation) {
      return { ok: false, reason: `Each Seller must get either 0 units or at least ${s.minAllocation}.` }
    }
  }
  return { ok: true }
}

/** Convenience boolean form. */
export function isLegalAllocation(a1: number, a2: number, s: CrisisRoundSettings): boolean {
  return validateAllocation(a1, a2, s).ok
}

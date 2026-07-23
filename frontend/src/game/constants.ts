// Display constants (common knowledge, §1.1) — MIRROR of functions/src/round/settings.ts
// DEFAULT_CRISIS_SETTINGS. These drive labels + the client-side allocation check only; the
// server settings remain authoritative for scoring/resolution.
export const CRISIS = {
  buyerValue: 30,
  sellerCost: 10,
  sellerRepair: 5,
  buyerRepair: 15,
  contractUnits: 100,
  minAllocation: 20,
  crisisPct: 50,
} as const

export type AllocCheck = { ok: true } | { ok: false; reason: string }

/** Client-side mirror of the Slice-1 validator (§1.3). The server re-validates authoritatively. */
export function checkAllocation(a1: number, a2: number): AllocCheck {
  if (![a1, a2].every((n) => Number.isInteger(n) && n >= 0)) {
    return { ok: false, reason: 'Each allocation must be a whole, non-negative number of units.' }
  }
  if (a1 + a2 !== CRISIS.contractUnits) {
    return { ok: false, reason: `The two allocations must add up to exactly ${CRISIS.contractUnits} units (right now they add to ${a1 + a2}).` }
  }
  for (const a of [a1, a2]) {
    if (a !== 0 && a < CRISIS.minAllocation) {
      return { ok: false, reason: `Each Seller must get either 0 units or at least ${CRISIS.minAllocation}.` }
    }
  }
  return { ok: true }
}

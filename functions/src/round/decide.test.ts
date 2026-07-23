import { describe, it, expect } from 'vitest'
import {
  decide, drawSellerType, sellerDefaultBid, sellerDefaultFix, sellerFixFromBid,
  buyerDefaultAllocation, makeRng, type RNG,
} from './decide'
import { DEFAULT_CRISIS_SETTINGS as S } from './settings'
import { isLegalAllocation } from './allocation'

/** A scripted RNG that yields the given values in order (then repeats the last). */
function scriptedRng(values: number[]): RNG {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

describe('§3.2 row 1 — Seller, no bid: type → bid range + fix', () => {
  it('HIGH → integer bid in [22,27] AND fixes', () => {
    for (let seed = 0; seed < 200; seed++) {
      const bid = sellerDefaultBid('high', makeRng(seed), S)
      expect(Number.isInteger(bid)).toBe(true)
      expect(bid).toBeGreaterThanOrEqual(22)
      expect(bid).toBeLessThanOrEqual(27)
    }
    expect(sellerDefaultFix('high')).toBe(true)
  })

  it('LOW → integer bid in [12,17] AND does not fix', () => {
    for (let seed = 0; seed < 200; seed++) {
      const bid = sellerDefaultBid('low', makeRng(seed), S)
      expect(Number.isInteger(bid)).toBe(true)
      expect(bid).toBeGreaterThanOrEqual(12)
      expect(bid).toBeLessThanOrEqual(17)
    }
    expect(sellerDefaultFix('low')).toBe(false)
  })

  it('bid draw covers the whole range (both endpoints reachable)', () => {
    const seen = new Set<number>()
    for (let seed = 0; seed < 500; seed++) seen.add(sellerDefaultBid('high', makeRng(seed), S))
    for (let v = 22; v <= 27; v++) expect(seen.has(v)).toBe(true)
  })

  it('decide() dispatches seller_no_bid to a coherent {bid, fixed}', () => {
    // rng returns 0 → low end of range for the draw call
    expect(decide({ kind: 'seller_no_bid', type: 'high' }, scriptedRng([0]), S))
      .toEqual({ kind: 'seller_bid', bid: 22, fixed: true })
    expect(decide({ kind: 'seller_no_bid', type: 'low' }, scriptedRng([0]), S))
      .toEqual({ kind: 'seller_bid', bid: 12, fixed: false })
  })
})

describe('§3.2 row 2 — Seller, bid but no fix: derive from the actual bid, NO type draw', () => {
  it('bid ≥ 20 → fix', () => {
    expect(sellerFixFromBid(20, S)).toBe(true)
    expect(sellerFixFromBid(27, S)).toBe(true)
  })
  it('bid < 20 → do not fix', () => {
    expect(sellerFixFromBid(19, S)).toBe(false)
    expect(sellerFixFromBid(12, S)).toBe(false)
  })
  it('decide() dispatches seller_no_fix without consuming RNG', () => {
    const rng = () => { throw new Error('RNG must NOT be used for a bid-derived fix') }
    expect(decide({ kind: 'seller_no_fix', bid: 25 }, rng, S)).toEqual({ kind: 'seller_fix', fixed: true })
    expect(decide({ kind: 'seller_no_fix', bid: 14 }, rng, S)).toEqual({ kind: 'seller_fix', fixed: false })
  })
})

describe('§3.2 row 3 — Buyer, no allocation', () => {
  it('80 to the LOWER bid, 20 to the higher', () => {
    expect(buyerDefaultAllocation(14, 25, 0, 0, S)).toEqual({ a1: 80, a2: 20 })
    expect(buyerDefaultAllocation(25, 14, 0, 0, S)).toEqual({ a1: 20, a2: 80 })
  })

  it('price tie with ASYMMETRIC fix history → 80 to the more reliable seller', () => {
    expect(buyerDefaultAllocation(20, 20, 3, 1, S)).toEqual({ a1: 80, a2: 20 })
    expect(buyerDefaultAllocation(20, 20, 1, 4, S)).toEqual({ a1: 20, a2: 80 })
  })

  it('price tie with IDENTICAL fix history → even 50/50 split', () => {
    expect(buyerDefaultAllocation(20, 20, 2, 2, S)).toEqual({ a1: 50, a2: 50 })
  })

  it('ROUND 1 price tie falls straight through to 50/50 (no history exists yet)', () => {
    // Intended, not an oversight: fixCount1 == fixCount2 == 0 in round 1.
    expect(buyerDefaultAllocation(20, 20, 0, 0, S)).toEqual({ a1: 50, a2: 50 })
  })

  it('every buyer-default output is a LEGAL allocation', () => {
    const cases: Array<[number, number, number, number]> = [
      [14, 25, 0, 0], [25, 14, 0, 0], [20, 20, 3, 1], [20, 20, 0, 0], [20, 20, 5, 5],
    ]
    for (const [b1, b2, f1, f2] of cases) {
      const { a1, a2 } = buyerDefaultAllocation(b1, b2, f1, f2, S)
      expect(isLegalAllocation(a1, a2, S)).toBe(true)
    }
  })

  it('decide() dispatches buyer_no_allocation deterministically (no RNG)', () => {
    const rng = () => { throw new Error('RNG must NOT be used for the buyer default') }
    expect(decide({ kind: 'buyer_no_allocation', bid1: 14, bid2: 25, fixCount1: 0, fixCount2: 0 }, rng, S))
      .toEqual({ kind: 'buyer_allocation', a1: 80, a2: 20 })
  })
})

describe('RNG — seeded reproducibility & replay', () => {
  it('makeRng(seed) is deterministic: same seed → identical stream', () => {
    const a = makeRng(12345), b = makeRng(12345)
    const sa = Array.from({ length: 10 }, () => a())
    const sb = Array.from({ length: 10 }, () => b())
    expect(sa).toEqual(sb)
  })

  it('different seeds diverge', () => {
    const a = Array.from({ length: 10 }, ((r: RNG) => () => r())(makeRng(1)))
    const b = Array.from({ length: 10 }, ((r: RNG) => () => r())(makeRng(2)))
    expect(a).not.toEqual(b)
  })

  it('type + bid draws replay identically under the same seed', () => {
    const draw = (seed: number) => {
      const rng = makeRng(seed)
      const type = drawSellerType(rng)
      return { type, bid: sellerDefaultBid(type, rng, S) }
    }
    expect(draw(777)).toEqual(draw(777))
  })

  it('drawSellerType yields both types across seeds', () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < 50; seed++) seen.add(drawSellerType(makeRng(seed)))
    expect(seen.has('high')).toBe(true)
    expect(seen.has('low')).toBe(true)
  })
})

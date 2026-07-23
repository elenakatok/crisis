import { describe, it, expect } from 'vitest'
import { resolveRound, type RoundInput } from './resolver'
import { DEFAULT_CRISIS_SETTINGS as S } from './settings'

const base = (o: Partial<RoundInput> = {}): RoundInput => ({
  seller1: { bid: 20, fixed: false },
  seller2: { bid: 20, fixed: false },
  allocation: { a1: 50, a2: 50 },
  crisisOccurred: false,
  ...o,
})

describe('resolveRound — payoffs (§1.4)', () => {
  it('matches the deck worked example EXACTLY', () => {
    // B1=14, B2=25, A1=80, A2=20, crisis, S1 did NOT fix, S2 fixed.
    const r = resolveRound({
      seller1: { bid: 14, fixed: false },
      seller2: { bid: 25, fixed: true },
      allocation: { a1: 80, a2: 20 },
      crisisOccurred: true,
    }, S)
    expect(r.seller1Profit).toBe(320) // (14-10)*80
    expect(r.seller2Profit).toBe(200) // (25-10-5)*20
    expect(r.buyerProfit).toBe(180)   // 30*100 - 80*14 - 20*25 - 80*15
  })

  it('no crisis → base margins, no repair terms anywhere', () => {
    const r = resolveRound(base({
      seller1: { bid: 14, fixed: false },
      seller2: { bid: 25, fixed: false },
      allocation: { a1: 80, a2: 20 },
      crisisOccurred: false,
    }), S)
    expect(r.seller1Profit).toBe(320)                 // (14-10)*80
    expect(r.seller2Profit).toBe(300)                 // (25-10)*20
    // buyer: (30-14)*80 + (30-25)*20 = 1280 + 100 = 1380, no repair
    expect(r.buyerProfit).toBe(1380)
    expect(r.fixed).toEqual({ s1: false, s2: false }) // fix never "applies" without a crisis
  })

  it('crisis, BOTH sellers fix', () => {
    const r = resolveRound(base({
      seller1: { bid: 20, fixed: true },
      seller2: { bid: 20, fixed: true },
      allocation: { a1: 50, a2: 50 },
      crisisOccurred: true,
    }), S)
    expect(r.seller1Profit).toBe(250) // (20-10-5)*50
    expect(r.seller2Profit).toBe(250)
    // buyer: (30-20)*50*2 = 1000, no repair (both fixed)
    expect(r.buyerProfit).toBe(1000)
    expect(r.fixed).toEqual({ s1: true, s2: true })
  })

  it('crisis, NEITHER seller fixes → buyer eats repair on all units', () => {
    const r = resolveRound(base({
      seller1: { bid: 20, fixed: false },
      seller2: { bid: 20, fixed: false },
      allocation: { a1: 50, a2: 50 },
      crisisOccurred: true,
    }), S)
    expect(r.seller1Profit).toBe(500) // (20-10)*50, no repair paid by seller
    expect(r.seller2Profit).toBe(500)
    // buyer: 1000 - 15*50 - 15*50 = 1000 - 1500 = -500
    expect(r.buyerProfit).toBe(-500)
    expect(r.fixed).toEqual({ s1: false, s2: false })
  })

  it('crisis, exactly ONE seller fixes', () => {
    const r = resolveRound(base({
      seller1: { bid: 20, fixed: true },
      seller2: { bid: 20, fixed: false },
      allocation: { a1: 50, a2: 50 },
      crisisOccurred: true,
    }), S)
    expect(r.seller1Profit).toBe(250) // (20-10-5)*50
    expect(r.seller2Profit).toBe(500) // (20-10)*50
    // buyer: 1000 - 0 (s1 fixed) - 15*50 (s2 didn't) = 1000 - 750 = 250
    expect(r.buyerProfit).toBe(250)
    expect(r.fixed).toEqual({ s1: true, s2: false })
  })
})

describe('resolveRound — a Seller allocated 0 units', () => {
  it('0-unit seller earns 0 and their fix flag never applies, even under crisis', () => {
    const r = resolveRound({
      seller1: { bid: 12, fixed: false },   // gets all 100
      seller2: { bid: 27, fixed: true },    // gets 0 — "fixed" is irrelevant
      allocation: { a1: 100, a2: 0 },
      crisisOccurred: true,
    }, S)
    expect(r.seller1Profit).toBe(200)   // (12-10)*100, s1 didn't fix
    expect(r.seller2Profit).toBe(0)     // 0 units
    // buyer: (30-12)*100 + (30-27)*0 - 15*100 (s1 unfixed) - 15*0 (s2 has 0) = 1800 - 1500 = 300
    expect(r.buyerProfit).toBe(300)
    expect(r.fixed).toEqual({ s1: false, s2: false }) // s2 fixed:true collapses to false (0 units)
  })
})

describe('resolveRound — allocation boundaries all resolve', () => {
  const boundaries: Array<[number, number]> = [[0, 100], [100, 0], [20, 80], [80, 20], [50, 50]]
  for (const [a1, a2] of boundaries) {
    it(`(${a1}, ${a2}) is accepted and produces integer payoffs`, () => {
      const r = resolveRound(base({ allocation: { a1, a2 }, seller1: { bid: 15, fixed: false }, seller2: { bid: 15, fixed: false } }), S)
      expect(Number.isInteger(r.seller1Profit)).toBe(true)
      expect(Number.isInteger(r.seller2Profit)).toBe(true)
      expect(Number.isInteger(r.buyerProfit)).toBe(true)
      expect(r.allocation).toEqual({ a1, a2 })
    })
  }
})

describe('resolveRound — guards', () => {
  it('throws on an illegal allocation (sum ≠ 100)', () => {
    expect(() => resolveRound(base({ allocation: { a1: 60, a2: 30 } }), S)).toThrow(/illegal allocation/)
  })
  it('throws on an illegal allocation (nonzero < 20)', () => {
    expect(() => resolveRound(base({ allocation: { a1: 10, a2: 90 } }), S)).toThrow(/illegal allocation/)
  })
  it('throws on a non-integer bid', () => {
    expect(() => resolveRound(base({ seller1: { bid: 14.5, fixed: false } }), S)).toThrow(/integers/)
  })
})

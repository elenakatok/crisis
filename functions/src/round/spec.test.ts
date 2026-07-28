import { describe, it, expect } from 'vitest'
import { openGame, submit, expireStage, buildSeatView, type Seat } from '@mygames/stage-engine'
import {
  makeCrisisSpec, crisisRoll, typeRoll, defaultBidRng,
  FIELD_CRISIS, FIELD_PRIOR_FIX_1, FIELD_PRIOR_FIX_2,
  STAGE_BIDDING, STAGE_ALLOCATION, STAGE_FIXING,
  type CrisisAction, type CrisisResult,
} from './spec'
import { DEFAULT_CRISIS_SETTINGS as S } from './settings'
import { sellerDefaultBid, sellerDefaultFix, sellerFixFromBid, makeRng } from './decide'

// ═══════════════════════════════════════════════════════════════════════════════
// THE PARITY CLAIMS this migration rests on, proved rather than argued.
// ═══════════════════════════════════════════════════════════════════════════════

const ROLES: Record<Seat, string> = { 0: 'buyer', 1: 'seller1', 2: 'seller2' }
const SEATS: Seat[] = [0, 1, 2]
const spec = (seed: number, numRounds = 10) => makeCrisisSpec({ settings: S, numRounds, seed })
const open = (seed: number, numRounds = 10) =>
  openGame(spec(seed, numRounds), { seats: SEATS, roleBySeat: ROLES, seed })

const push = (sp: ReturnType<typeof spec>, st: Parameters<typeof submit<CrisisAction, CrisisResult>>[1], seat: Seat, a: CrisisAction) => {
  const r = submit(sp, st, seat, a)
  if (!r.ok) throw new Error(`rejected: ${r.reason}`)
  return r.state
}

describe('CLAIM 1 — roundType was redundant: the bid alone determines the default fix', () => {
  // The pre-migration machine stored a per-round `roundType` for a seller whose bid
  // defaulted and used sellerDefaultFix(type). The migration drops it and uses
  // sellerFixFromBid(bid). These must agree on EVERY bid the default table can
  // produce, or a defaulted seller's fix decision changes — a silent parity break.
  it('every HIGH default bid yields the same answer both ways', () => {
    for (let bid = S.highBid.min; bid <= S.highBid.max; bid++) {
      expect(sellerFixFromBid(bid, S), `bid ${bid}`).toBe(sellerDefaultFix('high'))
    }
  })
  it('every LOW default bid yields the same answer both ways', () => {
    for (let bid = S.lowBid.min; bid <= S.lowBid.max; bid++) {
      expect(sellerFixFromBid(bid, S), `bid ${bid}`).toBe(sellerDefaultFix('low'))
    }
  })
  it('the two ranges sit strictly either side of the threshold', () => {
    // The property the collapse depends on. If a settings edit ever broke it, the
    // two tests above would fail — this one says WHY in one line.
    expect(S.lowBid.max).toBeLessThan(S.fixBidThreshold)
    expect(S.highBid.min).toBeGreaterThanOrEqual(S.fixBidThreshold)
  })
  it('and it holds across every seeded draw the default table can make', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const type of ['high', 'low'] as const) {
        const bid = sellerDefaultBid(type, makeRng(seed), S)
        expect(sellerFixFromBid(bid, S)).toBe(sellerDefaultFix(type))
      }
    }
  })
})

describe('CLAIM 2 — the draws are byte-identical to the pre-migration machine', () => {
  // Reimplementations of the OLD machine's private helpers, as they were written.
  const oldCrisisRoll = (seed: number, round: number) => makeRng((seed + round * 2654435761) | 0)()
  const oldTypeRoll = (seed: number, round: number, seat: number) =>
    makeRng((seed + round * 40503 + seat * 104729) | 0)()
  const oldBidRng = (seed: number, round: number, seat: number) =>
    makeRng((seed + round * 7919 + seat * 611953) | 0)

  it('the crisis roll matches for every (seed, round) in range', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (let round = 1; round <= 10; round++) {
        expect(crisisRoll(seed, round)).toBe(oldCrisisRoll(seed, round))
      }
    }
  })
  it('the type roll matches for every (seed, round, seat)', () => {
    for (let seed = 0; seed < 30; seed++) {
      for (let round = 1; round <= 10; round++) {
        for (const seat of SEATS) expect(typeRoll(seed, round, seat)).toBe(oldTypeRoll(seed, round, seat))
      }
    }
  })
  it('the default-bid stream matches', () => {
    for (let seed = 0; seed < 30; seed++) {
      for (let round = 1; round <= 10; round++) {
        for (const seat of SEATS) {
          expect(defaultBidRng(seed, round, seat)()).toBe(oldBidRng(seed, round, seat)())
        }
      }
    }
  })
  it('so a given seed still produces the same crisis pattern across 10 rounds', () => {
    const pattern = (seed: number) =>
      Array.from({ length: 10 }, (_, i) => crisisRoll(seed, i + 1) < S.crisisProbability)
    expect(pattern(7)).toEqual(Array.from({ length: 10 }, (_, i) => oldCrisisRoll(7, i + 1) < S.crisisProbability))
  })
})

describe('CLAIM 3 — the mid-round reveal reproduces the old late draw', () => {
  /** The lowest seed whose round-1 draw matches `want`. */
  const seedWhereCrisis = (want: boolean) => {
    for (let seed = 1; seed < 500; seed++) {
      if ((crisisRoll(seed, 1) < S.crisisProbability) === want) return seed
    }
    throw new Error('no seed found')
  }

  it('crisis_occurred reaches NO seat during bidding or allocation', () => {
    const seed = seedWhereCrisis(true)
    const sp = spec(seed)
    let st = open(seed)
    expect(st.roundFields[FIELD_CRISIS]).toBe(true) // drawn, and on the server

    for (const seat of SEATS) {
      const v = buildSeatView(sp, st, seat)
      expect(FIELD_CRISIS in v.fields, `bidding, seat ${seat}`).toBe(false)
      expect(Object.keys(v.fields)).toEqual([])
    }
    st = push(sp, st, 1, { kind: 'bid', bid: 20 })
    st = push(sp, st, 2, { kind: 'bid', bid: 22 })

    // THE CASE THE WHOLE REVEAL EXISTS FOR — the Buyer is deciding right now.
    expect(buildSeatView(sp, st, 0).stageId).toBe(STAGE_ALLOCATION)
    for (const seat of SEATS) {
      const v = buildSeatView(sp, st, seat)
      expect(FIELD_CRISIS in v.fields, `allocation, seat ${seat}`).toBe(false)
      expect(Object.keys(v.fields)).toEqual([])
    }
  })

  it('and reaches ALL THREE at the fixing stage', () => {
    const seed = seedWhereCrisis(true)
    const sp = spec(seed)
    let st = open(seed)
    st = push(sp, st, 1, { kind: 'bid', bid: 20 })
    st = push(sp, st, 2, { kind: 'bid', bid: 22 })
    st = push(sp, st, 0, { kind: 'allocation', a1: 60, a2: 40 })
    expect(buildSeatView(sp, st, 1).stageId).toBe(STAGE_FIXING)
    for (const seat of SEATS) {
      expect(buildSeatView(sp, st, seat).fields[FIELD_CRISIS], `seat ${seat}`).toBe(true)
    }
  })

  it('no crisis → the fixing stage is SKIPPED and the round resolves', () => {
    const seed = seedWhereCrisis(false)
    const sp = spec(seed)
    let st = open(seed)
    st = push(sp, st, 1, { kind: 'bid', bid: 20 })
    st = push(sp, st, 2, { kind: 'bid', bid: 22 })
    st = push(sp, st, 0, { kind: 'allocation', a1: 60, a2: 40 })
    expect(st.round).toBe(2)
    expect(st.history).toHaveLength(1)
    expect(st.history[0].result.crisisOccurred).toBe(false)
  })

  it('the UNDECLARED bookkeeping fields never reach a seat either', () => {
    // prior_fix_1/2 are round state but undeclared, so visibleFields cannot expose
    // them. Server-side by construction.
    const sp = spec(3)
    const st = open(3)
    expect(st.roundFields[FIELD_PRIOR_FIX_1]).toBe(0)
    for (const seat of SEATS) {
      const f = buildSeatView(sp, st, seat).fields
      expect(FIELD_PRIOR_FIX_1 in f).toBe(false)
      expect(FIELD_PRIOR_FIX_2 in f).toBe(false)
    }
  })
})

describe('CLAIM 4 — legality lives in ONE place (§3.10)', () => {
  it('the bid bounds and message are the pre-migration ones', () => {
    const sp = spec(1)
    const st = open(1)
    const expected =
      'Enter a whole number between 10 and 30 (your cost is 10, the buyer values each unit at 30).'
    for (const bad of [9, 31, 0, -1]) {
      const r = submit(sp, st, 1, { kind: 'bid', bid: bad })
      expect(r.ok, `bid ${bad}`).toBe(false)
      expect(r.reason).toBe(expected)
    }
    expect(submit(sp, st, 1, { kind: 'bid', bid: 10 }).ok).toBe(true)
    expect(submit(sp, st, 1, { kind: 'bid', bid: 30 }).ok).toBe(true)
  })
  it('a non-integer bid is refused', () => {
    const sp = spec(1)
    expect(submit(sp, open(1), 1, { kind: 'bid', bid: 20.5 }).ok).toBe(false)
  })
  it('an illegal allocation is refused with the §1.3 reason', () => {
    const sp = spec(1)
    let st = open(1)
    st = push(sp, st, 1, { kind: 'bid', bid: 20 })
    st = push(sp, st, 2, { kind: 'bid', bid: 22 })
    const r = submit(sp, st, 0, { kind: 'allocation', a1: 90, a2: 5 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})

describe('CLAIM 5 — the clock still defaults every stage, and records the timeout', () => {
  it('a whole round can resolve on defaults alone', () => {
    const sp = spec(1)
    let st = open(1)
    st = expireStage(sp, st).state          // bidding
    st = expireStage(sp, st).state          // allocation
    if (st.round === 1) st = expireStage(sp, st).state  // fixing, if a crisis occurred
    expect(st.round).toBe(2)
    expect(st.history).toHaveLength(1)
    expect(st.timeouts.length).toBeGreaterThanOrEqual(3)
    // Timeouts carry round AND stage — never a bare boolean (§3.3).
    expect(st.timeouts[0]).toHaveProperty('round')
    expect(st.timeouts[0]).toHaveProperty('stageId')
  })

  it('a defaulted bid lands inside the type ranges the table declares', () => {
    const sp = spec(11)
    const st = expireStage(sp, open(11)).state
    for (const seat of [1, 2] as Seat[]) {
      const a = st.submissions[STAGE_BIDDING][seat] as { bid: number }
      const inHigh = a.bid >= S.highBid.min && a.bid <= S.highBid.max
      const inLow = a.bid >= S.lowBid.min && a.bid <= S.lowBid.max
      expect(inHigh || inLow, `bid ${a.bid}`).toBe(true)
    }
  })

  it('the buyer default gives the majority to the lower bid', () => {
    const sp = spec(5)
    let st = open(5)
    st = push(sp, st, 1, { kind: 'bid', bid: 14 })
    st = push(sp, st, 2, { kind: 'bid', bid: 26 })
    st = expireStage(sp, st).state
    // Read the ALLOCATION off whichever side of resolution we landed on: with no
    // crisis the round resolves the moment allocation closes and the working set is
    // cleared, so the value lives in history rather than in `submissions`.
    const alloc = (st.history[0]?.submissions[STAGE_ALLOCATION]?.[0]
      ?? st.submissions[STAGE_ALLOCATION]?.[0]) as { a1: number; a2: number }
    expect(alloc.a1).toBe(S.buyerDefaultMajority)          // 80 to the LOWER bid (seller 1 @14)
    expect(alloc.a2).toBe(S.contractUnits - S.buyerDefaultMajority)
  })
})

describe('CLAIM 6 — a full ten-round game runs to completion', () => {
  it('plays out and finishes at the horizon', () => {
    const sp = spec(42)
    let st = open(42)
    let guard = 0
    while (st.status === 'in_progress' && guard++ < 100) {
      const stage = buildSeatView(sp, st, 0).stageId
      if (stage === STAGE_BIDDING) {
        st = push(sp, st, 1, { kind: 'bid', bid: 18 })
        st = push(sp, st, 2, { kind: 'bid', bid: 24 })
      } else if (stage === STAGE_ALLOCATION) {
        st = push(sp, st, 0, { kind: 'allocation', a1: 60, a2: 40 })
      } else {
        st = push(sp, st, 1, { kind: 'fix', fixed: true })
        st = push(sp, st, 2, { kind: 'fix', fixed: false })
      }
    }
    expect(st.status).toBe('finished')
    expect(st.history).toHaveLength(10)
    expect(st.history.map((h) => h.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('prior fix counts accumulate into the next round’s bookkeeping', () => {
    const sp = spec(42)
    let st = open(42)
    // Play round 1 with seller1 fixing whenever asked.
    st = push(sp, st, 1, { kind: 'bid', bid: 18 })
    st = push(sp, st, 2, { kind: 'bid', bid: 24 })
    st = push(sp, st, 0, { kind: 'allocation', a1: 60, a2: 40 })
    if (st.round === 1) {
      st = push(sp, st, 1, { kind: 'fix', fixed: true })
      st = push(sp, st, 2, { kind: 'fix', fixed: false })
    }
    const crisisInR1 = st.history[0].result.crisisOccurred
    expect(st.roundFields[FIELD_PRIOR_FIX_1]).toBe(crisisInR1 ? 1 : 0)
    expect(st.roundFields[FIELD_PRIOR_FIX_2]).toBe(0)
  })
})

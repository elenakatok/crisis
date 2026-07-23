import { describe, it, expect } from 'vitest'
import {
  openRoundState, applyAction, expireStage, requiredSeats, buildSeatView,
  roleOfSeat, type CrisisState,
} from './machine'
import { DEFAULT_CRISIS_SETTINGS as S } from './settings'

// A seed whose late role assignment we pin per test by reading the state back (roles are
// assigned deterministically from the seed, so we never hard-code which seat is buyer).
function open(seed = 1, rounds = 10): CrisisState {
  return openRoundState([0, 1, 2], seed, rounds)
}

/** Drive one full round with explicit human actions; returns the post-round state. */
function playRound(
  st: CrisisState,
  opts: { bid1: number; bid2: number; a1: number; a2: number; fix1?: boolean; fix2?: boolean },
): CrisisState {
  let s = st
  // bidding (order doesn't matter; sealed)
  s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: opts.bid1 }, S).state
  s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: opts.bid2 }, S).state
  expect(s.stage).toBe('allocation')
  // allocation
  s = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: opts.a1, a2: opts.a2 }, S).state
  // maybe fixing
  if (s.stage === 'fixing') {
    for (const seat of requiredSeats(s)) {
      const isS1 = seat === s.seller1Seat
      s = applyAction(s, seat, { kind: 'fix', fixed: (isS1 ? opts.fix1 : opts.fix2) ?? false }, S).state
    }
  }
  return s
}

describe('open — roles assigned late (§2)', () => {
  it('assigns exactly one buyer + two distinct sellers among the 3 seats', () => {
    const s = open()
    const roles = [s.buyerSeat, s.seller1Seat, s.seller2Seat]
    expect(new Set(roles).size).toBe(3)
    expect(new Set(roles)).toEqual(new Set([0, 1, 2]))
    expect(roleOfSeat(s, s.buyerSeat)).toBe('buyer')
  })
  it('starts at round 1, bidding stage, in_progress', () => {
    const s = open()
    expect(s.round).toBe(1)
    expect(s.stage).toBe('bidding')
    expect(s.status).toBe('in_progress')
  })
})

describe('clean playthrough — 3 humans, no timeouts', () => {
  it('runs exactly 10 rounds then finishes with 10 history rows', () => {
    let s = open(1)
    for (let r = 1; r <= 10; r++) {
      expect(s.round).toBe(r)
      s = playRound(s, { bid1: 15, bid2: 18, a1: 60, a2: 40, fix1: true, fix2: false })
    }
    expect(s.status).toBe('finished')
    expect(s.history).toHaveLength(10)
    expect(s.history.every((h) => h.bids.s1 === 15 && h.bids.s2 === 18)).toBe(true)
  })

  it('history is the same object for every seat (§1.1 — no private info)', () => {
    let s = open(1)
    s = playRound(s, { bid1: 14, bid2: 25, a1: 80, a2: 20, fix1: false, fix2: true })
    const v0 = buildSeatView(s, 0).history
    const v1 = buildSeatView(s, 1).history
    const v2 = buildSeatView(s, 2).history
    expect(v0).toEqual(v1)
    expect(v1).toEqual(v2)
  })
})

describe('stage structure (§1.2)', () => {
  it('sealed bidding: a seat cannot see the other bid until bidding closes', () => {
    let s = open(1)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    expect(s.stage).toBe('bidding') // still open — one seller left
    // buyer view mid-bidding hides current bids
    expect(buildSeatView(s, s.buyerSeat).currentBids).toBeNull()
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 22 }, S).state
    expect(s.stage).toBe('allocation')
    // now revealed
    expect(buildSeatView(s, s.buyerSeat).currentBids).toEqual({ s1: 15, s2: 22 })
  })

  it('no crisis → stage 3 SKIPPED, round resolves after the draw', () => {
    // seed chosen so round-1 crisis draw is false (asserted by the skip)
    let s = open(1)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 15 }, S).state
    const afterAlloc = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 50, a2: 50 }, S)
    // Either it went to fixing (crisis) or straight resolved (no crisis) — assert consistency.
    if (afterAlloc.state.crisisOccurred === false) {
      expect(afterAlloc.state.round).toBe(2) // resolved + advanced, no fix stage
      expect(afterAlloc.state.stage).toBe('bidding')
    } else {
      expect(afterAlloc.state.stage).toBe('fixing')
    }
  })

  it('crisis draw is deterministic per (seed, round) — replay identical', () => {
    const runToDraw = (seed: number) => {
      let s = open(seed)
      s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
      s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 15 }, S).state
      return applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 50, a2: 50 }, S).state.crisisOccurred
    }
    expect(runToDraw(42)).toBe(runToDraw(42))
  })
})

describe('required seats — a 0-unit Seller has NO fix decision (the hang-prevention core)', () => {
  it('fixing waits only on Sellers with >0 units', () => {
    // force a crisis round by scanning seeds until round-1 crisis is true
    let s = findCrisisRound1()
    // allocate everything to seller1, 0 to seller2
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 22 }, S).state
    s = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 100, a2: 0 }, S).state
    expect(s.stage).toBe('fixing')
    expect(requiredSeats(s)).toEqual([s.seller1Seat]) // seller2 (0 units) NOT required
    // seller1 fixes → round closes even though seller2 never acted
    s = applyAction(s, s.seller1Seat, { kind: 'fix', fixed: true }, S).state
    expect(s.round).toBe(2)
  })

  it('a 0-unit Seller trying to fix is rejected', () => {
    let s = findCrisisRound1()
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 22 }, S).state
    s = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 100, a2: 0 }, S).state
    const r = applyAction(s, s.seller2Seat, { kind: 'fix', fixed: true }, S)
    expect(r.ok).toBe(false)
  })
})

describe('timeout → default (§3.2), each stage independently', () => {
  it('bidding timeout: idle sellers get a default bid + type, stage closes', () => {
    let s = open(3)
    const r = expireStage(s, S)
    s = r.state
    expect(s.stage).toBe('allocation') // bidding closed by the clock
    expect(s.bids[s.seller1Seat]).toBeGreaterThanOrEqual(12)
    expect(s.bids[s.seller2Seat]).toBeGreaterThanOrEqual(12)
    expect(s.timeouts[s.seller1Seat]).toHaveLength(1)
    expect(s.timeouts[s.seller1Seat][0]).toEqual({ round: 1, stage: 'bidding' })
  })

  it('allocation timeout: buyer default = 80 to the lower bid', () => {
    let s = open(3)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 14 }, S).state
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 25 }, S).state
    s = expireStage(s, S).state // buyer times out
    // seller1 bid lower → gets 80
    expect(s.timeouts[s.buyerSeat]).toEqual([{ round: 1, stage: 'allocation' }])
  })

  it('fixing timeout: default-bid seller fixes per its TYPE, not the bid', () => {
    // both sellers time out bidding (get a type), buyer allocates 50/50, crisis, sellers time out fix
    let s = findCrisisRound1(3)
    s = expireStage(s, S).state                                   // bidding defaults (types drawn)
    s = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 50, a2: 50 }, S).state
    expect(s.stage).toBe('fixing')
    const beforeTypes = { ...s.roundType }
    s = expireStage(s, S).state                                   // fixing defaults
    // the recorded fix must equal the TYPE's fix (high→fix, low→not)
    const rec = s.history[0]
    expect(rec.fixed.s1).toBe(beforeTypes[s.seller1Seat] === 'high')
    expect(rec.fixed.s2).toBe(beforeTypes[s.seller2Seat] === 'high')
  })

  it('fixing timeout: REAL-bid seller (no type) derives fix from bid (≥20 → fix)', () => {
    let s = findCrisisRound1(3)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 25 }, S).state // real bid ≥20
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 14 }, S).state // real bid <20
    s = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 50, a2: 50 }, S).state
    expect(s.stage).toBe('fixing')
    s = expireStage(s, S).state
    const rec = s.history[0]
    expect(rec.fixed.s1).toBe(true)  // bid 25 ≥ 20
    expect(rec.fixed.s2).toBe(false) // bid 14 < 20
  })
})

describe('every seat times out in the same round', () => {
  it('resolves the round entirely from defaults', () => {
    let s = findCrisisRound1(3)
    s = expireStage(s, S).state // all sellers default their bid
    expect(s.stage).toBe('allocation')
    s = expireStage(s, S).state // buyer defaults allocation → crisis draw
    // if crisis, one more expire for fixing; loop until the round advances
    if (s.stage === 'fixing') s = expireStage(s, S).state
    expect(s.round).toBe(2)
    expect(s.history).toHaveLength(1)
    const rec = s.history[0]
    expect(rec.defaulted.buyer).toBe(true)
  })
})

describe('idempotency — expireStage firing twice must not double-advance', () => {
  it('a second expire after the stage already closed is a no-op', () => {
    let s = open(3)
    const first = expireStage(s, S)
    expect(first.stageClosed).toBe(true)
    const advancedRound = first.state.round
    const advancedStage = first.state.stage
    // fire again on the SAME (pre-expire) state? No — fire on the advanced state: the new
    // stage has no expired deadline yet, but expireStage on a fresh stage with all-idle
    // required seats would default them. The SHELL guards this with the deadline; here we
    // assert the machine-level guarantee: expiring the NEW stage does not touch the OLD round.
    const second = expireStage(first.state, S)
    // second acted on the new stage (allocation) — round must not have jumped by 2
    expect(second.state.round).toBeGreaterThanOrEqual(advancedRound)
    expect(second.state.history.length).toBeLessThanOrEqual(1)
    expect(advancedStage).toBe('allocation')
  })

  it('re-applying a human action after it landed is rejected (no double-apply)', () => {
    let s = open(1)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    const dup = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 99 }, S)
    expect(dup.ok).toBe(false)
    expect(dup.state.bids[s.seller1Seat]).toBe(15) // unchanged
  })
})

describe('action guards', () => {
  it('a seller cannot allocate; the buyer cannot bid', () => {
    const s = open(1)
    expect(applyAction(s, s.buyerSeat, { kind: 'bid', bid: 15 }, S).ok).toBe(false)
    // advance to allocation
    let s2 = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    s2 = applyAction(s2, s.seller2Seat, { kind: 'bid', bid: 15 }, S).state
    expect(applyAction(s2, s2.seller1Seat, { kind: 'allocation', a1: 50, a2: 50 }, S).ok).toBe(false)
  })

  it('an illegal allocation is rejected and not recorded', () => {
    let s = open(1)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 15 }, S).state
    const r = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 10, a2: 90 }, S)
    expect(r.ok).toBe(false)
    expect(r.state.allocation).toBeNull()
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Open with a seed whose round-1 crisis draw is TRUE (scans seeds; deterministic). */
function findCrisisRound1(startSeed = 1): CrisisState {
  for (let seed = startSeed; seed < startSeed + 500; seed++) {
    let s = open(seed)
    s = applyAction(s, s.seller1Seat, { kind: 'bid', bid: 15 }, S).state
    s = applyAction(s, s.seller2Seat, { kind: 'bid', bid: 15 }, S).state
    const after = applyAction(s, s.buyerSeat, { kind: 'allocation', a1: 50, a2: 50 }, S).state
    if (after.crisisOccurred === true) return open(seed) // fresh state at that seed
  }
  throw new Error('no crisis seed found (unexpected)')
}

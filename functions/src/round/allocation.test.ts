import { describe, it, expect } from 'vitest'
import { validateAllocation, isLegalAllocation } from './allocation'
import { DEFAULT_CRISIS_SETTINGS as S } from './settings'

describe('validateAllocation (§1.3) — LEGAL set', () => {
  const legal: Array<[number, number]> = [
    [0, 100], [100, 0],   // one seller gets everything
    [20, 80], [80, 20],   // min-boundary either side
    [50, 50],             // even split
    [21, 79], [40, 60],   // interior
  ]
  for (const [a1, a2] of legal) {
    it(`(${a1}, ${a2}) is legal`, () => {
      expect(validateAllocation(a1, a2, S)).toEqual({ ok: true })
      expect(isLegalAllocation(a1, a2, S)).toBe(true)
    })
  }
})

describe('validateAllocation (§1.3) — ILLEGAL rejections', () => {
  it('rejects a sum below 100', () => {
    expect(validateAllocation(40, 50, S).ok).toBe(false)
  })
  it('rejects a sum above 100', () => {
    expect(validateAllocation(60, 60, S).ok).toBe(false)
  })
  it('rejects a nonzero amount below the 20-unit minimum (low side)', () => {
    expect(validateAllocation(10, 90, S).ok).toBe(false)
  })
  it('rejects a nonzero amount below the 20-unit minimum (high side)', () => {
    expect(validateAllocation(90, 10, S).ok).toBe(false)
  })
  it('rejects 19 (just under the minimum) even though it sums to 100', () => {
    expect(validateAllocation(19, 81, S).ok).toBe(false)
  })
  it('rejects negatives', () => {
    expect(validateAllocation(-20, 120, S).ok).toBe(false)
  })
  it('rejects non-integers', () => {
    expect(validateAllocation(50.5, 49.5, S).ok).toBe(false)
  })
  it('gives a student-facing reason string on rejection', () => {
    const r = validateAllocation(10, 90, S)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0)
  })
})

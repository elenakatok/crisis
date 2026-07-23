import { useCallback, useEffect, useRef, useState } from 'react'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import {
  getRoundView, submitBid, submitAllocation, submitFix,
  type SeatView, type Role,
} from '../api'
import { CRISIS, checkAllocation } from './constants'
import HistoryTable from './HistoryTable'
import ClockBar from './ClockBar'

// ═══════════════════════════════════════════════════════════════════════════════
// CrisisGame — the three decision screens + shared history table (Slice 3). Polls
// getRoundView; renders bid / allocation / fix / waiting / finished by the per-seat
// view. NOTHING game-authoritative lives here — the server resolves.
//
// ⚠ SLICE-5 CONTRACT (§5.5): the full per-seat view is exposed to the page at
// `window.__crisisState` (a plain object = exactly what getRoundView returns, i.e.
// buildSeatView + clock fields). The robot driver READS that object directly (no testid
// scraping) to decide, then ACTS through the real inputs/buttons below. Shape is the
// SeatView type in api.ts.
// ═══════════════════════════════════════════════════════════════════════════════

declare global {
  interface Window {
    /** Slice-5 robot-driver contract: the current per-seat view, or null before it loads. */
    __crisisState?: SeatView | null
  }
}

const ROLE_LABEL: Record<Role, string> = { buyer: 'Buyer', seller1: 'Seller 1', seller2: 'Seller 2' }
const POLL_MS = 1200

const page: React.CSSProperties = { padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto', fontFamily: typography.fontFamily }
const factList: React.CSSProperties = { margin: `${spacing.gapSm} 0`, padding: 0, listStyle: 'none', lineHeight: 1.9, color: colors.textSecondary }
const primaryBtn: React.CSSProperties = { padding: '0.5rem 1.1rem', fontSize: '1rem', cursor: 'pointer', background: colors.text, color: colors.white, border: 'none', borderRadius: 4 }
const numInput: React.CSSProperties = { fontSize: '1.4rem', width: '8rem', padding: '0.35rem 0.5rem', fontFamily: 'monospace' }

export default function CrisisGame({
  groupId,
}: {
  // participantId / gameInstanceId are supplied by Play (session context) but the game
  // reads/acts purely by group_id — auth rides the session Bearer.
  participantId: string
  gameInstanceId: string
  groupId: string
}) {
  const [view, setView] = useState<SeatView | null>(null)
  const [notStarted, setNotStarted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const cancelled = useRef(false)

  const poll = useCallback(async () => {
    try {
      const v = await getRoundView(groupId)
      if (cancelled.current) return
      setView(v)
      setNotStarted(false)
      window.__crisisState = v // ← Slice-5 contract: expose the per-seat view to the page
    } catch (err) {
      if (cancelled.current) return
      const msg = err instanceof Error ? err.message : ''
      if (/not started|not-found|Round not started/i.test(msg)) { setNotStarted(true); window.__crisisState = null }
    }
  }, [groupId])

  useEffect(() => {
    cancelled.current = false
    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => { cancelled.current = true; clearInterval(id) }
  }, [poll])

  const act = async (fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    setSubmitting(true); setSubmitError(null)
    try {
      const r = await fn()
      if (!r.ok) { setSubmitError(r.reason ?? 'That action was not accepted.'); setSubmitting(false); return }
      await poll() // optimistic re-poll so the next stage/screen shows immediately
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
    }
    setSubmitting(false)
  }

  // ── pre-game: instructor hasn't started the round yet ──────────────────────────
  if (notStarted || view === null) {
    return (
      <main style={page}>
        <h1 style={{ marginTop: 0 }}>You&apos;re in your group</h1>
        <p style={{ color: colors.textSecondary }} data-testid="crisis-waiting-start">
          Waiting for your instructor to start the game. Your role — Buyer or Seller — will be
          assigned when it begins. Keep this tab open.
        </p>
      </main>
    )
  }

  const roleLabel = ROLE_LABEL[view.role]
  const period = `Period ${view.round} of ${view.numRounds}`
  const stageKey = `${view.round}-${view.stage}`
  const waitingOnYou = view.owes !== null ? Math.max(0, 3 - view.pendingCount) : 0

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, flexWrap: 'wrap', marginBottom: spacing.gapMd }}>
      <span data-testid="crisis-role" style={{ fontWeight: 700 }}>{roleLabel}</span>
      <span data-testid="crisis-period" style={{ color: colors.textSecondary }}>{period}</span>
      <ClockBar deadlineMs={view.stageDeadlineMs} stageKey={stageKey} nudge={view.owes !== null} />
    </div>
  )

  // ── FINISHED ───────────────────────────────────────────────────────────────────
  if (view.status === 'finished') {
    const myTotal = view.history.reduce((sum, h) =>
      sum + (view.role === 'buyer' ? h.profits.buyer : view.role === 'seller1' ? h.profits.seller1 : h.profits.seller2), 0)
    return (
      <main style={page} data-testid="crisis-finished">
        <h1 style={{ marginTop: 0 }}>Game complete</h1>
        <p>You played as <strong>{roleLabel}</strong>. Your total profit across all {view.numRounds} rounds
          was <strong data-testid="crisis-total-profit">{myTotal.toLocaleString('en-US')}</strong>.</p>
        <p style={{ color: colors.textSecondary }}>Profit is the object of the debrief — it is not graded.</p>
        <h2 style={{ fontSize: '1.1rem' }}>Full history</h2>
        <HistoryTable history={view.history} />
      </main>
    )
  }

  // ── BID (Seller owes a bid) ──────────────────────────────────────────────────────
  if (view.owes === 'bid') {
    return (
      <main style={page}>
        {header}
        <h1 style={{ marginTop: 0 }}>Set your price</h1>
        <p>You are a Seller. Choose your price per unit. The other Seller submits at the same time — you
          will not see their price until the Buyer allocates.</p>
        <ul style={factList}>
          <li>Buyer&apos;s value: <strong>{CRISIS.buyerValue}</strong> per unit</li>
          <li>Your cost: <strong>{CRISIS.sellerCost}</strong> per unit (the other Seller&apos;s cost is also {CRISIS.sellerCost} — common knowledge)</li>
          <li>Contract: <strong>{CRISIS.contractUnits}</strong> units, split by the Buyer</li>
          <li>Crisis: <strong>{CRISIS.crisisPct}%</strong> chance this round · repair costs a Seller {CRISIS.sellerRepair}/unit, or costs the Buyer {CRISIS.buyerRepair}/unit if unfixed</li>
        </ul>
        <BidForm submitting={submitting} onSubmit={(bid) => act(() => submitBid(groupId, bid))} />
        {waitingBanner(waitingOnYou)}
        {submitError && <ErrorNote msg={submitError} />}
        <HistorySection history={view.history} />
      </main>
    )
  }

  // ── ALLOCATION (Buyer owes an allocation) ────────────────────────────────────────
  if (view.owes === 'allocation') {
    const bids = view.currentBids!
    return (
      <main style={page}>
        {header}
        <h1 style={{ marginTop: 0 }}>Allocate the {CRISIS.contractUnits} units</h1>
        <p>You are the Buyer. Split the {CRISIS.contractUnits} units between the two Sellers.</p>
        <ul style={factList}>
          <li>Your value: <strong>{CRISIS.buyerValue}</strong> per unit</li>
          <li>Seller 1 bid: <strong data-testid="crisis-shown-bid1">{bids.s1}</strong> · Seller 2 bid: <strong data-testid="crisis-shown-bid2">{bids.s2}</strong></li>
          <li>Rule: the two amounts must add to exactly {CRISIS.contractUnits}, and each Seller gets <strong>either 0 or at least {CRISIS.minAllocation}</strong> units.</li>
          <li>If a crisis occurs and a Seller does not fix it, you pay {CRISIS.buyerRepair}/unit on their units.</li>
        </ul>
        <AllocationForm submitting={submitting} onSubmit={(a1, a2) => act(() => submitAllocation(groupId, a1, a2))} />
        {waitingBanner(waitingOnYou)}
        {submitError && <ErrorNote msg={submitError} />}
        <HistorySection history={view.history} />
      </main>
    )
  }

  // ── FIX (Seller with >0 units owes a fix decision — a 0-unit seller never gets here) ──
  if (view.owes === 'fix') {
    const bids = view.currentBids!
    const alloc = view.currentAllocation!
    const mine = view.role === 'seller1'
    const myBid = mine ? bids.s1 : bids.s2
    const myAlloc = mine ? alloc.a1 : alloc.a2
    const otherBid = mine ? bids.s2 : bids.s1
    const otherAlloc = mine ? alloc.a2 : alloc.a1
    return (
      <main style={page}>
        {header}
        <p data-testid="crisis-crisis-banner" style={{ fontWeight: 700, color: '#b45309' }}>⚠ A crisis occurred this round.</p>
        <h1 style={{ marginTop: 0 }}>Fix the crisis on your units?</h1>
        <ul style={factList}>
          <li>Your bid: <strong>{myBid}</strong> · your units: <strong>{myAlloc}</strong></li>
          <li>Fixing costs you <strong>{CRISIS.sellerRepair}</strong>/unit ({CRISIS.sellerRepair * myAlloc} total).</li>
          <li>If you do NOT fix, the Buyer (value {CRISIS.buyerValue}) pays <strong>{CRISIS.buyerRepair}</strong>/unit on your units.</li>
          <li>Other Seller — bid {otherBid}, units {otherAlloc}.</li>
        </ul>
        <div style={{ display: 'flex', gap: spacing.gapBtn }}>
          <button data-testid="crisis-fix-yes" style={primaryBtn} disabled={submitting} onClick={() => act(() => submitFix(groupId, true))}>Yes — fix it</button>
          <button data-testid="crisis-fix-no" style={{ ...primaryBtn, background: 'none', color: colors.text, border: `1px solid ${colors.borderLight}` }} disabled={submitting} onClick={() => act(() => submitFix(groupId, false))}>No — do not fix</button>
        </div>
        {waitingBanner(waitingOnYou)}
        {submitError && <ErrorNote msg={submitError} />}
        <HistorySection history={view.history} />
      </main>
    )
  }

  // ── WAITING (this seat has nothing to do right now) ──────────────────────────────
  const stageWord = view.stage === 'bidding' ? 'Sellers are setting their prices' : view.stage === 'allocation' ? 'the Buyer is allocating the units' : 'Sellers are deciding whether to fix the crisis'
  return (
    <main style={page}>
      {header}
      <h1 style={{ marginTop: 0 }}>Waiting on the others</h1>
      {view.crisisOccurred === true && view.stage === 'fixing' && (
        <p data-testid="crisis-crisis-banner" style={{ fontWeight: 700, color: '#b45309' }}>⚠ A crisis occurred this round.</p>
      )}
      <p data-testid="crisis-waiting" style={{ color: colors.textSecondary }}>
        Right now {stageWord}. Waiting on <strong>{view.pendingCount}</strong> player{view.pendingCount === 1 ? '' : 's'}.
      </p>
      <HistorySection history={view.history} />
    </main>
  )
}

// ── small sub-forms + helpers ──────────────────────────────────────────────────

function BidForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: (bid: number) => void }) {
  const [val, setVal] = useState('')
  const n = Number(val)
  const valid = val.trim() !== '' && Number.isInteger(n) && n >= 0
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit(n) }} style={{ margin: `${spacing.gapMd} 0` }}>
      <label style={{ display: 'block', marginBottom: spacing.gapSm, fontWeight: 600 }}>Your price per unit</label>
      <input data-testid="crisis-bid-input" style={numInput} value={val} inputMode="numeric"
        onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ''))} disabled={submitting} autoFocus />
      <div style={{ marginTop: spacing.gapMd }}>
        <button data-testid="crisis-submit" type="submit" style={primaryBtn} disabled={!valid || submitting}>{submitting ? 'Submitting…' : 'Submit bid'}</button>
      </div>
    </form>
  )
}

function AllocationForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: (a1: number, a2: number) => void }) {
  const [v1, setV1] = useState('')
  const [v2, setV2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const a1 = Number(v1), a2 = Number(v2)
  const handle = (e: React.FormEvent) => {
    e.preventDefault()
    const check = checkAllocation(a1, a2)
    if (!check.ok) { setErr(check.reason); return }
    setErr(null); onSubmit(a1, a2)
  }
  return (
    <form onSubmit={handle} style={{ margin: `${spacing.gapMd} 0` }}>
      <div style={{ display: 'flex', gap: spacing.gapMd, flexWrap: 'wrap' }}>
        <div>
          <label style={{ display: 'block', marginBottom: spacing.gapSm, fontWeight: 600 }}>Units to Seller 1</label>
          <input data-testid="crisis-alloc-1" style={numInput} value={v1} inputMode="numeric"
            onChange={(e) => { setV1(e.target.value.replace(/[^0-9]/g, '')); setErr(null) }} disabled={submitting} autoFocus />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: spacing.gapSm, fontWeight: 600 }}>Units to Seller 2</label>
          <input data-testid="crisis-alloc-2" style={numInput} value={v2} inputMode="numeric"
            onChange={(e) => { setV2(e.target.value.replace(/[^0-9]/g, '')); setErr(null) }} disabled={submitting} />
        </div>
      </div>
      {err && <p data-testid="crisis-alloc-error" style={{ color: '#b91c1c', marginTop: spacing.gapSm }}>{err}</p>}
      <div style={{ marginTop: spacing.gapMd }}>
        <button data-testid="crisis-submit" type="submit" style={primaryBtn} disabled={submitting}>{submitting ? 'Submitting…' : 'Submit allocation'}</button>
      </div>
    </form>
  )
}

function waitingBanner(waitingOnYou: number) {
  if (waitingOnYou <= 0) return null
  return (
    <p data-testid="crisis-waiting-on-you" style={{ color: colors.textSecondary, marginTop: spacing.gapMd }}>
      {waitingOnYou} other player{waitingOnYou === 1 ? ' is' : 's are'} waiting on you.
    </p>
  )
}

function ErrorNote({ msg }: { msg: string }) {
  return <p data-testid="crisis-submit-error" role="alert" style={{ color: '#b91c1c', marginTop: spacing.gapSm }}>{msg}</p>
}

function HistorySection({ history }: { history: import('../api').RoundRecord[] }) {
  return (
    <section style={{ marginTop: spacing.gapXl }}>
      <h2 style={{ fontSize: '1.05rem' }}>History — everyone sees the same table</h2>
      <HistoryTable history={history} />
    </section>
  )
}

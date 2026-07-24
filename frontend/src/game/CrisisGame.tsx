import { useCallback, useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { db } from '../firebase'
import {
  getRoundView, submitBid, submitAllocation, submitFix, flagGroup,
  type SeatView, type Role, type OnlineMember,
} from '../api'
import { CRISIS, checkAllocation } from './constants'
import HistoryTable from './HistoryTable'
import ClockBar from './ClockBar'
import OnlineMemberList from './OnlineMemberList'

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
  participantId,
  gameInstanceId,
  groupId,
}: {
  // The game reads/acts purely by group_id — auth rides the session Bearer. participantId /
  // gameInstanceId are used ONLY by the online members strip on the pre-round screen.
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

  // ── pre-game: the round hasn't opened yet — mode-branched copy (§O2 fix) ──────────
  if (notStarted || view === null) {
    return <PreGameWaiting participantId={participantId} gameInstanceId={gameInstanceId} groupId={groupId} />
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
        <HistoryTable history={view.history} viewerRole={view.role} />
      </main>
    )
  }

  // ── BID (Seller owes a bid) ──────────────────────────────────────────────────────
  if (view.owes === 'bid') {
    return (
      <main style={page}>
        {header}
        <h1 style={{ marginTop: 0 }}>Set your price</h1>
        <p>You are <strong>{roleLabel}</strong>. Choose your price per unit. The other Seller submits at
          the same time — you will not see their price until the Buyer allocates.</p>
        <ul style={factList}>
          <li>Buyer&apos;s value: <strong>{CRISIS.buyerValue}</strong> per unit</li>
          <li>Your cost: <strong>{CRISIS.sellerCost}</strong> per unit (the other Seller&apos;s cost is also {CRISIS.sellerCost} — common knowledge)</li>
          <li>Contract: <strong>{CRISIS.contractUnits}</strong> units, split by the Buyer</li>
          <li>Crisis: <strong>{CRISIS.crisisPct}%</strong> chance this round · repair costs a Seller {CRISIS.sellerRepair}/unit, or costs the Buyer {CRISIS.buyerRepair}/unit if unfixed</li>
        </ul>
        <BidForm submitting={submitting} onSubmit={(bid) => act(() => submitBid(groupId, bid))} />
        {waitingBanner(waitingOnYou)}
        {submitError && <ErrorNote msg={submitError} />}
        <HistorySection history={view.history} viewerRole={view.role} />
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
        <HistorySection history={view.history} viewerRole={view.role} />
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
    const otherLabel = mine ? 'Seller 2' : 'Seller 1'
    return (
      <main style={page}>
        {header}
        <p data-testid="crisis-crisis-banner" style={{ fontWeight: 700, color: '#b45309' }}>⚠ A crisis occurred this round.</p>
        <h1 style={{ marginTop: 0 }}>Fix the crisis on your units?</h1>
        <ul style={factList}>
          <li>You (<strong>{roleLabel}</strong>) — bid <strong>{myBid}</strong> · units <strong>{myAlloc}</strong></li>
          <li>Fixing costs you <strong>{CRISIS.sellerRepair}</strong>/unit ({CRISIS.sellerRepair * myAlloc} total).</li>
          <li>If you do NOT fix, the Buyer (value {CRISIS.buyerValue}) pays <strong>{CRISIS.buyerRepair}</strong>/unit on your units.</li>
          <li>{otherLabel} — bid {otherBid}, units {otherAlloc}.</li>
        </ul>
        <FixForm submitting={submitting} onSubmit={(fixed) => act(() => submitFix(groupId, fixed))} />
        {waitingBanner(waitingOnYou)}
        {submitError && <ErrorNote msg={submitError} />}
        <HistorySection history={view.history} viewerRole={view.role} />
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
      <HistorySection history={view.history} viewerRole={view.role} />
    </main>
  )
}

// ── small sub-forms + helpers ──────────────────────────────────────────────────

function BidForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: (bid: number) => void }) {
  const [val, setVal] = useState('')
  const n = Number(val)
  const inRange = Number.isInteger(n) && n >= 10 && n <= 30 // §1.1: cost floor 10, buyer-value ceiling 30 (inclusive)
  const valid = val.trim() !== '' && inRange
  const showErr = val.trim() !== '' && !inRange
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (valid) onSubmit(n) }} style={{ margin: `${spacing.gapMd} 0` }}>
      <label style={{ display: 'block', marginBottom: spacing.gapSm, fontWeight: 600 }}>Your price per unit</label>
      <input data-testid="crisis-bid-input" style={numInput} value={val} inputMode="numeric"
        onChange={(e) => setVal(e.target.value.replace(/[^0-9]/g, ''))} disabled={submitting} autoFocus />
      <div style={{ marginTop: spacing.gapSm, fontSize: '0.8rem', color: colors.textSecondary }}>
        Enter a whole number between <strong>10</strong> and <strong>30</strong>.
      </div>
      {showErr && (
        <p data-testid="crisis-bid-error" style={{ color: '#b91c1c', fontSize: '0.8rem', margin: `${spacing.gapSm} 0 0` }}>
          Your price must be between 10 and 30.
        </p>
      )}
      <div style={{ marginTop: spacing.gapMd }}>
        <button data-testid="crisis-submit" type="submit" style={primaryBtn} disabled={!valid || submitting}>{submitting ? 'Submitting…' : 'Submit bid'}</button>
      </div>
    </form>
  )
}

// Fix decision — NEUTRAL until the student picks (§O2.2 step 3): both options render identically
// with no default/highlight; the chosen one gets a border+tint ONLY after it is clicked, and
// Submit is disabled until a choice is made. (A timeout still applies the server default table
// unchanged — this only governs the on-screen presentation.)
function FixForm({ submitting, onSubmit }: { submitting: boolean; onSubmit: (fixed: boolean) => void }) {
  const [choice, setChoice] = useState<boolean | null>(null)
  const opt = (selected: boolean): React.CSSProperties => ({
    padding: '0.5rem 1.1rem', fontSize: '1rem', cursor: 'pointer', borderRadius: 4,
    background: selected ? colors.confirmBg : 'none',
    color: colors.text,
    border: `1px solid ${selected ? colors.text : colors.borderLight}`,
    fontWeight: selected ? 700 : 500,
  })
  return (
    <div style={{ margin: `${spacing.gapMd} 0` }}>
      <div role="radiogroup" aria-label="Fix the crisis?" style={{ display: 'flex', gap: spacing.gapBtn }}>
        <button data-testid="crisis-fix-yes" type="button" role="radio" aria-checked={choice === true} style={opt(choice === true)} disabled={submitting} onClick={() => setChoice(true)}>Yes — fix it</button>
        <button data-testid="crisis-fix-no" type="button" role="radio" aria-checked={choice === false} style={opt(choice === false)} disabled={submitting} onClick={() => setChoice(false)}>No — do not fix</button>
      </div>
      <div style={{ marginTop: spacing.gapMd }}>
        <button
          data-testid="crisis-fix-submit"
          type="button"
          style={primaryBtn}
          disabled={choice === null || submitting}
          onClick={() => { if (choice !== null) onSubmit(choice) }}
        >
          {submitting ? 'Submitting…' : 'Submit decision'}
        </button>
      </div>
    </div>
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

// ── The post-reveal / pre-round-1 waiting screen. Copy is MODE-BRANCHED off the group doc,
// read LIVE (onSnapshot) so it is never a stale login-time value: an online-formed group carries
// members[] (classroom groups never do). Online also shows a live "N of M are here" arrival count
// (bot seats count as present; a human is "here" once their poll has registered in `arrived`). ──
function PreGameWaiting({ participantId, gameInstanceId, groupId }: { participantId: string; gameInstanceId: string; groupId: string }) {
  const [g, setG] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    const ref = doc(db, 'game_instances', gameInstanceId, 'groups', groupId)
    const unsub = onSnapshot(ref, (s) => setG(s.exists() ? s.data() : {}), () => setG({}))
    return () => unsub()
  }, [gameInstanceId, groupId])

  const online = Array.isArray(g?.members)
  const members = (g?.members as import('../api').OnlineMember[] | undefined) ?? []
  const arrived = new Set((g?.arrived as string[] | undefined) ?? [])
  const botCount = ((g?.bot_participants as string[] | undefined) ?? []).length
  const total = 3 // Crisis groups are fixed at 3 — a short/solo group reads "1 of 3", never "1 of 1"
  // The viewer is "here" by definition; other humans once their poll has registered in `arrived`.
  const humansPresent = members.filter(m => m.participant_id === participantId || arrived.has(m.participant_id)).length
  const present = humansPresent + botCount
  const haveCount = online

  if (!online) {
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

  return (
    <main style={page}>
      <h1 style={{ marginTop: 0 }}>You&apos;re in your group</h1>
      <p style={{ color: colors.textSecondary }} data-testid="crisis-waiting-start">
        {haveCount && (
          <><strong data-testid="crisis-waiting-count">{present} of {total}</strong> group members {present === 1 ? 'is' : 'are'} here. </>
        )}
        Waiting for your other group members to arrive. The game starts automatically when everyone
        is here — reach out below to coordinate. Your role — Buyer or Seller — will be assigned when
        it begins. Keep this tab open.
      </p>
      {/* The reveal's full member presentation (name + email mailto), plus per-member arrival. */}
      <OnlineMemberList members={members} participantId={participantId} arrived={arrived} />
      {/* §O3: "I can't reach my group" — mailto to the instructor cc the group + a passive flag. */}
      <FlagButton
        participantId={participantId}
        members={members}
        arrived={arrived}
        alreadyFlagged={g?.flag != null}
      />
    </main>
  )
}

// ── "I can't reach my group" (Slice O3, spec §4.1) ────────────────────────────────
// One press does BOTH: opens a pre-filled mailto (To: instructor, Cc: the group, subject naming
// the game + group, body listing who is/isn't here + space for the student) AND writes a passive
// flag on the group. The flag write is idempotent server-side — pressing again only reopens the
// mailto, never a duplicate flag. The flagged state persists across reloads because it reads the
// group doc's `flag` field (live via the parent onSnapshot). The mailto's To: comes from the
// instructor_email config value; when Elena has not set it the draft still opens, Cc'd to the group.
function FlagButton({
  participantId, members, arrived, alreadyFlagged,
}: {
  participantId: string
  members: OnlineMember[]
  arrived: Set<string>
  alreadyFlagged: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [href, setHref] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const flagged = alreadyFlagged || pressed

  // Build the mailto from the LIVE member/arrival data the screen already has + the two facts the
  // server returns (group number + instructor email). Names are the student-facing display names.
  const buildHref = (groupNumber: number, instructorEmail: string | null): string => {
    const nameOf = (m: OnlineMember) => (m.participant_id === participantId ? `${m.display_name} (me)` : m.display_name)
    const here = members.filter(m => m.participant_id === participantId || arrived.has(m.participant_id))
    const notHere = members.filter(m => m.participant_id !== participantId && !arrived.has(m.participant_id))
    const cc = members.filter(m => m.participant_id !== participantId && m.email).map(m => m.email as string).join(',')
    const subject = `Crisis game — Group ${groupNumber}: I can't reach my group`
    const body = [
      `I'm in Crisis Group ${groupNumber} and I'm having trouble reaching my group to schedule our game.`,
      '',
      here.length ? `Here so far: ${here.map(nameOf).join(', ')}` : '',
      notHere.length
        ? `Not here yet: ${notHere.map(m => m.display_name).join(', ')}`
        : 'Everyone appears to be here, but we have not been able to coordinate a time.',
      '',
      '(Add any details here.)',
    ].filter(line => line !== '').join('\n')
    const to = instructorEmail ?? ''
    return `mailto:${encodeURIComponent(to)}?cc=${encodeURIComponent(cc)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  const openMailto = (url: string) => {
    // Native open (no page navigation for a mailto:) via a transient anchor — headless-safe.
    const a = document.createElement('a')
    a.href = url
    a.rel = 'noopener'
    a.click()
  }

  const press = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await flagGroup() // writes the flag if absent (idempotent), returns mailto facts
      const url = buildHref(r.group_number, r.instructor_email)
      setHref(url); setPressed(true)
      openMailto(url)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not flag your group.')
    }
    setBusy(false)
  }

  return (
    <div style={{ marginTop: spacing.gapLg, paddingTop: spacing.gapMd, borderTop: `1px solid ${colors.borderFaint}` }}>
      {!flagged ? (
        <button data-testid="crisis-flag-btn" onClick={press} disabled={busy} style={{
          padding: '0.45rem 0.9rem', fontWeight: 600, cursor: busy ? 'wait' : 'pointer', borderRadius: 6,
          border: `1px solid ${colors.borderMid}`, background: colors.white, color: colors.textStrong,
        }}>
          {busy ? 'Notifying…' : "I can't reach my group"}
        </button>
      ) : (
        <div data-testid="crisis-flag-status" style={{ fontSize: typography.sizeSm, color: colors.textSecondary }}>
          <span style={{ color: '#b45309', fontWeight: 700 }}>⚑ Flagged</span> — your instructor has been notified. Keep this tab open; you can start the moment everyone is here.
          <div style={{ marginTop: spacing.gapSm }}>
            {href ? (
              <a data-testid="crisis-flag-mailto" href={href} onClick={() => href && openMailto(href)} style={{ color: '#D38626', fontWeight: 600, textDecoration: 'none' }}>Reopen the email draft</a>
            ) : (
              <button data-testid="crisis-flag-reopen" onClick={press} disabled={busy} style={{ fontSize: typography.sizeXs, cursor: 'pointer' }}>Reopen the email draft</button>
            )}
          </div>
        </div>
      )}
      {err && <p data-testid="crisis-flag-error" role="alert" style={{ color: '#b91c1c', fontSize: typography.sizeXs, marginTop: spacing.gapSm }}>{err}</p>}
    </div>
  )
}

function HistorySection({ history, viewerRole }: { history: import('../api').RoundRecord[]; viewerRole?: import('../api').Role }) {
  return (
    <section style={{ marginTop: spacing.gapXl }}>
      <h2 style={{ fontSize: '1.05rem' }}>History — everyone sees the same table</h2>
      <HistoryTable history={history} viewerRole={viewerRole} />
    </section>
  )
}

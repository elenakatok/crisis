import { useEffect, useRef, useState } from 'react'
import { colors, typography, spacing } from '@mygames/game-ui'
import { getCrisisDashboard, openRound, type DashboardGroup } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// CrisisLivePanel — the §4A instructor WINDOW (Slice 4). Read-only: it SHOWS which
// round each group is on, the current stage, and WHICH SEAT the stage is waiting on
// ("who is holding it up") — plus timeout counts (§3.3) and whether a crisis occurred.
//
// NOT a control. The ONLY buttons are the instructor's endorsed LAUNCHER action
// ("Start game" = openRound) — no extend-timer, no attention checks, no liveness (all
// rejected by the spec). Bots are already filtered out server-side (§5.3). Renders
// sensibly whether the clock is ON (countdown) or OFF (no clock UI at all, §3.1).
// ═══════════════════════════════════════════════════════════════════════════════

const STAGE_LABEL: Record<string, string> = { bidding: 'Bidding', allocation: 'Allocation', fixing: 'Fix decision' }
const ROLE_LABEL: Record<string, string> = { buyer: 'Buyer', seller1: 'Seller 1', seller2: 'Seller 2' }
const POLL_MS = 2000

const card: React.CSSProperties = { border: `1px solid ${colors.borderLight}`, borderRadius: 6, padding: '0.75rem 1rem', minWidth: 260 }
const label: React.CSSProperties = { color: colors.textSecondary, fontSize: '0.8rem' }

function Countdown({ deadlineMs }: { deadlineMs: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (deadlineMs === null) return; const id = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(id) }, [deadlineMs])
  if (deadlineMs === null) return null // clock OFF → no clock UI (§3.1)
  const s = Math.max(0, Math.ceil((deadlineMs - now) / 1000))
  return <span data-testid="dash-clock" style={{ fontVariantNumeric: 'tabular-nums', color: s <= 30 ? '#b91c1c' : colors.textSecondary }}>⏱ {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

export default function CrisisLivePanel() {
  const [groups, setGroups] = useState<DashboardGroup[] | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const cancelled = useRef(false)

  const poll = async () => {
    try { const r = await getCrisisDashboard(); if (!cancelled.current) setGroups(r.groups) } catch { /* auth not ready yet / transient */ }
  }
  useEffect(() => {
    cancelled.current = false
    void poll()
    const id = setInterval(() => void poll(), POLL_MS)
    return () => { cancelled.current = true; clearInterval(id) }
  }, [])

  const start = async (groupId: string) => {
    setStarting(groupId)
    try { await openRound(groupId); await poll() } catch { /* surfaced on next poll */ }
    setStarting(null)
  }

  if (groups === null) return <section style={{ margin: `${spacing.gapMd} 0`, fontFamily: typography.fontFamily, color: colors.textSecondary }}>Loading live view…</section>
  if (groups.length === 0) return null

  return (
    <section data-testid="crisis-live-panel" style={{ margin: `${spacing.gapMd} 0`, fontFamily: typography.fontFamily }}>
      <h2 style={{ fontSize: '1.05rem', margin: `0 0 ${spacing.gapSm}` }}>Live view</h2>
      <p style={{ ...label, marginTop: 0 }}>A window, not a control — it shows where each group is and who the stage is waiting on. (Bots are hidden.)</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacing.gapMd }}>
        {groups.map((g) => (
          <div key={g.groupId} data-testid={`dash-group-${g.groupNumber}`} style={card}>
            <div style={{ fontWeight: 700, marginBottom: spacing.gapSm }}>Group {g.groupNumber}</div>

            {g.status === 'not_started' && (
              <div>
                <div style={label}>Not started</div>
                {g.startable && (
                  <button data-testid={`dash-start-${g.groupNumber}`} style={{ marginTop: spacing.gapSm }} disabled={starting === g.groupId} onClick={() => start(g.groupId)}>
                    {starting === g.groupId ? 'Starting…' : 'Start game'}
                  </button>
                )}
              </div>
            )}

            {g.status === 'in_progress' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.gapTiny }}>
                <div><strong data-testid={`dash-round-${g.groupNumber}`}>Round {g.round} of {g.numRounds}</strong> · <span data-testid={`dash-stage-${g.groupNumber}`}>{STAGE_LABEL[g.stage!]}</span></div>
                {g.crisisOccurred === true && <div data-testid={`dash-crisis-${g.groupNumber}`} style={{ color: '#b45309', fontWeight: 600 }}>⚠ Crisis this round</div>}
                <Countdown deadlineMs={g.stageDeadlineMs} />
                <div data-testid={`dash-waiting-${g.groupNumber}`}>
                  <span style={label}>Waiting on: </span>
                  {g.waitingOn.length === 0
                    ? <span style={label}>resolving…</span>
                    : g.waitingOn.map((w, i) => <span key={i}>{i > 0 ? ', ' : ''}<strong>{ROLE_LABEL[w.role ?? ''] ?? w.role}</strong>{w.name ? ` (${w.name})` : ''}</span>)}
                </div>
                <SeatTimeouts group={g} />
              </div>
            )}

            {g.status === 'finished' && (
              <div>
                <div data-testid={`dash-finished-${g.groupNumber}`} style={{ fontWeight: 600 }}>Finished — {g.numRounds} rounds</div>
                <SeatTimeouts group={g} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function SeatTimeouts({ group }: { group: DashboardGroup }) {
  if (group.seats.length === 0) return null
  return (
    <div data-testid={`dash-timeouts-${group.groupNumber}`} style={{ marginTop: spacing.gapSm, fontSize: '0.8rem', color: colors.textSecondary }}>
      {group.seats.map((s) => (
        <div key={s.seat}>
          {ROLE_LABEL[s.role ?? ''] ?? s.role}{s.name ? ` (${s.name})` : ''}: {s.timeoutCount} timeout{s.timeoutCount === 1 ? '' : 's'}
        </div>
      ))}
    </div>
  )
}

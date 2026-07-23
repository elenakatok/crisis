import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { colors, typography, spacing } from '@mygames/game-ui'
import { getCrisisDashboard, type DashboardGroup } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// The main-dashboard SUMMARY panel — UNIFORM with SAA's StartAuctionBox. Portaled as
// the FIRST child of the shared dashboard's <main>, so it sits directly under the button
// bar and ABOVE the "Instructor Dashboard — Crisis" heading. Grey/subtle, full width. It
// lists each group's one-line status, with a top-right orange inline "Live view →" link
// (same-window nav) — NOT a button, NOT at the bottom. Bots stay hidden (§5.3).
// ═══════════════════════════════════════════════════════════════════════════════

const STAGE = { bidding: 'bidding', allocation: 'allocation', fixing: 'fix decision' } as const

function line(g: DashboardGroup): string {
  if (g.status === 'finished') return `finished — ${g.numRounds} rounds`
  if (g.status === 'not_started') return 'not started'
  const waiting = g.waitingOn.length
    ? ` · waiting on ${g.waitingOn.map(w => (w.role === 'buyer' ? 'Buyer' : w.role === 'seller1' ? 'Seller 1' : 'Seller 2')).join(', ')}`
    : ''
  return `Round ${g.round} of ${g.numRounds} · ${STAGE[g.stage!]}${waiting}`
}

export default function CrisisLiveSummary() {
  const [groups, setGroups] = useState<DashboardGroup[]>([])
  const [host, setHost] = useState<HTMLElement | null>(null)

  // Host node as the FIRST child of the shared dashboard's <main> (SAA/eBay pattern).
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const node = document.createElement('div')
    node.setAttribute('data-crisis-summary-host', '')
    main.insertBefore(node, main.firstChild)
    setHost(node)
    return () => { node.remove(); setHost(null) }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = () => getCrisisDashboard().then(r => { if (alive && r.ok) setGroups(r.groups) }).catch(() => {})
    tick()
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!host) return null

  return createPortal(
    <div data-testid="crisis-live-summary" style={{ margin: '0 0 1.5rem', padding: '0.75rem 1rem', border: `1px solid ${colors.borderMid}`, borderRadius: 8, background: colors.surfaceSubtle }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.gapSm }}>
        <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>Live view</span>
        <a data-testid="crisis-live-nav" href={`/live${window.location.search}`} style={{ color: '#D38626', fontWeight: 700, fontSize: typography.sizeSm, textDecoration: 'none' }}>
          Live view →
        </a>
      </div>

      {groups.length === 0 ? (
        <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary }}>Match students into groups to begin.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.gapSm }}>
          {groups.map((g) => (
            <div key={g.groupId} data-testid={`crisis-summary-row-${g.groupNumber}`} style={{ display: 'flex', alignItems: 'center', gap: spacing.gapBtn, paddingBottom: '0.4rem', borderBottom: `1px solid ${colors.borderFaint}` }}>
              <span style={{ minWidth: 70, fontWeight: 600 }}>Group {g.groupNumber}</span>
              <span style={{ fontSize: typography.sizeSm, color: g.status === 'in_progress' ? colors.successText : colors.textSecondary }}>
                {g.status === 'in_progress' && '● '}{line(g)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>,
    host,
  )
}

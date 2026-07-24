import type { RoundRecord, Role } from '../api'
import { colors, typography } from '@mygames/game-ui'

// The shared history table (§1.2 step 5) — SAME data + layout for EVERY seat, no private info.
// One row per completed round, matching the deck exactly:
//   Period · Bid 1 · Alloc 1 · Fix 1? · Profit 1 · Bid 2 · Alloc 2 · Fix 2? · Profit 2 · Buyer's Profit
// A crisis is shown the deck's way — a "—" in a Fix column means no crisis that round.
//
// The ONLY per-viewer difference (§O2 step 6b): the viewer's own columns get a "(you)" header
// marker and a light shade, so a player can find themselves at a glance. Data is identical.

const th: React.CSSProperties = { padding: '0.25rem 0.4rem', textAlign: 'right', fontWeight: 600, borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '0.25rem 0.4rem', textAlign: 'right', borderBottom: `1px solid ${colors.borderLight}`, whiteSpace: 'nowrap' }
const yn = (b: boolean) => (b ? 'Yes' : 'No')
const fixCell = (crisis: boolean, fixed: boolean) => (crisis ? yn(fixed) : '—')
const mineShade = { background: colors.confirmBg }

export default function HistoryTable({ history, viewerRole }: { history: RoundRecord[]; viewerRole?: Role }) {
  if (history.length === 0) {
    return <p style={{ color: colors.textSecondary }}>No completed rounds yet.</p>
  }
  const s1Mine = viewerRole === 'seller1'
  const s2Mine = viewerRole === 'seller2'
  const bMine  = viewerRole === 'buyer'
  const thMine = (mine: boolean) => (mine ? { ...th, ...mineShade } : th)
  const tdMine = (mine: boolean) => (mine ? { ...td, ...mineShade } : td)
  const you = (mine: boolean) => (mine ? ' (you)' : '')

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table data-testid="crisis-history" style={{ borderCollapse: 'collapse', fontSize: '0.8rem', fontFamily: typography.fontFamily, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Period</th>
            <th style={thMine(s1Mine)}>Bid 1{you(s1Mine)}</th><th style={thMine(s1Mine)}>Alloc 1{you(s1Mine)}</th><th style={thMine(s1Mine)}>Fix 1?{you(s1Mine)}</th><th style={thMine(s1Mine)}>Profit 1{you(s1Mine)}</th>
            <th style={thMine(s2Mine)}>Bid 2{you(s2Mine)}</th><th style={thMine(s2Mine)}>Alloc 2{you(s2Mine)}</th><th style={thMine(s2Mine)}>Fix 2?{you(s2Mine)}</th><th style={thMine(s2Mine)}>Profit 2{you(s2Mine)}</th>
            <th style={thMine(bMine)}>Buyer&apos;s Profit{you(bMine)}</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.round} data-testid={`crisis-history-row-${h.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{h.round}</td>
              <td style={tdMine(s1Mine)}>{h.bids.s1}</td>
              <td style={tdMine(s1Mine)}>{h.allocation.a1}</td>
              <td style={tdMine(s1Mine)}>{fixCell(h.crisisOccurred, h.fixed.s1)}</td>
              <td style={tdMine(s1Mine)}>{h.profits.seller1.toLocaleString('en-US')}</td>
              <td style={tdMine(s2Mine)}>{h.bids.s2}</td>
              <td style={tdMine(s2Mine)}>{h.allocation.a2}</td>
              <td style={tdMine(s2Mine)}>{fixCell(h.crisisOccurred, h.fixed.s2)}</td>
              <td style={tdMine(s2Mine)}>{h.profits.seller2.toLocaleString('en-US')}</td>
              <td data-testid={`crisis-buyer-profit-${h.round}`} style={tdMine(bMine)}>{h.profits.buyer.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '0.75rem', color: colors.textSecondary, margin: '0.3rem 0 0' }}>
        A dash (—) in a Fix column means no crisis occurred that round.{viewerRole ? ' Your columns are highlighted.' : ''}
      </p>
    </div>
  )
}

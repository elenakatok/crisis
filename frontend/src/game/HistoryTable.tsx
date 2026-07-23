import type { RoundRecord } from '../api'
import { colors, typography } from '@mygames/game-ui'

// The shared history table (§1.2 step 5) — identical for every seat, no private info.
// One row per completed round, matching the deck: Period · Bid 1 · Alloc 1 · Fix? ·
// Profit 1 · Bid 2 · Alloc 2 · Fix? · Profit 2 · Buyer's Profit.

const th: React.CSSProperties = { padding: '0.35rem 0.5rem', textAlign: 'right', fontWeight: 600, borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '0.3rem 0.5rem', textAlign: 'right', borderBottom: `1px solid ${colors.borderLight}`, whiteSpace: 'nowrap' }
const yn = (b: boolean) => (b ? 'Yes' : 'No')

export default function HistoryTable({ history }: { history: RoundRecord[] }) {
  if (history.length === 0) {
    return <p style={{ color: colors.textSecondary }}>No completed rounds yet.</p>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-testid="crisis-history" style={{ borderCollapse: 'collapse', fontSize: '0.85rem', fontFamily: typography.fontFamily, minWidth: 640 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Period</th>
            <th style={th}>Bid 1</th><th style={th}>Alloc 1</th><th style={th}>Fix 1?</th><th style={th}>Profit 1</th>
            <th style={th}>Bid 2</th><th style={th}>Alloc 2</th><th style={th}>Fix 2?</th><th style={th}>Profit 2</th>
            <th style={th}>Crisis?</th><th style={th}>Buyer Profit</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.round} data-testid={`crisis-history-row-${h.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{h.round}</td>
              <td style={td}>{h.bids.s1}</td>
              <td style={td}>{h.allocation.a1}</td>
              <td style={td}>{h.crisisOccurred ? yn(h.fixed.s1) : '—'}</td>
              <td style={td}>{h.profits.seller1.toLocaleString('en-US')}</td>
              <td style={td}>{h.bids.s2}</td>
              <td style={td}>{h.allocation.a2}</td>
              <td style={td}>{h.crisisOccurred ? yn(h.fixed.s2) : '—'}</td>
              <td style={td}>{h.profits.seller2.toLocaleString('en-US')}</td>
              <td style={td}>{h.crisisOccurred ? 'Yes' : 'No'}</td>
              <td style={td}>{h.profits.buyer.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

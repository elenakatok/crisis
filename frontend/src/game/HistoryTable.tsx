import type { RoundRecord, Role } from '../api'
import { colors, typography } from '@mygames/game-ui'

// The shared history table (§1.2 step 5) — SAME data + layout for EVERY seat, no private info.
// One row per completed round, matching the deck exactly:
//   Period · Bid · Alloc · Fix? · Profit  (Seller 1) · Bid · Alloc · Fix? · Profit (Seller 2) · Profit (Buyer)
// A crisis is shown the deck's way — a "—" in a Fix column means no crisis that round.
//
// The ONLY per-viewer difference (§O2.1 step 5): a GROUPED header row labels each role's block;
// the viewer's own block reads "You (Seller 1)" etc. and is lightly shaded (header + body). The
// data cells are identical for everyone. The grouped header drops the per-column "1"/"2" suffixes,
// so the table is narrower than a flat header — no width regression.

const th: React.CSSProperties = { padding: '0.25rem 0.4rem', textAlign: 'right', fontWeight: 600, borderBottom: `2px solid ${colors.borderLight}`, whiteSpace: 'nowrap' }
const td: React.CSSProperties = { padding: '0.25rem 0.4rem', textAlign: 'right', borderBottom: `1px solid ${colors.borderLight}`, whiteSpace: 'nowrap' }
const yn = (b: boolean) => (b ? 'Yes' : 'No')
const fixCell = (crisis: boolean, fixed: boolean) => (crisis ? yn(fixed) : '—')
const mineShade = { background: colors.confirmBg }
const blockSep = { borderLeft: `2px solid ${colors.borderMid}` }

export default function HistoryTable({ history, viewerRole }: { history: RoundRecord[]; viewerRole?: Role }) {
  if (history.length === 0) {
    return <p style={{ color: colors.textSecondary }}>No completed rounds yet.</p>
  }
  const s1Mine = viewerRole === 'seller1'
  const s2Mine = viewerRole === 'seller2'
  const bMine  = viewerRole === 'buyer'
  const shade = (mine: boolean, extra?: React.CSSProperties) => ({ ...(mine ? mineShade : undefined), ...extra })
  const blockLabel = (mine: boolean, role: string) => (mine ? `You (${role})` : role)

  return (
    <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table data-testid="crisis-history" style={{ borderCollapse: 'collapse', fontSize: '0.8rem', fontFamily: typography.fontFamily, width: '100%' }}>
        <thead>
          {/* Row 1 — role block labels; the viewer's own block reads "You (…)". */}
          <tr>
            <th rowSpan={2} style={{ ...th, textAlign: 'left' }}>Period</th>
            <th colSpan={4} data-testid="crisis-hist-block-seller1" style={{ ...th, textAlign: 'center', ...shade(s1Mine, blockSep) }}>{blockLabel(s1Mine, 'Seller 1')}</th>
            <th colSpan={4} data-testid="crisis-hist-block-seller2" style={{ ...th, textAlign: 'center', ...shade(s2Mine, blockSep) }}>{blockLabel(s2Mine, 'Seller 2')}</th>
            <th colSpan={1} data-testid="crisis-hist-block-buyer" style={{ ...th, textAlign: 'center', ...shade(bMine, blockSep) }}>{blockLabel(bMine, 'Buyer')}</th>
          </tr>
          {/* Row 2 — plain sub-labels, no suffixes. */}
          <tr>
            <th style={shade(s1Mine, { ...th, ...blockSep })}>Bid</th><th style={shade(s1Mine, th)}>Alloc</th><th style={shade(s1Mine, th)}>Fix?</th><th style={shade(s1Mine, th)}>Profit</th>
            <th style={shade(s2Mine, { ...th, ...blockSep })}>Bid</th><th style={shade(s2Mine, th)}>Alloc</th><th style={shade(s2Mine, th)}>Fix?</th><th style={shade(s2Mine, th)}>Profit</th>
            <th style={shade(bMine, { ...th, ...blockSep })}>Profit</th>
          </tr>
        </thead>
        <tbody>
          {history.map((h) => (
            <tr key={h.round} data-testid={`crisis-history-row-${h.round}`}>
              <td style={{ ...td, textAlign: 'left' }}>{h.round}</td>
              <td style={shade(s1Mine, { ...td, ...blockSep })}>{h.bids.s1}</td>
              <td style={shade(s1Mine, td)}>{h.allocation.a1}</td>
              <td style={shade(s1Mine, td)}>{fixCell(h.crisisOccurred, h.fixed.s1)}</td>
              <td style={shade(s1Mine, td)}>{h.profits.seller1.toLocaleString('en-US')}</td>
              <td style={shade(s2Mine, { ...td, ...blockSep })}>{h.bids.s2}</td>
              <td style={shade(s2Mine, td)}>{h.allocation.a2}</td>
              <td style={shade(s2Mine, td)}>{fixCell(h.crisisOccurred, h.fixed.s2)}</td>
              <td style={shade(s2Mine, td)}>{h.profits.seller2.toLocaleString('en-US')}</td>
              <td data-testid={`crisis-buyer-profit-${h.round}`} style={shade(bMine, { ...td, ...blockSep })}>{h.profits.buyer.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '0.75rem', color: colors.textSecondary, margin: '0.3rem 0 0' }}>
        A dash (—) in a Fix column means no crisis occurred that round.{viewerRole ? ' Your block is highlighted.' : ''}
      </p>
    </div>
  )
}

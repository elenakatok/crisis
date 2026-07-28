import { HistoryTable as SharedHistoryTable, col, group, sub, num, conditionalYesNo, colors } from '@mygames/game-ui'
import type { RoundRecord, Role } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// The shared history table (§1.2 step 5), now COLUMNS AS DATA on the Slice-3
// @mygames/game-ui widget. Same table, same copy, same shading — what changed is
// that the five style constants, the grouped-header markup and the overflow wrapper
// are no longer hand-written here.
//
//   Period · Bid · Alloc · Fix? · Profit (Seller 1) · … (Seller 2) · Profit (Buyer)
//
// The ONLY per-viewer difference (§O2.1 step 5) is unchanged: the viewer's own block
// header reads "You (Seller 1)" and is lightly shaded. The data cells are identical
// for everyone — Crisis has no private information in history (§1.1).
//
// ⚠ THE REVEAL CONTRACT (§3.5.2). game-ui does not depend on stage-engine at
// runtime, so a game that hands over unfiltered data gets it faithfully rendered.
// Crisis discharges the contract SERVER-SIDE: `history` arrives from getRoundView,
// which builds it through the engine's `buildSeatView` — so the reveal has already
// been applied and the in-flight round is not in the array at all. The rows below
// are exactly what that seat may see, and the harness asserts it on the wire rather
// than trusting this comment.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n: number) => num(n)

/** The three role blocks, with the viewer's marked `mine`. */
function sections(viewerRole?: Role) {
  return [
    col<RoundRecord>('round', 'Period', (h) => h.round, { align: 'left' }),
    group<RoundRecord>('seller1', 'Seller 1', [
      sub('bid1', 'Bid', (h) => h.bids.s1),
      sub('alloc1', 'Alloc', (h) => h.allocation.a1),
      sub('fix1', 'Fix?', (h) => conditionalYesNo(h.crisisOccurred, h.fixed.s1)),
      sub('profit1', 'Profit', (h) => money(h.profits.seller1)),
    ], { mine: viewerRole === 'seller1' }),
    group<RoundRecord>('seller2', 'Seller 2', [
      sub('bid2', 'Bid', (h) => h.bids.s2),
      sub('alloc2', 'Alloc', (h) => h.allocation.a2),
      sub('fix2', 'Fix?', (h) => conditionalYesNo(h.crisisOccurred, h.fixed.s2)),
      sub('profit2', 'Profit', (h) => money(h.profits.seller2)),
    ], { mine: viewerRole === 'seller2' }),
    group<RoundRecord>('buyer', 'Buyer', [
      // The harness reads this cell by name, so the per-row test id is preserved.
      sub('profitB', 'Profit', (h) => money(h.profits.buyer), {
        testId: (h) => `crisis-buyer-profit-${h.round}`,
      }),
    ], { mine: viewerRole === 'buyer' }),
  ]
}

export default function HistoryTable({ history, viewerRole }: { history: RoundRecord[]; viewerRole?: Role }) {
  return (
    <SharedHistoryTable<RoundRecord>
      rows={history}
      sections={sections(viewerRole)}
      testId="crisis-history"
      rowKey={(h) => h.round}
      rowTestId={(h) => `crisis-history-row-${h.round}`}
      emptyMessage="No completed rounds yet."
      caption={
        <span style={{ color: colors.textSecondary }}>
          A dash (—) in a Fix column means no crisis occurred that round.
          {viewerRole ? ' Your block is highlighted.' : ''}
        </span>
      }
    />
  )
}

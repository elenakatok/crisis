import { Link, useSearchParams } from 'react-router-dom'

/**
 * Reports — Slice 0 PLACEHOLDER. The real instructor report (participation, KC, and the
 * per-round history of bids / allocations / fix decisions / profits) is Slice 7. The
 * server callable `getReportData` already returns participation + KC rows (scaffold
 * version), but no report table is rendered yet. This page keeps the dashboard's
 * "Reports" link valid during the scaffold phase.
 */
export default function Reports() {
  const [searchParams] = useSearchParams()
  const qs = searchParams.toString()
  const dashHref = qs ? `/dashboard?${qs}` : '/dashboard'

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 640, margin: '2rem auto' }}>
      <h1 style={{ marginTop: 0 }}>Reports</h1>
      <p style={{ lineHeight: 1.6, color: '#444' }}>
        The Crisis instructor report is built in a later release. It will show each
        student&apos;s participation and knowledge-check score alongside the round-by-round
        history of bids, allocations, fix decisions, and profits.
      </p>
      <p style={{ marginTop: '1.5rem' }}>
        <Link to={dashHref}>← Back to dashboard</Link>
      </p>
    </main>
  )
}

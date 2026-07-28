import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import { GameHeader, ReportBoard, RosterReport, type ReportTileConfig, type SortableColumn } from '@mygames/game-ui'
import { getCrisisReport, getOnlineReport, type CrisisReport, type ReportStudentRow, type OnlineReport, type OnlineReportStudent } from '../api'
import AllocationsChart from './AllocationsChart'

// Crisis debrief reports (Slice 7) — read-only, from the frozen finished state; bots
// excluded entirely (bot-filled groups are omitted). Look/feel uniform with SAA's Reports:
// GameHeader + "← Dashboard" + a ReportBoard of tiles that open modals. No slide export,
// no commentary field.

const money = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(0)}%`)
const one = (n: number | null) => (n === null ? '—' : n.toFixed(1))

// ── Modal shell (local — matches the SAA/eBay/Spectrum reports pattern) ──────────────
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3rem 1rem', zIndex: 1000, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', width: '100%', maxWidth: wide ? 'min(1100px, calc(100vw - 2rem))' : 'min(900px, calc(100vw - 2rem))', boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

const botTag = <span title="Machine-played seat" style={{ marginLeft: 5, fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: '#b45309', borderRadius: 3, padding: '0 4px', verticalAlign: 'middle' }}>BOT</span>

const th: React.CSSProperties = { textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', background: '#faf7f2' }
const td: React.CSSProperties = { padding: '0.4rem 0.7rem', borderBottom: '1px solid #eee', fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums' }

// ── Figure grid (class headline SUMS) ───────────────────────────────────────────────
function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: '0.75rem 1rem', minWidth: 170 }}>
      <div style={{ fontSize: '0.75rem', color: '#666' }}>{label}</div>
      <div style={{ fontSize: '1.4rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {note && <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>{note}</div>}
    </div>
  )
}

// ── Tier 1a per-student roster (Report 3) — the SHARED widget ──────────────────────
// Migrated to @mygames/game-ui's RosterReport in Slice 5a. The hand-rolled sort (a
// useMemo comparator plus click-to-toggle headers) is gone; SortableTable supplies it,
// along with nulls-last handling this table used to do by hand.
//
// ⚠ PARITY. Every visible detail is preserved through the widget's Slice-5a props:
// the test ids the harness reads (`crisis-student-table`, `student-row-<pid>`), the
// header/cell density, Crisis's own `· bots` marker rather than the shared BOT badge,
// and no shared legend (Crisis has its own footnote below the table).
type SortKey = 'name' | 'groupNumber' | 'role' | 'averageBid' | 'proportionFixed' | 'averageAllocation' | 'timeouts' | 'profit'

/** Crisis's report row, in the shape RosterReport requires. */
type RosterRow = ReportStudentRow & { rawScore: number | null }

const CRISIS_TH: React.CSSProperties = {
  textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd',
  fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', background: '#faf7f2',
}
const CRISIS_TD: React.CSSProperties = {
  padding: '0.4rem 0.7rem', borderBottom: '1px solid #eee',
  fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums',
}

/** Ascending comparator with nulls last, matching the previous hand-rolled sort. */
const byNum = (get: (r: RosterRow) => number | null) => (a: RosterRow, b: RosterRow) =>
  (get(a) ?? 0) - (get(b) ?? 0)
const nullish = (get: (r: RosterRow) => number | null) => (r: RosterRow) => get(r) === null

function StudentTable({ rows }: { rows: ReportStudentRow[] }) {
  const roster: RosterRow[] = rows.map(r => ({ ...r, rawScore: null }))

  const columns: SortableColumn<RosterRow, SortKey>[] = [
    {
      key: 'name', label: 'Name', headerStyle: CRISIS_TH,
      compare: (a, b) => a.name.localeCompare(b.name),
      render: r => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {r.name}
          {/* Crisis's own marker, deliberately NOT the shared BOT badge — that is
              instructor-visible copy and changing it would not be parity. */}
          {r.botGroup && (
            <span title="Played in a bot-filled group — the other seats were bots"
              style={{ marginLeft: 5, fontSize: '0.68rem', fontWeight: 600, color: '#b45309' }}>· bots</span>
          )}
        </span>
      ),
    },
    { key: 'groupNumber', label: 'Group', headerStyle: CRISIS_TH, compare: (a, b) => a.groupNumber - b.groupNumber, render: r => r.groupNumber },
    { key: 'role', label: 'Role', headerStyle: CRISIS_TH, compare: (a, b) => a.role.localeCompare(b.role), render: r => <span style={{ whiteSpace: 'nowrap' }}>{r.role}</span> },
    {
      key: 'averageBid', label: 'Average bid', headerStyle: CRISIS_TH,
      compare: byNum(r => r.averageBid), render: r => <>{one(r.averageBid)}{r.role === 'Buyer' ? ' *' : ''}</>,
    },
    {
      key: 'proportionFixed', label: 'Proportion fixed', headerStyle: CRISIS_TH,
      compare: byNum(r => r.proportionFixed), nullsLast: true, isNull: nullish(r => r.proportionFixed),
      render: r => pct(r.proportionFixed),
    },
    {
      key: 'averageAllocation', label: 'Average allocation', headerStyle: CRISIS_TH,
      compare: byNum(r => r.averageAllocation), nullsLast: true, isNull: nullish(r => r.averageAllocation),
      render: r => (r.averageAllocation === null ? '—' : one(r.averageAllocation)),
    },
    {
      key: 'timeouts', label: 'Stages missed', headerStyle: CRISIS_TH,
      compare: byNum(r => r.timeouts),
      render: r => <span style={{ color: r.timeouts > 0 ? '#b45309' : undefined, fontWeight: r.timeouts > 0 ? 600 : undefined }}>{r.timeouts}</span>,
    },
    { key: 'profit', label: 'Profit', headerStyle: CRISIS_TH, compare: byNum(r => r.profit), render: r => money(r.profit) },
  ]

  return (
    <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
      <RosterReport<RosterRow, SortKey>
        rows={roster}
        columns={columns}
        initialSortKey="groupNumber"
        // Crisis carries its own footnote below; the shared legend would be new copy.
        showLegend={false}
        testIds={{
          root: 'crisis-student-table-root',
          table: 'crisis-student-table',
          row: r => `student-row-${r.participantId}`,
        }}
        cellStyles={{ header: CRISIS_TH, cell: CRISIS_TD }}
      />
      <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0.4rem 0.7rem' }}>
        * The Buyer&apos;s &ldquo;average bid&rdquo; is the allocation-weighted average price they paid.
        {rows.some(r => r.timeouts > 0) && <> · <span style={{ color: '#b45309' }}>Timeouts</span> = stages the seat missed; those decisions were filled by default, so a &ldquo;proportion fixed&rdquo; with many timeouts is an artifact, not a strategy.</>}
        {rows.some(r => r.botGroup) && <> · <span style={{ color: '#b45309' }}>· bots</span> = played in a bot-filled group (the other seats were bots); their figures are their own.</>}
      </p>
    </div>
  )
}

// ── Assignment-status table (Slice O3) — the "who do I email / how do I grade" view ──────
const catLabel: Record<OnlineReportStudent['category'], string> = {
  finished: 'Finished', in_progress: 'Mid-game', never_started: 'Not started', no_group: 'No group',
}
type StatusSortKey = 'name' | 'groupNumber' | 'category' | 'arrived' | 'lastLoginMs' | 'flagged' | 'playedWithBots' | 'timeouts'
function OnlineStatusTable({ rows }: { rows: OnlineReportStudent[] }) {
  const [key, setKey] = useState<StatusSortKey>('groupNumber')
  const [dir, setDir] = useState<1 | -1>(1)
  const sorted = useMemo(() => {
    const num = (r: OnlineReportStudent): number | string => {
      switch (key) {
        case 'name': return r.name
        case 'groupNumber': return r.groupNumber ?? Infinity
        case 'category': return r.category
        case 'arrived': return r.arrived ? 1 : 0
        case 'lastLoginMs': return r.lastLoginMs ?? -1
        case 'flagged': return r.flagged ? 1 : 0
        case 'playedWithBots': return r.playedWithBots ? 1 : 0
        case 'timeouts': return r.timeouts
      }
    }
    const cmp = (a: OnlineReportStudent, b: OnlineReportStudent) => {
      const av = num(a), bv = num(b)
      const r = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number)
      return r !== 0 ? r * dir : a.name.localeCompare(b.name)
    }
    return [...rows].sort(cmp)
  }, [rows, key, dir])
  const head = (k: StatusSortKey, label: string) => (
    <th style={{ ...th, cursor: 'pointer' }} data-testid={`ocol-${k}`} onClick={() => { if (k === key) setDir(d => (d === 1 ? -1 : 1)); else { setKey(k); setDir(1) } }}>
      {label}{k === key ? (dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  )
  const loginText = (ms: number | null) => (ms === null ? 'never' : new Date(ms).toLocaleString())
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
      <table data-testid="crisis-status-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>
          {head('name', 'Name')}{head('groupNumber', 'Group')}{head('category', 'Status')}
          {head('arrived', 'Arrived')}{head('lastLoginMs', 'Last login')}{head('flagged', 'Flagged')}
          {head('playedWithBots', 'Bots')}{head('timeouts', 'Stages missed')}
        </tr></thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.participantId} data-testid={`status-row-${r.participantId}`}
              data-category={r.category} data-arrived={r.arrived ? '1' : '0'} data-flagged={r.flagged ? '1' : '0'} data-bots={r.playedWithBots ? '1' : '0'}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.name}</td>
              <td style={td}>{r.groupNumber ?? '—'}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{catLabel[r.category]}{r.category === 'finished' && r.rounds != null ? ` · ${r.rounds} rounds` : ''}</td>
              <td style={{ ...td, color: r.arrived ? '#15803d' : '#b45309' }}>{r.arrived ? '✓' : '—'}</td>
              <td style={{ ...td, whiteSpace: 'nowrap', color: r.lastLoginMs === null ? '#b45309' : undefined }}>{loginText(r.lastLoginMs)}</td>
              <td style={td}>{r.flagged ? <span style={{ color: '#b45309', fontWeight: 700 }}>⚑</span> : ''}</td>
              <td style={td}>{r.playedWithBots ? <span title="Played in a bot-filled group" style={{ fontSize: '0.68rem', fontWeight: 600, color: '#b45309' }}>bots</span> : ''}</td>
              <td style={{ ...td, color: r.timeouts > 0 ? '#b45309' : undefined, fontWeight: r.timeouts > 0 ? 600 : undefined }}>{r.timeouts}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0.4rem 0.7rem' }}>
        The <span style={{ color: '#b45309' }}>⚑ flag</span> is a pre-play &ldquo;can&rsquo;t reach my group&rdquo; report; <span style={{ color: '#b45309' }}>Stages missed</span> is absence during play. Grading is participation-only — this view is for reaching out, not a grade.
      </p>
    </div>
  )
}

type ReportKind = 'class' | 'group' | 'students' | 'online'

export default function Reports() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const devGid = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null
  const tokenParam = searchParams.get('token')
  const gidParam = searchParams.get('game_instance_id')
  const makeLink = (base: string) =>
    devGid ? `${base}?_dev_game_instance_id=${encodeURIComponent(devGid)}`
      : (tokenParam && gidParam) ? `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gidParam)}` : base

  // ── auth bootstrap (mirrors the shared dashboard / SAA reports) ──
  const [ready, setReady] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expected = devGid ? `instructor_${devGid}` : gidParam ? `instructor_${gidParam}` : null
        if (expected && auth.currentUser.uid === expected) { setReady(true); return }
        await signOut(auth); if (cancelled) return
      }
      const args = devGid ? { _dev: { game_instance_id: devGid } } : tokenParam ? { token: tokenParam } : null
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
        if (!cancelled) setReady(true)
      } catch (e) { if (!cancelled) setAuthError(e instanceof Error ? e.message : 'Failed to establish session.') }
    })()
    return () => { cancelled = true }
  }, [devGid, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  const [report, setReport] = useState<CrisisReport | null>(null)
  const [online, setOnline] = useState<OnlineReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return
    getCrisisReport().then(setReport).catch(e => setError(e instanceof Error ? e.message : 'Failed to load reports.'))
    getOnlineReport().then(setOnline).catch(() => { /* operational report is best-effort; debrief tiles stand alone */ })
  }, [ready])

  const [active, setActive] = useState<ReportKind | null>(null)
  const [groupIdx, setGroupIdx] = useState(0)

  const hasData = (report?.includedGroups ?? 0) > 0          // all-human groups → Report 1 (class sums)
  const hasGroups = (report?.groups.length ?? 0) > 0         // any charted group → Report 2 (incl. bot-filled)
  const hasStudents = (report?.students.length ?? 0) > 0     // any human seat → Report 3
  const hasOnline = (online?.groups.length ?? 0) > 0     // any group → the assignment-status view
  const omitted = report?.omittedBotGroups ?? 0
  const omitNote = omitted > 0 ? <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}> · {omitted} bot-filled group{omitted !== 1 ? 's' : ''} omitted</span> : null

  const tiles: ReportTileConfig[] = [
    {
      id: 'class', title: 'Class overall',
      preview: hasData
        ? <span data-testid="tile-class" style={{ fontSize: '0.9rem', color: '#555' }}>{report!.includedGroups} group{report!.includedGroups !== 1 ? 's' : ''} · class sums + allocations chart{omitNote}</span>
        : <span data-testid="tile-class" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No finished human groups yet.</span>,
      onOpen: () => setActive('class'), disabled: !hasData, actionLabel: 'Open ↗',
    },
    {
      id: 'group', title: 'By group',
      preview: hasGroups
        ? <span data-testid="tile-group" style={{ fontSize: '0.9rem', color: '#555' }}>allocations chart + profits/fixing per group{omitted > 0 ? ' (bot-filled groups included, labelled)' : ''}</span>
        : <span data-testid="tile-group" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No finished groups yet.</span>,
      onOpen: () => setActive('group'), disabled: !hasGroups, actionLabel: 'Open ↗',
    },
    {
      id: 'students', title: 'Per-student',
      preview: hasStudents
        ? <span data-testid="tile-students" style={{ fontSize: '0.9rem', color: '#555' }}>{report!.students.length} students · sortable</span>
        : <span data-testid="tile-students" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No finished human seats yet.</span>,
      onOpen: () => setActive('students'), disabled: !hasStudents, actionLabel: 'Open ↗',
    },
    {
      id: 'online', title: 'Assignment status',
      preview: hasOnline
        ? <span data-testid="tile-online" style={{ fontSize: '0.9rem', color: '#555' }}>
            {online!.counts.finished} finished · {online!.counts.inProgress} mid-game · {online!.counts.neverStarted} not started{online!.counts.flagged > 0 ? <> · <span style={{ color: '#b45309', fontWeight: 700 }}>{online!.counts.flagged} ⚑</span></> : ''}
          </span>
        : <span data-testid="tile-online" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No groups yet.</span>,
      onOpen: () => setActive('online'), disabled: !hasOnline, actionLabel: 'Open ↗',
    },
  ]

  if (authError) return <div style={{ padding: '2rem', textAlign: 'center' }}><p style={{ color: '#c00' }}>{authError}</p></div>

  const g = report?.groups[groupIdx]

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />
      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button onClick={() => navigate(makeLink('/dashboard'))} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}>← Dashboard</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — Crisis</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        {!report && !error && <p style={{ color: '#888' }}>Loading…</p>}
        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
          Grading is <strong>participation-only</strong>; profit and fixing below are <strong>game outcomes, never grades</strong>. Bots are excluded from every report.
        </p>
        <ReportBoard tiles={tiles} />
      </main>

      {/* ── Report 1: Class overall ── */}
      {active === 'class' && report && (
        <Modal title="Class overall" onClose={() => setActive(null)} wide>
          <div data-testid="report-class" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <Figure label="Total buyer profit" value={money(report.classSummary.totalBuyerProfit)} />
            <Figure label="Total seller profit" value={money(report.classSummary.totalSellerProfit)} />
            <Figure label="Average bid" value={one(report.classSummary.averageBid)} note="ECU per unit" />
            <Figure label="Crises fixed (class)" value={pct(report.classSummary.pctCrisesFixed)} note="of crises faced" />
          </div>
          {omitted > 0 && <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 0 }}>{omitted} bot-filled group{omitted !== 1 ? 's' : ''} omitted from all figures.</p>}
          <AllocationsChart data={report.classChart} testid="report-class-chart" />
        </Modal>
      )}

      {/* ── Report 2: By group (selector) ── */}
      {active === 'group' && report && g && (
        <Modal title="By group" onClose={() => setActive(null)} wide>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ fontWeight: 600, marginRight: '0.5rem' }}>Group</label>
            <select data-testid="report-group-select" value={groupIdx} onChange={e => setGroupIdx(Number(e.target.value))}>
              {report.groups.map((gr, i) => <option key={gr.groupId} value={i}>Group {gr.groupNumber}</option>)}
            </select>
          </div>
          <AllocationsChart data={g.chart} testid="report-group-chart" />
          <h4 style={{ margin: '1.25rem 0 0.5rem' }}>Profits and Fixing</h4>
          <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
            <table data-testid="report-group-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>Role</th><th style={th}>Name</th><th style={th}>Profit</th><th style={th}>Fixing %</th></tr></thead>
              <tbody>
                <tr><td style={td}>Buyer</td><td style={{ ...td, whiteSpace: 'nowrap' }}>{g.names.buyer}{g.bots.buyer && botTag}</td><td style={td}>{money(g.table.buyerProfit)}</td><td style={td}>—</td></tr>
                <tr><td style={td}>Seller 1</td><td style={{ ...td, whiteSpace: 'nowrap' }}>{g.names.seller1}{g.bots.seller1 && botTag}</td><td style={td}>{money(g.table.seller1Profit)}</td><td style={td}>{pct(g.table.seller1FixPct)}</td></tr>
                <tr><td style={td}>Seller 2</td><td style={{ ...td, whiteSpace: 'nowrap' }}>{g.names.seller2}{g.bots.seller2 && botTag}</td><td style={td}>{money(g.table.seller2Profit)}</td><td style={td}>{pct(g.table.seller2FixPct)}</td></tr>
              </tbody>
            </table>
          </div>
          {(g.bots.buyer || g.bots.seller1 || g.bots.seller2) && (
            <p data-testid="report-group-bot-note" style={{ fontSize: '0.75rem', color: '#b45309', margin: '0.5rem 0 0' }}>
              This is a bot-filled group — seats marked <strong>BOT</strong> were machine-played; those figures are machine-generated, not student outcomes.
            </p>
          )}
        </Modal>
      )}

      {/* ── Report 3: Per-student ── */}
      {active === 'students' && report && (
        <Modal title="Per-student" onClose={() => setActive(null)} wide>
          <StudentTable rows={report.students} />
        </Modal>
      )}

      {/* ── Assignment status (Slice O3): who finished / mid / never started + per-student ── */}
      {active === 'online' && online && (
        <Modal title="Assignment status" onClose={() => setActive(null)} wide>
          <div data-testid="report-online" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
            <Figure label="Finished" value={String(online.counts.finished)} note="played to the end" />
            <Figure label="Mid-game" value={String(online.counts.inProgress)} note="started, not done" />
            <Figure label="Not started" value={String(online.counts.neverStarted)} note="never opened round 1" />
            <Figure label="Flagged (open)" value={String(online.counts.flagged)} note="can't-reach reports still live" />
          </div>
          <OnlineStatusTable rows={online.students} />
        </Modal>
      )}
    </div>
  )
}

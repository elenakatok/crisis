import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import { GameHeader, ReportBoard, type ReportTileConfig } from '@mygames/game-ui'
import { getCrisisReport, type CrisisReport, type ReportStudentRow } from '../api'
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

// ── Sortable per-student table (Report 3) ───────────────────────────────────────────
type SortKey = 'name' | 'groupNumber' | 'role' | 'averageBid' | 'proportionFixed' | 'averageAllocation' | 'profit'
function StudentTable({ rows }: { rows: ReportStudentRow[] }) {
  const [key, setKey] = useState<SortKey>('groupNumber')
  const [dir, setDir] = useState<1 | -1>(1)
  const sorted = useMemo(() => {
    const cmp = (a: ReportStudentRow, b: ReportStudentRow) => {
      const av = a[key], bv = b[key]
      if (av === null) return 1
      if (bv === null) return -1
      const r = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number)
      return r !== 0 ? r * dir : a.name.localeCompare(b.name)
    }
    return [...rows].sort(cmp)
  }, [rows, key, dir])
  const head = (k: SortKey, label: string) => (
    <th style={{ ...th, cursor: 'pointer' }} data-testid={`col-${k}`} onClick={() => { if (k === key) setDir(d => (d === 1 ? -1 : 1)); else { setKey(k); setDir(1) } }}>
      {label}{k === key ? (dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  )
  return (
    <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
      <table data-testid="crisis-student-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead><tr>
          {head('name', 'Name')}{head('groupNumber', 'Group')}{head('role', 'Role')}
          {head('averageBid', 'Average bid')}{head('proportionFixed', 'Proportion fixed')}
          {head('averageAllocation', 'Average allocation')}{head('profit', 'Profit')}
        </tr></thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.participantId} data-testid={`student-row-${r.participantId}`}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.name}</td>
              <td style={td}>{r.groupNumber}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.role}</td>
              <td style={td}>{one(r.averageBid)}{r.role === 'Buyer' ? ' *' : ''}</td>
              <td style={td}>{pct(r.proportionFixed)}</td>
              <td style={td}>{r.averageAllocation === null ? '—' : one(r.averageAllocation)}</td>
              <td style={td}>{money(r.profit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: '0.72rem', color: '#94a3b8', margin: '0.4rem 0.7rem' }}>
        * The Buyer&apos;s &ldquo;average bid&rdquo; is the allocation-weighted average price they paid.
      </p>
    </div>
  )
}

type ReportKind = 'class' | 'group' | 'students'

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
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!ready) return
    getCrisisReport().then(setReport).catch(e => setError(e instanceof Error ? e.message : 'Failed to load reports.'))
  }, [ready])

  const [active, setActive] = useState<ReportKind | null>(null)
  const [groupIdx, setGroupIdx] = useState(0)

  const hasData = (report?.includedGroups ?? 0) > 0
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
      preview: hasData
        ? <span data-testid="tile-group" style={{ fontSize: '0.9rem', color: '#555' }}>allocations chart + profits/fixing per group</span>
        : <span data-testid="tile-group" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No finished human groups yet.</span>,
      onOpen: () => setActive('group'), disabled: !hasData, actionLabel: 'Open ↗',
    },
    {
      id: 'students', title: 'Per-student',
      preview: hasData
        ? <span data-testid="tile-students" style={{ fontSize: '0.9rem', color: '#555' }}>{report!.students.length} students · sortable</span>
        : <span data-testid="tile-students" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No finished human groups yet.</span>,
      onOpen: () => setActive('students'), disabled: !hasData, actionLabel: 'Open ↗',
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
            <Figure label="Avg. winning allocation" value={one(report.classSummary.averageWinningAllocation)} note="units to the favoured seller" />
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
          <h4 style={{ margin: '1.25rem 0 0.5rem' }}>Average Profits and Fixing</h4>
          <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
            <table data-testid="report-group-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr><th style={th}>Role</th><th style={th}>Name</th><th style={th}>Profit</th><th style={th}>Fixing %</th></tr></thead>
              <tbody>
                <tr><td style={td}>Buyer</td><td style={{ ...td, whiteSpace: 'nowrap' }}>{g.names.buyer}</td><td style={td}>{money(g.table.buyerProfit)}</td><td style={td}>—</td></tr>
                <tr><td style={td}>Seller 1</td><td style={{ ...td, whiteSpace: 'nowrap' }}>{g.names.seller1}</td><td style={td}>{money(g.table.seller1Profit)}</td><td style={td}>{pct(g.table.seller1FixPct)}</td></tr>
                <tr><td style={td}>Seller 2</td><td style={{ ...td, whiteSpace: 'nowrap' }}>{g.names.seller2}</td><td style={td}>{money(g.table.seller2Profit)}</td><td style={td}>{pct(g.table.seller2FixPct)}</td></tr>
              </tbody>
            </table>
          </div>
        </Modal>
      )}

      {/* ── Report 3: Per-student ── */}
      {active === 'students' && report && (
        <Modal title="Per-student" onClose={() => setActive(null)} wide>
          <StudentTable rows={report.students} />
        </Modal>
      )}
    </div>
  )
}

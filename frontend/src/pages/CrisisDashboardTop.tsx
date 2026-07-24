import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { collection, onSnapshot, type Timestamp } from 'firebase/firestore'
import { colors, typography, spacing } from '@mygames/game-ui'
import { auth, db } from '../firebase'
import { getCrisisDashboard, setClockMode, moveSeat, topUpGroupWithBots, type DashboardGroup } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// CrisisDashboardTop (Slice O2.1) — THE control-room top area, portaled to the top of the
// shared dashboard <main> (below the site header). Two blocks, one portal:
//   1. SESSION MODE switch — the SINGLE place mode is set (removed from /live). Guarded once
//      any group has started.
//   2. GROUP STRIP — one line per group (the existing summary). Classroom: unchanged (status +
//      "Live view →"). Online: the same line carries the two per-group actions (move a member,
//      fill empty seats with bots). NO names/emails/login here — names appear only inside the
//      move picker. Live: onSnapshot on the group docs (membership/lock), status from the poll.
// Replaces CrisisLiveSummary + the O2 OnlineInstructorPanel cards (both removed).
// ═══════════════════════════════════════════════════════════════════════════════

const STAGE = { bidding: 'bidding', allocation: 'allocation', fixing: 'fix decision' } as const

type LiveGroup = {
  id: string
  player_participants: string[]
  bot_participants: string[]
  members: { participant_id: string; display_name: string }[]
  seats_locked_at: Timestamp | null
}

function statusLine(g: DashboardGroup): string {
  if (g.status === 'finished') return `finished — ${g.numRounds} rounds`
  if (g.status === 'not_started') return 'not started'
  const waiting = g.waitingOn.length
    ? ` · waiting on ${g.waitingOn.map(w => (w.role === 'buyer' ? 'Buyer' : w.role === 'seller1' ? 'Seller 1' : 'Seller 2')).join(', ')}`
    : ''
  return `Round ${g.round} of ${g.numRounds} · ${STAGE[g.stage!]}${waiting}`
}

export default function CrisisDashboardTop() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [clockMode, setClock] = useState<'on' | 'off' | null>(null)
  const [groups, setGroups] = useState<DashboardGroup[]>([])
  const [live, setLive] = useState<Record<string, LiveGroup>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Single host as the FIRST child of the shared dashboard's <main> (below the header).
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const node = document.createElement('div')
    node.setAttribute('data-crisis-top-host', '')
    main.insertBefore(node, main.firstChild)
    setHost(node)
    return () => { node.remove(); setHost(null) }
  }, [])

  // clock_mode + per-group status (the §4A poll already returns both).
  useEffect(() => {
    let alive = true
    const tick = () => getCrisisDashboard().then(r => {
      if (!alive || !r.ok) return
      setClock(r.clock_mode === 'off' ? 'off' : 'on')
      setGroups(r.groups)
    }).catch(() => {})
    tick()
    const id = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const online = clockMode === 'off'

  // Live membership/lock for the online actions.
  useEffect(() => {
    if (!online) { setLive({}); return }
    const uid = auth.currentUser?.uid ?? ''
    const gid = uid.startsWith('instructor_') ? uid.slice('instructor_'.length) : ''
    if (!gid) return
    const unsub = onSnapshot(collection(db, 'game_instances', gid, 'groups'), (snap) => {
      const m: Record<string, LiveGroup> = {}
      for (const d of snap.docs) {
        const x = d.data() as Record<string, unknown>
        m[d.id] = {
          id: d.id,
          player_participants: (x['player_participants'] as string[]) ?? [],
          bot_participants: (x['bot_participants'] as string[]) ?? [],
          members: (x['members'] as { participant_id: string; display_name: string }[]) ?? [],
          seats_locked_at: (x['seats_locked_at'] as Timestamp) ?? null,
        }
      }
      setLive(m)
    }, () => { /* transient; the poll keeps status fresh */ })
    return () => unsub()
  }, [online])

  const anyStarted = useMemo(() => groups.some(g => g.status !== 'not_started'), [groups])
  const numberById = useMemo(() => new Map(groups.map(g => [g.groupId, g.groupNumber])), [groups])
  // Destinations for a move: groups with a free seat and not locked (by group_id).
  const destinations = useMemo(
    () => Object.values(live).filter(g => g.player_participants.length < 3 && g.seats_locked_at == null)
      .map(g => ({ id: g.id, n: numberById.get(g.id) ?? null })),
    [live, numberById],
  )

  const chooseMode = async (m: 'on' | 'off') => {
    if (m === clockMode || saving || anyStarted) return
    setSaving(true); setError(null)
    try { const c = await setClockMode(m); setClock(c.clock_mode === 'off' ? 'off' : 'on') }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not change mode.') }
    setSaving(false)
  }

  if (!host) return null

  const modeBtn = (active: boolean): React.CSSProperties => ({
    padding: '0.4rem 0.9rem', fontWeight: 600, cursor: anyStarted ? 'not-allowed' : 'pointer', borderRadius: 4,
    border: `1px solid ${active ? colors.text : colors.borderLight}`,
    background: active ? colors.text : colors.white, color: active ? colors.white : colors.textSecondary,
    opacity: anyStarted && !active ? 0.5 : 1,
  })

  return createPortal(
    <div>
      {/* ── 1. SESSION MODE (the single mode control) ───────────────────────────── */}
      <div
        data-testid="crisis-mode-switch"
        style={{ margin: '0 0 1rem', padding: '0.6rem 1rem', border: `1px solid ${colors.borderMid}`, borderRadius: 8, background: colors.surfaceSubtle }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700 }}>Session mode:</span>
          <div style={{ display: 'flex', gap: spacing.gapSm }} title={anyStarted ? 'A group has started — mode is locked for this session.' : ''}>
            <button data-testid="crisis-mode-classroom" style={modeBtn(clockMode === 'on')} disabled={saving || clockMode === null || anyStarted} onClick={() => chooseMode('on')}>Classroom — round clock</button>
            <button data-testid="crisis-mode-online" style={modeBtn(clockMode === 'off')} disabled={saving || clockMode === null || anyStarted} onClick={() => chooseMode('off')}>Online — no clock</button>
          </div>
          {clockMode && (
            <span style={{ fontSize: typography.sizeXs, color: colors.textSecondary }}>
              {clockMode === 'on' ? 'Stages time out after the round clock; a timeout plays the default action.' : 'No clock — pre-grouped, students self-schedule, stages wait for every seat.'}
            </span>
          )}
          {anyStarted && <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>Locked — a group has started.</span>}
        </div>
        {error && <p data-testid="crisis-mode-error" role="alert" style={{ color: '#b91c1c', fontSize: typography.sizeXs, margin: `${spacing.gapSm} 0 0` }}>{error}</p>}
      </div>

      {/* ── 2. GROUP STRIP (the single group area) ──────────────────────────────── */}
      <div data-testid="crisis-live-summary" style={{ margin: '0 0 1.5rem', padding: '0.75rem 1rem', border: `1px solid ${colors.borderMid}`, borderRadius: 8, background: colors.surfaceSubtle }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.gapSm }}>
          <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>Groups</span>
          <a data-testid="crisis-live-nav" href={`/live${window.location.search}`} style={{ color: '#D38626', fontWeight: 700, fontSize: typography.sizeSm, textDecoration: 'none' }}>Live view →</a>
        </div>

        {groups.length === 0 ? (
          <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary }}>
            {online ? 'Press “Group participants” to form groups.' : 'Match students into groups to begin.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.gapSm }}>
            {groups.map(g => (
              <div key={g.groupId} data-testid={`crisis-summary-row-${g.groupNumber}`} style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, paddingBottom: '0.4rem', borderBottom: `1px solid ${colors.borderFaint}`, flexWrap: 'wrap' }}>
                <span style={{ minWidth: 70, fontWeight: 600 }}>Group {g.groupNumber}</span>
                <span style={{ fontSize: typography.sizeSm, color: g.status === 'in_progress' ? colors.successText : colors.textSecondary }}>
                  {g.status === 'in_progress' && '● '}{statusLine(g)}
                </span>
                {online && (
                  <StripActions
                    g={g}
                    live={live[g.groupId]}
                    destinations={destinations}
                    onMove={async (pid, dest) => { setError(null); try { await moveSeat(pid, dest) } catch (e) { setError(`Move: ${e instanceof Error ? e.message : 'failed'}`) } }}
                    onFill={async () => { setError(null); try { await topUpGroupWithBots(g.groupId) } catch (e) { setError(`Fill: ${e instanceof Error ? e.message : 'failed'}`) } }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    host,
  )
}

// Inline per-group online actions on the strip line: move a member, fill empty seats. NO
// member names on the line itself — names appear only inside the move picker (unavoidable to
// choose whom to move). Locked groups → disabled with a tooltip.
function StripActions({
  g, live, destinations, onMove, onFill,
}: {
  g: DashboardGroup
  live?: LiveGroup
  destinations: { id: string; n: number | null }[]
  onMove: (pid: string, dest: string) => void
  onFill: () => void
}) {
  const [member, setMember] = useState('')
  const [busy, setBusy] = useState(false)
  if (!live) return null
  const locked = live.seats_locked_at != null
  const emptySeats = 3 - live.player_participants.length
  const otherDests = destinations.filter(d => d.id !== g.groupId)

  const doMove = async (dest: string) => {
    if (!member || !dest) return
    setBusy(true); await onMove(member, dest); setMember(''); setBusy(false)
  }
  const doFill = async () => { setBusy(true); await onFill(); setBusy(false) }

  if (locked) {
    return <span data-testid={`crisis-strip-locked-${g.groupNumber}`} style={{ fontSize: typography.sizeXs, color: colors.textMuted }} title="This group has started — seats are locked.">🔒 locked</span>
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: spacing.gapSm, flexWrap: 'wrap' }}>
      {live.members.length > 0 && otherDests.length > 0 && (
        <>
          <select data-testid={`crisis-strip-move-member-${g.groupNumber}`} value={member} disabled={busy} onChange={e => setMember(e.target.value)} style={{ fontSize: typography.sizeXs }}>
            <option value="">Move…</option>
            {live.members.map(m => <option key={m.participant_id} value={m.participant_id}>{m.display_name}</option>)}
          </select>
          <select data-testid={`crisis-strip-move-dest-${g.groupNumber}`} value="" disabled={busy || !member} onChange={e => { const d = e.target.value; e.currentTarget.value = ''; void doMove(d) }} style={{ fontSize: typography.sizeXs }}>
            <option value="">to group…</option>
            {otherDests.map(d => <option key={d.id} value={d.id}>Group {d.n}</option>)}
          </select>
        </>
      )}
      {emptySeats > 0 && (
        <button data-testid={`crisis-strip-fill-${g.groupNumber}`} onClick={doFill} disabled={busy} style={{ fontSize: typography.sizeXs }}>
          Fill {emptySeats} seat{emptySeats === 1 ? '' : 's'} with bots
        </button>
      )}
    </span>
  )
}

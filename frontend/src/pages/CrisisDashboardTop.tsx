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

type GroupFlag = { flagged_at?: Timestamp; reported_by?: string; reporter_name?: string; named?: string[] }
type LiveGroup = {
  id: string
  player_participants: string[]
  bot_participants: string[]
  members: { participant_id: string; display_name: string }[]
  seats_locked_at: Timestamp | null
  flag: GroupFlag | null
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
  const [noGroup, setNoGroup] = useState<{ participant_id: string; name: string }[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
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

  // clock_mode + per-group status + the pid→name map (§O2.4: names for the classroom picker).
  useEffect(() => {
    let alive = true
    const tick = () => getCrisisDashboard().then(r => {
      if (!alive || !r.ok) return
      setClock(r.clock_mode === 'off' ? 'off' : 'on')
      setGroups(r.groups)
      setNoGroup(r.noGroup ?? [])
      setNames(r.names ?? {})
    }).catch(() => {})
    tick()
    const id = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const online = clockMode === 'off'

  // Live membership/lock — §O2.4: runs in BOTH modes (classroom groups exist too). Gated on the
  // clock_mode poll having landed (⇒ instructor auth ready ⇒ uid available), not on the mode.
  useEffect(() => {
    if (clockMode === null) return
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
          flag: (x['flag'] as GroupFlag) ?? null,
        }
      }
      setLive(m)
    }, () => { /* transient; the poll keeps status fresh */ })
    return () => unsub()
  }, [clockMode])

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
                {/* §O3: a student "can't reach my group" flag — ⚑ with who/when. Goes STALE
                    automatically once the group locks (started playing = resolved), so a stale
                    flag never renders. */}
                <FlagBadge live={live[g.groupId]} groupNumber={g.groupNumber} names={names} />
                {/* §O2.4: per-group actions in BOTH modes (locked/started groups show 🔒). */}
                <StripActions
                  g={g}
                  live={live[g.groupId]}
                  names={names}
                  destinations={destinations}
                  onMove={async (pid, dest) => { setError(null); try { await moveSeat(pid, dest) } catch (e) { setError(`Move: ${e instanceof Error ? e.message : 'failed'}`) } }}
                  onFill={async () => { setError(null); try { await topUpGroupWithBots(g.groupId) } catch (e) { setError(`Fill: ${e instanceof Error ? e.message : 'failed'}`) } }}
                />
              </div>
            ))}
          </div>
        )}

        {/* No Group pool (§O2.3, both modes §O2.4) — ungrouped (removed / late / missed-matching)
            students, name only. Placeable into a free seat or a NEW group. Only shown once groups
            EXIST (before matching/grouping, everyone is ungrouped — that is not the stranded case). */}
        {groups.length > 0 && noGroup.length > 0 && (
          <div data-testid="crisis-nogroup-row" style={{ marginTop: spacing.gapMd, paddingTop: spacing.gapSm, borderTop: `1px solid ${colors.borderMid}`, display: 'flex', alignItems: 'baseline', gap: spacing.gapMd, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 70, fontWeight: 600, color: colors.textSecondary }}>No group ({noGroup.length})</span>
            {noGroup.map(p => (
              <NoGroupMember
                key={p.participant_id}
                p={p}
                destinations={destinations}
                onPlace={async (dest) => { setError(null); try { await moveSeat(p.participant_id, dest) } catch (e) { setError(`Place: ${e instanceof Error ? e.message : 'failed'}`) } }}
              />
            ))}
          </div>
        )}
      </div>
    </div>,
    host,
  )
}

// §O3 flag indicator on a group's strip line. Renders ONLY when the group carries a live (non-
// stale) flag: a flag present AND the group not yet locked. Once seats lock (first submission),
// the flag is resolved and the badge disappears — no instructor "clear" action, the lock clears it.
// Who/when is shown inline + on hover; the named (unresponsive) students resolve via the names map.
function FlagBadge({ live, groupNumber, names }: { live?: LiveGroup; groupNumber: number | null; names: Record<string, string> }) {
  if (!live || !live.flag || live.seats_locked_at != null) return null
  const f = live.flag
  const when = f.flagged_at?.toDate ? f.flagged_at.toDate().toLocaleString() : ''
  const named = (f.named ?? []).map(pid => names[pid] ?? pid)
  const reporter = f.reporter_name ?? (f.reported_by ? (names[f.reported_by] ?? f.reported_by) : 'a student')
  const title = [`Flagged by ${reporter}${when ? ` at ${when}` : ''}`, named.length ? `Not reachable: ${named.join(', ')}` : ''].filter(Boolean).join(' · ')
  return (
    <span data-testid={`crisis-flag-indicator-${groupNumber}`} title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: typography.sizeXs, fontWeight: 700, color: '#b45309' }}>
      ⚑ student flagged
      {named.length > 0 && <span style={{ fontWeight: 400, color: colors.textSecondary }}>({named.join(', ')})</span>}
    </span>
  )
}

// One ungrouped student in the No Group pool: name + a "place in…" picker (free-seat groups + New
// group). No emails/status here (consistent with the strip); the "New group" flow confirms first.
function NoGroupMember({
  p, destinations, onPlace,
}: {
  p: { participant_id: string; name: string }
  destinations: { id: string; n: number | null }[]
  onPlace: (dest: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const doDest = async (dest: string) => {
    if (!dest) return
    if (dest === '__new__') { if (!window.confirm(`Create a new group with ${p.name}?`)) return; setBusy(true); await onPlace('new'); setBusy(false); return }
    setBusy(true); await onPlace(dest); setBusy(false)
  }
  return (
    <span data-testid="crisis-nogroup-member" style={{ display: 'inline-flex', alignItems: 'center', gap: spacing.gapSm }}>
      <span style={{ color: colors.textStrong }}>{p.name}</span>
      <select data-testid={`crisis-nogroup-move-${p.participant_id}`} value="" disabled={busy} onChange={e => { const v = e.target.value; e.currentTarget.value = ''; void doDest(v) }} style={{ fontSize: typography.sizeXs }}>
        <option value="" disabled>place in…</option>
        {destinations.map(d => <option key={d.id} value={d.id}>Group {d.n}</option>)}
        <option value="__new__">→ New group</option>
      </select>
    </span>
  )
}

// Inline per-group online actions on the strip line: move a member, fill empty seats. NO
// member names on the line itself — names appear only inside the move picker (unavoidable to
// choose whom to move). Locked groups → disabled with a tooltip.
function StripActions({
  g, live, names, destinations, onMove, onFill,
}: {
  g: DashboardGroup
  live?: LiveGroup
  names: Record<string, string>
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
  // §O2.4: the human members from player_participants (live) with names from the pid→name map —
  // works for classroom groups (no members[]) as well as online ones. Names resolve from the poll.
  const humanMembers = live.player_participants
    .filter(pid => !live.bot_participants.includes(pid))
    .map(pid => ({ participant_id: pid, display_name: names[pid] ?? pid }))

  // Destination handler: a real group id moves the member; the special "__remove__" value ungroups
  // them (moveSeat with an empty target — the seat becomes empty). Remove is confirmed first.
  const doDest = async (dest: string) => {
    if (!member) return
    const name = humanMembers.find(m => m.participant_id === member)?.display_name ?? 'this student'
    if (dest === '__remove__') {
      if (!window.confirm(`Remove ${name} from Group ${g.groupNumber}? Their seat becomes empty.`)) return
      setBusy(true); await onMove(member, ''); setMember(''); setBusy(false); return // '' target = ungroup
    }
    if (dest === '__new__') {
      if (!window.confirm(`Create a new group with ${name}?`)) return
      setBusy(true); await onMove(member, 'new'); setMember(''); setBusy(false); return // 'new' = create+place
    }
    setBusy(true); await onMove(member, dest); setMember(''); setBusy(false)
  }
  const doFill = async () => { setBusy(true); await onFill(); setBusy(false) }

  if (locked) {
    return <span data-testid={`crisis-strip-locked-${g.groupNumber}`} style={{ fontSize: typography.sizeXs, color: colors.textMuted }} title="This group has started — seats are locked.">🔒 locked</span>
  }

  // The move control is ALWAYS visible on an unlocked group that has members — NOT gated on a
  // free seat existing elsewhere (the original bug: with all-full groups no destination existed,
  // so every line rendered an empty span). When no other group has a free seat the destination
  // dropdown says so; it becomes usable the moment a seat opens. Fill shows only when this group
  // actually has empty seats.
  const hasMembers = humanMembers.length > 0

  return (
    <span data-testid={`crisis-strip-actions-${g.groupNumber}`} style={{ display: 'inline-flex', alignItems: 'center', gap: spacing.gapSm, flexWrap: 'wrap' }}>
      {hasMembers && (
        <>
          <select data-testid={`crisis-strip-move-member-${g.groupNumber}`} value={member} disabled={busy} onChange={e => setMember(e.target.value)} style={{ fontSize: typography.sizeXs }}>
            <option value="">Move member…</option>
            {humanMembers.map(m => <option key={m.participant_id} value={m.participant_id}>{m.display_name}</option>)}
          </select>
          {/* Enabled whenever a member is picked — "Remove from group" is always available even
              when no group has a free seat (the full-class case). */}
          <select data-testid={`crisis-strip-move-dest-${g.groupNumber}`} value="" disabled={busy || !member} onChange={e => { const d = e.target.value; e.currentTarget.value = ''; void doDest(d) }} style={{ fontSize: typography.sizeXs }}>
            <option value="" disabled>move to…</option>
            {otherDests.map(d => <option key={d.id} value={d.id}>Group {d.n}</option>)}
            <option data-testid={`crisis-strip-new-${g.groupNumber}`} value="__new__">→ New group</option>
            <option data-testid={`crisis-strip-remove-${g.groupNumber}`} value="__remove__">— Remove from group</option>
          </select>
        </>
      )}
      {emptySeats > 0 && (
        <button data-testid={`crisis-strip-fill-${g.groupNumber}`} onClick={doFill} disabled={busy} style={{ fontSize: typography.sizeXs }}>
          Fill {emptySeats} seat{emptySeats === 1 ? '' : 's'} with bots
        </button>
      )}
      {!hasMembers && emptySeats === 0 && (
        <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>full</span>
      )}
    </span>
  )
}

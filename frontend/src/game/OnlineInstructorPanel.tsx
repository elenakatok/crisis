import { useCallback, useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, type Timestamp } from 'firebase/firestore'
import { colors, typography, layout, spacing } from '@mygames/game-ui'
import { auth, db } from '../firebase'
import { getCrisisDashboard, groupParticipantsOnline, moveSeat, topUpGroupWithBots } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// OnlineInstructorPanel (Slice O2) — the instructor's online-mode control surface, in the
// dashboard BODY (below the site header, never above it). Renders ONLY when clock_mode='off';
// in classroom mode it renders nothing and the dashboard is untouched.
//
// LIVE by construction: an onSnapshot on the groups collection, so a re-group / seat move /
// bot top-up is reflected WITHOUT a reload — the O1 stale-panel bug is impossible here. Round/
// stage/status overlay comes from getCrisisDashboard (crisis_round is instructor-unreadable
// from the client, so the coarse live state rides the group doc and the round detail is polled).
//
// The single matching control lives at the top of this panel; the shared "Match Now" button is
// DOM-hidden online (Spectrum's approved pattern) so exactly one matching control is visible.
// ═══════════════════════════════════════════════════════════════════════════════

const GROUP_SIZE = 3
const STAGE_LABEL: Record<string, string> = { bidding: 'bidding', allocation: 'allocation', fixing: 'fix decision' }

type Member = { participant_id: string; display_name: string; email: string | null }
type GroupDoc = {
  id: string
  player_participants: string[]
  bot_participants: string[]
  members: Member[]
  member_logins: Record<string, Timestamp>
  seats_locked_at: Timestamp | null
  status: string
}
type DashInfo = { status: string; round: number | null; stage: string | null }

function relTime(ts?: Timestamp | null): string {
  if (!ts || typeof ts.toMillis !== 'function') return 'never'
  const ms = Date.now() - ts.toMillis()
  if (ms < 60_000) return 'logged in just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `logged in ${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `logged in ${h}h ago`
  return `logged in ${Math.floor(h / 24)}d ago`
}

/** Spectrum's approved mechanism: hide the shared "Match Now" button (no shared-package edit). */
function hideSharedMatch() {
  for (const btn of Array.from(document.querySelectorAll('button'))) {
    const t = (btn.textContent ?? '').trim()
    if (t === 'Match Now' || t === 'Matching…') (btn as HTMLElement).style.display = 'none'
  }
}

export default function OnlineInstructorPanel() {
  const [clockMode, setClockMode] = useState<string | null>(null)
  const [groups, setGroups] = useState<GroupDoc[]>([])
  const [dash, setDash] = useState<Record<string, DashInfo>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // clock_mode + round/stage overlay (getCrisisDashboard returns clock_mode).
  useEffect(() => {
    let alive = true
    const tick = () => getCrisisDashboard().then(r => {
      if (!alive || !r.ok) return
      setClockMode(r.clock_mode ?? 'on')
      const m: Record<string, DashInfo> = {}
      for (const g of r.groups) m[g.groupId] = { status: g.status, round: g.round, stage: g.stage }
      setDash(m)
    }).catch(() => {})
    tick()
    const id = setInterval(tick, 2500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const online = clockMode === 'off'

  // Live group docs (membership / logins / lock) + hide the shared Match Now while online.
  useEffect(() => {
    if (!online) return
    const uid = auth.currentUser?.uid ?? ''
    const gid = uid.startsWith('instructor_') ? uid.slice('instructor_'.length) : ''
    if (!gid) return

    hideSharedMatch()
    const mo = new MutationObserver(() => hideSharedMatch())
    mo.observe(document.body, { childList: true, subtree: true })

    const unsub = onSnapshot(collection(db, 'game_instances', gid, 'groups'), (snap) => {
      const list: GroupDoc[] = snap.docs.map(d => {
        const x = d.data() as Record<string, unknown>
        return {
          id: d.id,
          player_participants: (x['player_participants'] as string[]) ?? [],
          bot_participants: (x['bot_participants'] as string[]) ?? [],
          members: (x['members'] as Member[]) ?? [],
          member_logins: (x['member_logins'] as Record<string, Timestamp>) ?? {},
          seats_locked_at: (x['seats_locked_at'] as Timestamp) ?? null,
          status: (x['status'] as string) ?? 'matched',
        }
      }).sort((a, b) => a.id.localeCompare(b.id)) // stable numbering (matches getCrisisDashboard)
      setGroups(list)
    }, () => { /* transient — the poll keeps clock_mode fresh */ })

    return () => { mo.disconnect(); unsub() }
  }, [online])

  const anyLocked = useMemo(() => groups.some(g => g.seats_locked_at != null), [groups])
  const number = useMemo(() => new Map(groups.map((g, i) => [g.id, i + 1])), [groups])

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(`${label}: ${e instanceof Error ? e.message : 'failed'}`) }
    setBusy(false)
  }, [])

  if (!online) return null // classroom mode → nothing here; dashboard unchanged.

  return (
    <section
      data-testid="crisis-online-panel"
      style={{ maxWidth: layout.contentWidth, margin: `${spacing.gapMd} auto 0`, fontFamily: typography.fontFamily }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapMd, flexWrap: 'wrap', marginBottom: spacing.gapSm }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Online groups</h2>
        <button
          data-testid="crisis-match-control"
          onClick={() => run('Grouping', () => groupParticipantsOnline())}
          disabled={busy || anyLocked}
        >
          {groups.length === 0 ? 'Group Participants' : 'Re-group participants'}
        </button>
        {anyLocked && <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>A group has started — re-grouping is locked.</span>}
      </div>
      <p style={{ fontSize: typography.sizeXs, color: colors.textSecondary, margin: `0 0 ${spacing.gapMd}` }}>
        Random groups of three from the whole roster (no attendance code). Move a student between
        groups, or fill a short group’s empty seats with stand-in players. Round 1 starts on its own
        once everyone in a full group has opened the game.
      </p>

      {error && <p data-testid="crisis-online-error" role="alert" style={{ color: '#b91c1c' }}>{error}</p>}

      {groups.length === 0 ? (
        <p style={{ color: colors.textSecondary }}>No groups yet — press “Group Participants”.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: spacing.gapMd }}>
          {groups.map(g => (
            <GroupCard
              key={g.id}
              g={g}
              n={number.get(g.id) ?? 0}
              dash={dash[g.id]}
              groups={groups}
              number={number}
              busy={busy}
              onMove={(pid, target) => run('Move', () => moveSeat(pid, target))}
              onFill={() => run('Fill', () => topUpGroupWithBots(g.id))}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function stateLabel(g: GroupDoc, d?: DashInfo): { text: string; live: boolean } {
  const locked = g.seats_locked_at != null
  if (d?.status === 'finished' || g.status === 'completed') return { text: 'Finished', live: false }
  if (d?.status === 'in_progress' && d.round) return { text: `${locked ? '🔒 ' : ''}Round ${d.round} · ${STAGE_LABEL[d.stage ?? ''] ?? d.stage}`, live: true }
  if (locked) return { text: '🔒 Locked', live: false }
  return { text: 'Not started', live: false }
}

function GroupCard({
  g, n, dash, groups, number, busy, onMove, onFill,
}: {
  g: GroupDoc; n: number; dash?: DashInfo; groups: GroupDoc[]; number: Map<string, number>
  busy: boolean; onMove: (pid: string, target: string) => void; onFill: () => void
}) {
  const locked = g.seats_locked_at != null
  const botCount = g.bot_participants.length
  const emptySeats = GROUP_SIZE - g.player_participants.length
  const st = stateLabel(g, dash)
  // Destinations for a move: OTHER groups with a free human/seat and not locked.
  const destinations = groups.filter(o => o.id !== g.id && o.player_participants.length < GROUP_SIZE && o.seats_locked_at == null)

  return (
    <div data-testid={`crisis-online-group-${n}`} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: spacing.gapMd, background: colors.surfaceSubtle }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.gapSm }}>
        <strong>Group {n}</strong>
        <span data-testid={`crisis-online-state-${n}`} style={{ fontSize: typography.sizeXs, color: st.live ? colors.successText : colors.textSecondary }}>{st.text}</span>
      </div>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: spacing.gapTiny }}>
        {g.members.map(m => (
          <li key={m.participant_id} data-testid="crisis-online-member" style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingBottom: spacing.gapTiny, borderBottom: `1px solid ${colors.borderFaint}` }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: spacing.gapSm, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, color: colors.textStrong }}>{m.display_name}</span>
              {m.email && <a href={`mailto:${m.email}`} style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>{m.email}</a>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: spacing.gapSm, flexWrap: 'wrap' }}>
              <span style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>{relTime(g.member_logins[m.participant_id])}</span>
              {!locked && destinations.length > 0 && (
                <select
                  data-testid="crisis-online-move"
                  defaultValue=""
                  disabled={busy}
                  onChange={e => { const t = e.target.value; e.currentTarget.value = ''; if (t) onMove(m.participant_id, t) }}
                  style={{ fontSize: typography.sizeXs }}
                >
                  <option value="" disabled>Move to…</option>
                  {destinations.map(d => <option key={d.id} value={d.id}>Group {number.get(d.id)}</option>)}
                </select>
              )}
            </div>
          </li>
        ))}
        {Array.from({ length: botCount }).map((_, i) => (
          <li key={`bot-${i}`} style={{ fontSize: typography.sizeXs, color: colors.textMuted, paddingBottom: spacing.gapTiny }}>Bot</li>
        ))}
      </ul>

      {emptySeats > 0 && (
        <button
          data-testid={`crisis-online-fill-${n}`}
          onClick={onFill}
          disabled={busy || locked}
          title={locked ? 'This group has started — seats are locked.' : ''}
          style={{ marginTop: spacing.gapSm, fontSize: typography.sizeXs }}
        >
          Fill {emptySeats} empty seat{emptySeats === 1 ? '' : 's'} with bots
        </button>
      )}
    </div>
  )
}

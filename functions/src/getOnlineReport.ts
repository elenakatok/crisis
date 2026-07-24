import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { extractInstructorGameId } from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'
import type { CrisisState } from './round/machine'

// ═══════════════════════════════════════════════════════════════════════════════
// getOnlineReport (instructor) — the END-OF-ASSIGNMENT operational report (Slice O3,
// spec §6). NOT the debrief profit reports (getCrisisReport). This is the "who do I
// email / how do I grade" view for an ONLINE assignment: which groups finished / are
// mid-game / never started, and per student — their group, whether they arrived, their
// last login, whether they were flagged, whether they played with bots, and the outcome
// if their group finished.
//
// It COMPOSES the two absence signals the spec (§6) wants side by side: the flag records
// unresponsiveness BEFORE play; timeout_count (in the frozen round state) records absence
// DURING play. Both live here so the picture is legible in one place.
//
// Read-only. Serves data the instructor client cannot read itself (participant docs, config)
// entirely server-side. Works in either mode, but flags/logins only populate online.
// ═══════════════════════════════════════════════════════════════════════════════

interface StoredRound {
  state: CrisisState
  pid_by_seat: Record<string, string>
  bot_seats?: number[]
}

type GroupCategory = 'finished' | 'in_progress' | 'never_started'

export type OnlineReportGroup = {
  groupId: string
  groupNumber: number
  category: GroupCategory
  humanCount: number
  botCount: number
  /** A flag was raised on this group (the record persists even after it goes stale). */
  flagged: boolean
  /** The flag is stale — the group has since locked (started playing = resolved). */
  flagStale: boolean
  reporterName: string | null
  /** Rounds recorded so far (numRounds when finished, current round mid-game, 0 otherwise). */
  rounds: number
}

export type OnlineReportStudent = {
  participantId: string
  name: string
  groupNumber: number | null
  category: GroupCategory | 'no_group'
  /** In their group's `arrived` set — showed up to their group. */
  arrived: boolean
  /** last_login_at in ms epoch, or null if they never logged in. */
  lastLoginMs: number | null
  /** Their group has a flag (raised before play — the pre-play absence signal). */
  flagged: boolean
  /** Their group has bot seats (they played with stand-in bots). */
  playedWithBots: boolean
  /** Stages they missed during play (the in-play absence signal), 0 when none. */
  timeouts: number
  /** Rounds their group recorded (null when their group never started / no group). */
  rounds: number | null
}

const toMs = (v: unknown): number | null => {
  // Duck-type the Firestore Timestamp (admin.firestore.Timestamp is not a runtime value here).
  if (v && typeof (v as { toMillis?: unknown }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  return null
}

export const getOnlineReport = onCall({ cors: crisisGameDef.corsOrigins }, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const isEmu = process.env.FUNCTIONS_EMULATOR === 'true'
  const iid = await extractInstructorGameId(data, isEmu, request.rawRequest.headers.authorization as string | undefined)
  const instanceRef = admin.firestore().collection('game_instances').doc(iid)

  try {
    const [groupsSnap, roundsSnap, participantsSnap, configSnap] = await Promise.all([
      instanceRef.collection('groups').get(),
      instanceRef.collection('crisis_round').get(),
      instanceRef.collection('participants').get(),
      instanceRef.collection('config').doc('main').get(),
    ])
    const clockMode = String(configSnap.data()?.['clock_mode'] ?? 'on')

    const meta = new Map<string, { name: string; isBot: boolean; groupId: string | null; lastLoginMs: number | null }>()
    for (const p of participantsSnap.docs) {
      const d = p.data() as Record<string, unknown>
      const name = (((d['display_name'] ?? d['name'] ?? '') as string).trim()) || `${p.id.slice(0, 6)}…`
      meta.set(p.id, {
        name,
        isBot: d['is_bot'] === true,
        groupId: (d['group_id'] as string | undefined) ?? null,
        lastLoginMs: toMs(d['last_login_at']),
      })
    }

    const roundById = new Map<string, StoredRound>()
    for (const r of roundsSnap.docs) roundById.set(r.id, r.data() as StoredRound)

    // Stable group numbers by sorted id (matches getCrisisDashboard / getCrisisReport).
    const sortedIds = groupsSnap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b))
    const numberById = new Map(sortedIds.map((id, i) => [id, i + 1]))

    const categoryOf = (groupId: string): { category: GroupCategory; rounds: number } => {
      const r = roundById.get(groupId)
      if (!r) return { category: 'never_started', rounds: 0 }
      const st = r.state
      if (st.status === 'finished') return { category: 'finished', rounds: st.numRounds ?? (st.history?.length ?? 0) }
      return { category: 'in_progress', rounds: st.round ?? 0 }
    }

    const arrivedByGroup = new Map<string, Set<string>>()
    const flagByGroup = new Map<string, { stale: boolean; reporterName: string | null }>()
    const botsByGroup = new Map<string, boolean>()
    const timeoutsByPid = new Map<string, number>()

    const groups: OnlineReportGroup[] = groupsSnap.docs.map((gdoc) => {
      const g = gdoc.data() as Record<string, unknown>
      const gid = gdoc.id
      const players = (g['player_participants'] as string[] | undefined) ?? []
      const bots = (g['bot_participants'] as string[] | undefined) ?? []
      const humanCount = players.filter((p) => !bots.includes(p)).length
      const flag = g['flag'] as Record<string, unknown> | undefined
      const locked = g['seats_locked_at'] != null
      const { category, rounds } = categoryOf(gid)

      arrivedByGroup.set(gid, new Set((g['arrived'] as string[] | undefined) ?? []))
      if (flag) flagByGroup.set(gid, { stale: locked, reporterName: (flag['reporter_name'] as string | undefined) ?? null })
      botsByGroup.set(gid, bots.length > 0)

      return {
        groupId: gid,
        groupNumber: numberById.get(gid) ?? 0,
        category,
        humanCount,
        botCount: bots.length,
        flagged: !!flag,
        flagStale: !!flag && locked,
        reporterName: flag ? ((flag['reporter_name'] as string | undefined) ?? null) : null,
        rounds,
      }
    }).sort((a, b) => a.groupNumber - b.groupNumber)

    // Per-seat timeout counts from the frozen round state (the in-play absence signal).
    for (const r of roundsSnap.docs) {
      const stored = r.data() as StoredRound
      const st = stored.state
      for (const seatStr of Object.keys(stored.pid_by_seat)) {
        const pid = stored.pid_by_seat[seatStr]
        const n = (st.timeouts?.[Number(seatStr)] ?? []).length
        if (pid) timeoutsByPid.set(pid, (timeoutsByPid.get(pid) ?? 0) + n)
      }
    }

    // One row per HUMAN participant (bots are never graded / emailed — excluded, like every report).
    const students: OnlineReportStudent[] = participantsSnap.docs
      .filter((p) => (p.data() as Record<string, unknown>)['is_bot'] !== true)
      .map((p) => {
        const m = meta.get(p.id)!
        const gid = m.groupId
        const groupNumber = gid ? (numberById.get(gid) ?? null) : null
        const cat: GroupCategory | 'no_group' = gid ? categoryOf(gid).category : 'no_group'
        const rounds = gid ? categoryOf(gid).rounds : null
        return {
          participantId: p.id,
          name: m.name,
          groupNumber,
          category: cat,
          arrived: gid ? (arrivedByGroup.get(gid)?.has(p.id) ?? false) : false,
          lastLoginMs: m.lastLoginMs,
          flagged: gid ? flagByGroup.has(gid) : false,
          playedWithBots: gid ? (botsByGroup.get(gid) ?? false) : false,
          timeouts: timeoutsByPid.get(p.id) ?? 0,
          rounds: cat === 'no_group' ? null : rounds,
        }
      })
      .sort((a, b) => (a.groupNumber ?? Infinity) - (b.groupNumber ?? Infinity) || a.name.localeCompare(b.name))

    const counts = {
      finished: groups.filter((g) => g.category === 'finished').length,
      inProgress: groups.filter((g) => g.category === 'in_progress').length,
      neverStarted: groups.filter((g) => g.category === 'never_started').length,
      flagged: groups.filter((g) => g.flagged && !g.flagStale).length,
    }

    return { ok: true as const, clock_mode: clockMode, counts, groups, students }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[getOnlineReport] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})

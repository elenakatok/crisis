// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — Online mode, Slice O1 (Online_Matching_Spec_v1). Crisis-LOCAL, ADDITIVE.
//
// Classroom mode (clock_mode='on') is COMPLETELY UNTOUCHED by this file: attendance
// code, the shared triggerMatching, the waiting room and presence all still run exactly
// as before. Nothing here overrides or disables triggerMatching — the two paths coexist,
// selected by the per-instance clock_mode setting.
//
// Three callables:
//   • groupParticipantsOnline (instructor) — the Spectrum grouping pattern applied to
//     Crisis: a dedicated callable that pre-forms RANDOM groups of 3 from the full roster
//     at deploy time, writing the SAME group-doc contract the round loop already consumes
//     (matchWithBots.ts:108-119) plus a denormalized human-only `members[]` the reveal
//     reads. Guarded to online mode; re-runnable until the first group locks.
//   • recordLogin (student) — stamps last_login_at on each login (feeds the O2 instructor
//     screen) and returns clock_mode so the student UI can pick its routing.
//   • getOnlineGroups (instructor) — clock_mode + the online groups (with members) for the
//     instructor grouping panel.
//
// Roles are assigned LATE (spec §2), so grouping assigns NO Buyer/Seller — a group is
// three (or fewer) undifferentiated `player` seats until openRound. That is what makes a
// remainder short group and a later re-group cheap: no role to migrate, no data to reissue.
// ═══════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, extractStudentOnCallIds } from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'

const GROUP_SIZE = 3 // spec §6 (fixed)
const CORS = { cors: crisisGameDef.corsOrigins }
const isEmu = () => process.env.FUNCTIONS_EMULATOR === 'true'
const authHeaderOf = (req: CallableRequest): string | undefined =>
  req.rawRequest.headers.authorization as string | undefined

/** A human seat on the reveal — denormalized at grouping time (§4.6: no RTDB attending, no
 *  getGroupMemberEmails, no shared email plumbing). `email` is null when the roster has none. */
type OnlineMember = { participant_id: string; display_name: string; email: string | null }

/** Fisher-Yates — RANDOM, deterministic-free (the shape borrowed from makeTriggerMatching,
 *  NOT Spectrum's deterministic i%N partition; Crisis wants genuinely random groups). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** display_name the student chose wins; else the enrolled roster name; else the raw id. */
function displayNameOf(data: Record<string, unknown>, pid: string): string {
  const chosen = data['display_name']
  if (typeof chosen === 'string' && chosen.trim()) return chosen
  const rosterName = data['name']
  if (typeof rosterName === 'string' && rosterName.trim()) return rosterName
  return pid
}

function emailOf(data: Record<string, unknown>): string | null {
  const e = data['email']
  return typeof e === 'string' && e.trim() ? e.trim() : null
}

// ── groupParticipantsOnline (instructor) ─────────────────────────────────────────
async function groupOnlineCore(gameInstanceId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  const [configSnap, groupsSnap, participantsSnap] = await Promise.all([
    instanceRef.collection('config').doc('main').get(),
    instanceRef.collection('groups').get(),
    instanceRef.collection('participants').get(),
  ])

  // 1. Guard: online mode only. Classroom keeps its own triggerMatching path.
  const clockMode = String(configSnap.data()?.['clock_mode'] ?? 'on')
  if (clockMode !== 'off') {
    throw new HttpsError(
      'failed-precondition',
      'Online grouping is only available in online mode. Set the clock to “off” (online play) first.',
    )
  }

  // 2. Lock guard (spec §3): once ANY group has locked at first round-1 submission, seats
  //    are frozen and re-grouping is incoherent. Reject rather than fork a live game.
  const anyLocked = groupsSnap.docs.some((d) => d.data()['seats_locked_at'] != null)
  if (anyLocked) {
    throw new HttpsError(
      'failed-precondition',
      'A group has already started playing (seats are locked), so groups can no longer be re-formed.',
    )
  }

  // 3. The full HUMAN roster (bots are only ever seat-fillers; role must be the single
  //    matching role `player`). Presence / attendance are NOT required — this is a
  //    deploy-time pre-match of everyone on the roster (that is the whole point of §1).
  const humanDocs = participantsSnap.docs.filter((d) => {
    const x = d.data()
    return x['is_bot'] !== true && x['role'] === 'player'
  })
  if (humanDocs.length === 0) {
    throw new HttpsError('failed-precondition', 'No participants on the roster to group yet.')
  }
  const dataById = new Map(participantsSnap.docs.map((d) => [d.id, d.data()]))

  const batch = db.batch()

  // 4. RE-RUN semantics: delete every prior (unlocked) group and regroup everyone. Prior
  //    seat-filler bots are discarded — they are formation artifacts, re-created on demand
  //    by fillRemainderWithBots, never carried across a re-group.
  for (const g of groupsSnap.docs) batch.delete(g.ref)
  for (const d of participantsSnap.docs) {
    if (d.data()['is_bot'] === true) batch.delete(d.ref)
  }

  // 5. Shuffle, then chunk by 3. The remainder (roster not a multiple of 3) forms ONE final
  //    short group of 2 or 1 — never discarded, never a 4th seat (approved remainder policy).
  const shuffled = shuffle(humanDocs.map((d) => d.id))
  const chunks: string[][] = []
  for (let i = 0; i < shuffled.length; i += GROUP_SIZE) chunks.push(shuffled.slice(i, i + GROUP_SIZE))

  const now = FieldValue.serverTimestamp()
  const created: { group_id: string; size: number }[] = []

  for (const pids of chunks) {
    const groupId = randomUUID()
    const lead = pids[0] // seat 0 (spec: lead is a human; grouping never seats a bot)
    const members: OnlineMember[] = pids.map((pid) => {
      const x = dataById.get(pid) ?? {}
      return { participant_id: pid, display_name: displayNameOf(x, pid), email: emailOf(x) }
    })

    // Same contract the round loop consumes (matchWithBots.ts:108-119): player_participants
    // (seat order), empty bot arrays, lead = seat 0, status 'matched', matched_at. PLUS the
    // denormalized members[] the reveal reads.
    batch.set(instanceRef.collection('groups').doc(groupId), {
      group_id: groupId,
      game_instance_id: gameInstanceId,
      player_participants: pids,
      bot_participants: [],
      bot_count: 0,
      bot_types: {},
      lead_participant_id: lead,
      members,
      outcome: null,
      status: 'matched',
      matched_at: now,
    })

    for (const pid of pids) {
      const x = dataById.get(pid) ?? {}
      batch.update(instanceRef.collection('participants').doc(pid), {
        group_id: groupId,
        is_lead: pid === lead,
        display_name: displayNameOf(x, pid), // use the roster name if the student never set one
      })
    }
    created.push({ group_id: groupId, size: pids.length })
  }

  // NOTE: one Firestore batch (≤ 500 ops). Crisis classes are classroom-sized (tens of
  // students), so group-deletes + bot-deletes + group-sets + participant-updates stays well
  // under the cap. If a class ever approached ~120 rostered, this would need chunking.
  await batch.commit()

  const short = created.find((g) => g.size < GROUP_SIZE)
  return {
    ok: true as const,
    groups: created.length,
    full_groups: created.filter((g) => g.size === GROUP_SIZE).length,
    short_group_size: short?.size ?? null,
    total_humans: humanDocs.length,
  }
}

export const groupParticipantsOnline = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  return groupOnlineCore(gameInstanceId)
})

// ── recordLogin (student) — stamp last_login_at + hand back the routing mode ──────────
// The earliest Crisis-OWNED server-authenticated touchpoint (assignRole/getInfoUrls are
// shared and must not be edited). The student UI calls this once on session establishment.
// last_login_at feeds the O2 instructor screen; there is no O1 UI for it. clock_mode lets
// the UI choose online vs classroom routing (config is server-only-readable, so the client
// cannot read it directly).
export const recordLogin = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  // FieldValue.serverTimestamp() (the admin-SDK-safe form used throughout this codebase —
  // NOT the client sentinel). Overwrites on each login. Best-effort; merge so a missing doc
  // is never fatal to the login.
  await instanceRef
    .collection('participants')
    .doc(participantId)
    .set({ last_login_at: FieldValue.serverTimestamp() }, { merge: true })

  const configSnap = await instanceRef.collection('config').doc('main').get()
  const clockMode = String(configSnap.data()?.['clock_mode'] ?? 'on')
  return { ok: true as const, clock_mode: clockMode }
})

// ── getOnlineGroups (instructor) — the grouping panel's read side ────────────────────
export const getOnlineGroups = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  const [configSnap, groupsSnap] = await Promise.all([
    instanceRef.collection('config').doc('main').get(),
    instanceRef.collection('groups').get(),
  ])
  const clockMode = String(configSnap.data()?.['clock_mode'] ?? 'on')

  const groups = groupsSnap.docs
    .map((d) => d.data())
    .filter((g) => Array.isArray(g['members'])) // online groups only (classroom groups have none)
    .sort((a, b) => {
      const ta = (a['matched_at'] as admin.firestore.Timestamp | undefined)?.toMillis() ?? 0
      const tb = (b['matched_at'] as admin.firestore.Timestamp | undefined)?.toMillis() ?? 0
      return ta - tb
    })
    .map((g) => ({
      group_id: String(g['group_id']),
      members: (g['members'] as OnlineMember[]) ?? [],
      size: ((g['player_participants'] as string[] | undefined) ?? []).length,
      locked: g['seats_locked_at'] != null,
    }))

  return { ok: true as const, clock_mode: clockMode, groups }
})

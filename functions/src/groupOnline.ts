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
import { makeBotSeat, drawBotType } from './matchWithBots'
import type { SellerType } from './round/decide'

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

function memberOf(data: Record<string, unknown>, pid: string): OnlineMember {
  return { participant_id: pid, display_name: displayNameOf(data, pid), email: emailOf(data) }
}

/** First non-bot pid in seat order — a human always leads; a bot never does. */
function firstHuman(playerPids: string[], botPids: Set<string>): string | null {
  for (const p of playerPids) if (!botPids.has(p)) return p
  return null
}

/**
 * The group's denormalized instructor-panel state, recomputed from its final seat lists:
 * members[] (humans only, name+email — what the reveal reads), member_logins (pid → last
 * login, carried so a login before OR after grouping shows in the panel), and the lead.
 */
function buildMembership(playerPids: string[], botPids: Set<string>, dataById: Map<string, Record<string, unknown>>) {
  const humanPids = playerPids.filter((p) => !botPids.has(p))
  const members = humanPids.map((pid) => memberOf(dataById.get(pid) ?? {}, pid))
  const member_logins: Record<string, unknown> = {}
  for (const pid of humanPids) {
    const ll = (dataById.get(pid) ?? {})['last_login_at']
    if (ll != null) member_logins[pid] = ll
  }
  return { members, member_logins, lead: firstHuman(playerPids, botPids) }
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

  // 3. The full HUMAN roster (bots are only ever seat-fillers). This is a DEPLOY-TIME
  //    pre-match of everyone on the roster (§1), so it must include participants who have
  //    NOT logged in yet: a synced-but-un-launched roster row is role-LESS (makeSyncRoster
  //    creates role-less rows; assignRole sets role='player' only on first launch). We
  //    therefore group every non-bot row and assign role='player' below — the single Crisis
  //    matching role, exactly what a later assignRole would set (and assignRole is idempotent
  //    on an already-roled participant, so a subsequent login is a no-op on group_id/role).
  const humanDocs = participantsSnap.docs.filter((d) => d.data()['is_bot'] !== true)
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
    const { members, member_logins } = buildMembership(pids, new Set(), dataById)

    // Same contract the round loop consumes (matchWithBots.ts:108-119): player_participants
    // (seat order), empty bot arrays, lead = seat 0, status 'matched', matched_at. PLUS the
    // denormalized members[] the reveal reads and member_logins the instructor panel reads.
    batch.set(instanceRef.collection('groups').doc(groupId), {
      group_id: groupId,
      game_instance_id: gameInstanceId,
      player_participants: pids,
      bot_participants: [],
      bot_count: 0,
      bot_types: {},
      lead_participant_id: lead,
      members,
      member_logins,
      outcome: null,
      status: 'matched',
      matched_at: now,
    })

    for (const pid of pids) {
      const x = dataById.get(pid) ?? {}
      batch.update(instanceRef.collection('participants').doc(pid), {
        group_id: groupId,
        is_lead: pid === lead,
        // Assign the single Crisis matching role now (a role-less roster row hasn't logged in
        // yet). role_counts is not touched: Crisis is single-role so pickRole ignores it, and
        // skipping it keeps a re-group from double-counting. assignRole stays idempotent.
        role: 'player',
        role_assigned_at: FieldValue.serverTimestamp(),
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
  const pRef = instanceRef.collection('participants').doc(participantId)

  const [pSnap, configSnap] = await Promise.all([pRef.get(), instanceRef.collection('config').doc('main').get()])

  // FieldValue.serverTimestamp() (the admin-SDK-safe form used throughout this codebase —
  // NOT the client sentinel). Overwrites on each login. Best-effort; merge so a missing doc
  // is never fatal to the login.
  await pRef.set({ last_login_at: FieldValue.serverTimestamp() }, { merge: true })

  // Denormalize the login into the participant's group so the instructor online panel — which
  // reads the GROUP doc live (client rules deny reading participant docs) — shows login status
  // without a second fetch. Nested-map merge, so it never clobbers other members' entries.
  const groupId = pSnap.data()?.['group_id'] as string | undefined
  if (groupId) {
    await instanceRef.collection('groups').doc(groupId)
      .set({ member_logins: { [participantId]: FieldValue.serverTimestamp() } }, { merge: true })
      .catch(() => { /* cosmetic — the participant stamp above is the source of truth */ })
  }

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

// ── moveSeat (instructor) ────────────────────────────────────────────────────────
// Move a HUMAN from their current group into another group with a free seat (merge two
// short-handed groups, or fill an emptied seat). GENERALITY: this callable is game-agnostic
// APART FROM the role-late assumption — because roles are assigned late, moving an occupant is
// a pure seat/array rewrite with no role to migrate and no private data to reissue. A game
// with genuine private information would need role-aware reassignment; that is a per-game
// decision to be made when this is promoted to the stage engine at extraction time.
async function moveSeatCore(gameInstanceId: string, participantId: string, targetGroupId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  // Online-only guard (read outside the tx; clock_mode does not change under a move).
  const configSnap = await instanceRef.collection('config').doc('main').get()
  if (String(configSnap.data()?.['clock_mode'] ?? 'on') !== 'off') {
    throw new HttpsError('failed-precondition', 'Seat moves are an online-mode action.')
  }

  return db.runTransaction(async (tx) => {
    const pRef = instanceRef.collection('participants').doc(participantId)
    const pSnap = await tx.get(pRef)
    if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
    const p = pSnap.data() as Record<string, unknown>
    if (p['is_bot'] === true) throw new HttpsError('failed-precondition', 'Only human participants can be moved.')
    const sourceGroupId = p['group_id'] as string | undefined
    if (!sourceGroupId) throw new HttpsError('failed-precondition', 'Participant is not in a group.')
    if (sourceGroupId === targetGroupId) return { ok: true as const, moved: false, reason: 'already in target group' }

    const sourceRef = instanceRef.collection('groups').doc(sourceGroupId)
    const targetRef = instanceRef.collection('groups').doc(targetGroupId)
    const [sourceSnap, targetSnap] = await Promise.all([tx.get(sourceRef), tx.get(targetRef)])
    if (!sourceSnap.exists || !targetSnap.exists) throw new HttpsError('not-found', 'Group not found.')
    const source = sourceSnap.data() as Record<string, unknown>
    const target = targetSnap.data() as Record<string, unknown>

    // LOCK GUARD (spec §3): a move into or out of a group that has started playing is
    // incoherent — refuse rather than fork a live game.
    if (source['seats_locked_at'] != null || target['seats_locked_at'] != null) {
      throw new HttpsError('failed-precondition', 'One of the groups has already started playing (seats are locked).')
    }

    const targetPlayers = (target['player_participants'] as string[] | undefined) ?? []
    if (targetPlayers.length >= GROUP_SIZE) {
      throw new HttpsError('failed-precondition', 'The destination group is already full (3 seats).')
    }

    const newSource = ((source['player_participants'] as string[] | undefined) ?? []).filter((x) => x !== participantId)
    const newTarget = [...targetPlayers, participantId]
    const sourceBots = new Set((source['bot_participants'] as string[] | undefined) ?? [])
    const targetBots = new Set((target['bot_participants'] as string[] | undefined) ?? [])

    // Read every human doc in both final groups for members[]/member_logins/lead rebuild.
    const humanPids = [...newSource.filter((x) => !sourceBots.has(x)), ...newTarget.filter((x) => !targetBots.has(x))]
    const humanSnaps = humanPids.length ? await tx.getAll(...humanPids.map((id) => instanceRef.collection('participants').doc(id))) : []
    const dataById = new Map<string, Record<string, unknown>>(humanSnaps.map((s) => [s.id, (s.data() ?? {}) as Record<string, unknown>]))

    const src = buildMembership(newSource, sourceBots, dataById)
    const tgt = buildMembership(newTarget, targetBots, dataById)

    // Source group — left standing even if now empty (§4.4: an emptied group costs nothing).
    tx.update(sourceRef, {
      player_participants: newSource,
      lead_participant_id: src.lead,
      members: src.members,
      member_logins: src.member_logins,
    })
    tx.update(targetRef, {
      player_participants: newTarget,
      lead_participant_id: tgt.lead,
      members: tgt.members,
      member_logins: tgt.member_logins,
    })

    // The moved participant → target group. Re-stamp is_lead on every human in BOTH groups so
    // exactly the (recomputed) leads carry it (cheap: ≤5 humans total).
    tx.update(pRef, { group_id: targetGroupId, is_lead: participantId === tgt.lead })
    for (const pid of newSource) if (!sourceBots.has(pid) && pid !== participantId) tx.update(instanceRef.collection('participants').doc(pid), { is_lead: pid === src.lead })
    for (const pid of newTarget) if (!targetBots.has(pid) && pid !== participantId) tx.update(instanceRef.collection('participants').doc(pid), { is_lead: pid === tgt.lead })

    return { ok: true as const, moved: true, source_group: sourceGroupId, target_group: targetGroupId }
  })
}

export const moveSeat = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const participantId = String(data['participant_id'] ?? '')
  const targetGroupId = String(data['target_group_id'] ?? '')
  if (!participantId || !targetGroupId) throw new HttpsError('invalid-argument', 'participant_id and target_group_id required')
  return moveSeatCore(gameInstanceId, participantId, targetGroupId)
})

// ── topUpGroupWithBots (instructor) ──────────────────────────────────────────────
// Fill a group's empty seats with server bot seat-fillers so a short group (1–2 humans) can
// play. Reuses THE bot creation path (makeBotSeat) and the once-at-fill fixed-type draw
// (drawBotType) — no second copy of decide() or the bot doc shape. Online-only; refused on a
// locked group.
async function topUpCore(gameInstanceId: string, groupId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  const [configSnap, groupSnap] = await Promise.all([
    instanceRef.collection('config').doc('main').get(),
    instanceRef.collection('groups').doc(groupId).get(),
  ])
  if (String(configSnap.data()?.['clock_mode'] ?? 'on') !== 'off') {
    throw new HttpsError('failed-precondition', 'Bot top-up is an online-mode action.')
  }
  if (!groupSnap.exists) throw new HttpsError('not-found', 'Group not found.')
  const g = groupSnap.data() as Record<string, unknown>
  if (g['seats_locked_at'] != null) {
    throw new HttpsError('failed-precondition', 'This group has already started playing (seats are locked).')
  }

  const players = (g['player_participants'] as string[] | undefined) ?? []
  const existingBots = (g['bot_participants'] as string[] | undefined) ?? []
  const needed = GROUP_SIZE - players.length
  if (needed <= 0) return { ok: true as const, added: 0, reason: 'group already full' }

  const now = FieldValue.serverTimestamp()
  const batch = db.batch()
  const newBotPids: string[] = []
  const botTypes = { ...((g['bot_types'] as Record<string, SellerType> | undefined) ?? {}) }
  for (let i = 0; i < needed; i++) {
    const { pid, doc } = makeBotSeat(gameInstanceId, groupId, existingBots.length + i + 1, drawBotType(), now)
    newBotPids.push(pid)
    botTypes[pid] = doc.bot_type
    batch.set(instanceRef.collection('participants').doc(pid), doc)
  }
  batch.update(instanceRef.collection('groups').doc(groupId), {
    player_participants: [...players, ...newBotPids],   // bots take the trailing seats
    bot_participants: [...existingBots, ...newBotPids],
    bot_count: existingBots.length + newBotPids.length,
    bot_types: botTypes,
  })
  await batch.commit()
  return { ok: true as const, added: needed, bots: newBotPids }
}

export const topUpGroupWithBots = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')
  return topUpCore(gameInstanceId, groupId)
})

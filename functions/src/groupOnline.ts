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

/**
 * The group-doc fields to write for a membership change (§O2.4, both modes). player_participants +
 * lead ALWAYS. members[]/member_logins are ONLY maintained when the group ALREADY carries them —
 * i.e. an online-formed group. They are NEVER fabricated on a classroom/triggerMatching group
 * (whose display names live in the RTDB attending overlay, and whose absence of members[] is the
 * very signal the reveal gate keys on). `existing` = the group's current data (null for a fresh
 * group); pass `forceMembers` to seed members[] on a brand-new online group.
 */
function membership(
  existing: Record<string, unknown> | null | undefined,
  playerPids: string[],
  botPids: Set<string>,
  dataById: Map<string, Record<string, unknown>>,
  forceMembers = false,
) {
  const lead = firstHuman(playerPids, botPids)
  const fields: Record<string, unknown> = { player_participants: playerPids, lead_participant_id: lead }
  if (forceMembers || Array.isArray(existing?.['members'])) {
    const m = buildMembership(playerPids, botPids, dataById)
    fields['members'] = m.members
    fields['member_logins'] = m.member_logins
  }
  return { fields, lead }
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

// ── flagGroup (student) — "I can't reach my group" (Slice O3, spec §4.1) ──────────────
// Online-only. Writes a PASSIVE flag on the group doc — who reported, who was named as not-yet-
// here, and a timestamp — the structured record behind the instructor's ⚑ and the end-of-
// assignment report. IDEMPOTENT: the first flag wins (its flagged_at is how long they have been
// waiting); a re-press by the same or another student never overwrites it, so there is no
// duplicate write. The flag goes STALE automatically at first submission (seats_locked_at) — this
// callable refuses a locked group, and readers hide a flag once the group has locked.
//
// The mailto itself is built CLIENT-side from the live member/arrival data the waiting screen
// already shows; the server only supplies the two facts the client cannot compute: the group's
// stable NUMBER (sorted, matches the dashboard) and the instructor_email config value for To:
// (null until Elena sets it in Settings — see gameDefinition instructor_email).
export const flagGroup = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  const [pSnap, configSnap, groupsSnap, instanceSnap] = await Promise.all([
    instanceRef.collection('participants').doc(participantId).get(),
    instanceRef.collection('config').doc('main').get(),
    instanceRef.collection('groups').get(),
    instanceRef.get(),
  ])
  // Online-only (the button is only shown online; this is the server guard).
  if (String(configSnap.data()?.['clock_mode'] ?? 'on') !== 'off') {
    throw new HttpsError('failed-precondition', 'Flagging is an online-mode action.')
  }
  const groupId = pSnap.data()?.['group_id'] as string | undefined
  if (!groupId) throw new HttpsError('failed-precondition', 'You are not in a group yet.')

  // Stable group number = 1-based index in the sorted group-id list (matches getCrisisDashboard).
  const groupNumber = groupsSnap.docs.map((d) => d.id).sort((a, b) => a.localeCompare(b)).indexOf(groupId) + 1

  const groupRef = instanceRef.collection('groups').doc(groupId)
  const already = await db.runTransaction(async (tx) => {
    const gs = await tx.get(groupRef)
    if (!gs.exists) throw new HttpsError('not-found', 'Group not found.')
    const gd = gs.data() as Record<string, unknown>
    if (gd['seats_locked_at'] != null) throw new HttpsError('failed-precondition', 'This group has already started playing.')
    if (gd['flag'] != null) return true // idempotent — first flag stands, no duplicate write

    const members = (gd['members'] as OnlineMember[] | undefined) ?? []
    const arrived = new Set((gd['arrived'] as string[] | undefined) ?? [])
    // "named" = the human members (other than the reporter) not yet here — who the report attributes
    // the delay to. Snapshot at flag time; the live picture can move, the record should not.
    const named = members.filter((m) => m.participant_id !== participantId && !arrived.has(m.participant_id)).map((m) => m.participant_id)
    const reporterName = members.find((m) => m.participant_id === participantId)?.display_name ?? participantId
    tx.set(groupRef, {
      flag: { flagged_at: FieldValue.serverTimestamp(), reported_by: participantId, reporter_name: reporterName, named },
    }, { merge: true })
    return false
  })

  // Instructor email precedence (instructor-email auto-populate): the MANUAL Settings value wins
  // when set (a real override — a co-teacher's address, or a correction), else the SYNCED value on
  // the instance doc (course owner, from getCourseRoster); blank To: with Cc-group if neither is set.
  const syncedEmail = String(instanceSnap.data()?.['instructor_email'] ?? '').trim()
  const overrideEmail = String(configSnap.data()?.['instructor_email'] ?? '').trim()
  const instructorEmail = overrideEmail || syncedEmail
  return { ok: true as const, already_flagged: already, group_number: groupNumber, instructor_email: instructorEmail || null }
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

  // §O2.4: works in BOTH modes. The only guards are per-group locks (below). members[] is
  // maintained per group ONLY when present (online groups) — never fabricated on a classroom group.
  return db.runTransaction(async (tx) => {
    // ── reads first ──
    const pRef = instanceRef.collection('participants').doc(participantId)
    const pSnap = await tx.get(pRef)
    if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
    const p = pSnap.data() as Record<string, unknown>
    if (p['is_bot'] === true) throw new HttpsError('failed-precondition', 'Only human participants can be moved.')
    // Source is OPTIONAL: a No Group / late student (no group_id) is PLACED into the target.
    const sourceGroupId = p['group_id'] as string | undefined
    if (sourceGroupId === targetGroupId) return { ok: true as const, moved: false, reason: 'already in target group' }

    const targetRef = instanceRef.collection('groups').doc(targetGroupId)
    const targetSnap = await tx.get(targetRef)
    if (!targetSnap.exists) throw new HttpsError('not-found', 'Group not found.')
    const target = targetSnap.data() as Record<string, unknown>
    if (target['seats_locked_at'] != null) throw new HttpsError('failed-precondition', 'The destination group has already started playing (seats are locked).')
    const targetPlayers = (target['player_participants'] as string[] | undefined) ?? []
    const targetBotsArr = (target['bot_participants'] as string[] | undefined) ?? []
    // §O2.5B — HUMAN REPLACES BOT: a full group may still take a human if one of its seats is a
    // bot. Moving a human in EVICTS one bot (the last-added). Never evict a human; a full all-human
    // group is genuinely full. Both bot kinds (classroom matchWithBots + online topUp) are makeBotSeat
    // docs in bot_participants — cleanup is identical (arrays + doc delete; no round data on an
    // unlocked group). Unlocked-only, as ever (the lock guard above).
    let evictedBot: string | null = null
    if (targetPlayers.length >= GROUP_SIZE) {
      evictedBot = targetBotsArr[targetBotsArr.length - 1] ?? null
      if (!evictedBot) throw new HttpsError('failed-precondition', 'The destination group is already full (3 human seats).')
    }

    const sourceRef = sourceGroupId ? instanceRef.collection('groups').doc(sourceGroupId) : null
    let source: Record<string, unknown> | null = null
    let newSource: string[] = []
    if (sourceRef) {
      const sourceSnap = await tx.get(sourceRef)
      if (!sourceSnap.exists) throw new HttpsError('not-found', 'Group not found.')
      source = sourceSnap.data() as Record<string, unknown>
      if (source['seats_locked_at'] != null) throw new HttpsError('failed-precondition', 'The source group has already started playing (seats are locked).')
      newSource = ((source['player_participants'] as string[] | undefined) ?? []).filter((x) => x !== participantId)
    }

    // Evicted bot (if any) leaves BOTH the seat list and the bot arrays; the human takes the seat.
    const targetPlayersAfterEvict = evictedBot ? targetPlayers.filter((x) => x !== evictedBot) : targetPlayers
    const newTarget = [...targetPlayersAfterEvict, participantId]
    const sourceBots = new Set((source?.['bot_participants'] as string[] | undefined) ?? [])
    const targetBots = new Set(targetBotsArr.filter((x) => x !== evictedBot))

    // Read every human doc in both final groups for members[]/member_logins/lead rebuild.
    const humanPids = [...newSource.filter((x) => !sourceBots.has(x)), ...newTarget.filter((x) => !targetBots.has(x))]
    const humanSnaps = humanPids.length ? await tx.getAll(...humanPids.map((id) => instanceRef.collection('participants').doc(id))) : []
    const dataById = new Map<string, Record<string, unknown>>(humanSnaps.map((s) => [s.id, (s.data() ?? {}) as Record<string, unknown>]))

    const tgt = membership(target, newTarget, targetBots, dataById)

    // ── writes ── (members[] only where the group already has it — see membership())
    if (sourceRef && source) {
      const src = membership(source, newSource, sourceBots, dataById)
      // Source group — left standing even if now empty (§4.4: an emptied group costs nothing).
      tx.update(sourceRef, src.fields)
      for (const pid of newSource) if (!sourceBots.has(pid) && pid !== participantId) tx.update(instanceRef.collection('participants').doc(pid), { is_lead: pid === src.lead })
    }
    const targetUpdate: Record<string, unknown> = { ...tgt.fields }
    if (evictedBot) {
      const botTypes = { ...((target['bot_types'] as Record<string, unknown> | undefined) ?? {}) }
      delete botTypes[evictedBot]
      targetUpdate['bot_participants'] = [...targetBots]
      targetUpdate['bot_count'] = targetBots.size
      targetUpdate['bot_types'] = botTypes
    }
    tx.update(targetRef, targetUpdate)
    if (evictedBot) tx.delete(instanceRef.collection('participants').doc(evictedBot)) // the bot seat owns only its doc (unlocked → no round data)

    // The moved/placed participant → target group. role:'player' covers a late/role-less No Group
    // student (idempotent for an already-roled student).
    tx.update(pRef, { group_id: targetGroupId, is_lead: participantId === tgt.lead, role: 'player' })
    for (const pid of newTarget) if (!targetBots.has(pid) && pid !== participantId) tx.update(instanceRef.collection('participants').doc(pid), { is_lead: pid === tgt.lead })

    return { ok: true as const, moved: true, source_group: sourceGroupId ?? null, target_group: targetGroupId, evicted_bot: evictedBot }
  })
}

// UNGROUP (§O2.2) — the same seat-move machinery with "no group" as the destination: remove a
// human from their group (e.g. a student who dropped the class), leaving the seat empty and the
// group standing (playable again via move-in or bot-fill). Same generality note as moveSeatCore:
// safe as a pure array/lead rewrite because roles are assigned late — nothing to reissue.
async function ungroupCore(gameInstanceId: string, participantId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  // §O2.4: works in BOTH modes. Only the per-group lock guard applies.
  return db.runTransaction(async (tx) => {
    const pRef = instanceRef.collection('participants').doc(participantId)
    const pSnap = await tx.get(pRef)
    if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
    const p = pSnap.data() as Record<string, unknown>
    if (p['is_bot'] === true) throw new HttpsError('failed-precondition', 'Only human participants can be removed.')
    const sourceGroupId = p['group_id'] as string | undefined
    if (!sourceGroupId) return { ok: true as const, removed: false, reason: 'already not in a group' }

    const sourceRef = instanceRef.collection('groups').doc(sourceGroupId)
    const sourceSnap = await tx.get(sourceRef)
    if (!sourceSnap.exists) { // group already gone — just detach the participant
      tx.update(pRef, { group_id: null, is_lead: false })
      return { ok: true as const, removed: true }
    }
    const source = sourceSnap.data() as Record<string, unknown>
    if (source['seats_locked_at'] != null) {
      throw new HttpsError('failed-precondition', 'This group has already started playing (seats are locked).')
    }

    const newSource = ((source['player_participants'] as string[] | undefined) ?? []).filter((x) => x !== participantId)
    const sourceBots = new Set((source['bot_participants'] as string[] | undefined) ?? [])
    const humanPids = newSource.filter((x) => !sourceBots.has(x))
    const humanSnaps = humanPids.length ? await tx.getAll(...humanPids.map((id) => instanceRef.collection('participants').doc(id))) : []
    const dataById = new Map<string, Record<string, unknown>>(humanSnaps.map((s) => [s.id, (s.data() ?? {}) as Record<string, unknown>]))
    const src = membership(source, newSource, sourceBots, dataById) // members[] only if present

    // Group stays standing with the seat now empty; lead recomputed over whoever remains.
    tx.update(sourceRef, src.fields)
    tx.update(pRef, { group_id: null, is_lead: false })
    for (const pid of newSource) if (!sourceBots.has(pid)) tx.update(instanceRef.collection('participants').doc(pid), { is_lead: pid === src.lead })

    return { ok: true as const, removed: true, source_group: sourceGroupId }
  })
}

// CREATE-NEW-GROUP (§O2.3) — the seat-move machinery with "new" as the destination: place a
// student (from another group OR from the No Group pool) into a brand-new group of their own.
// The new group doc is FIELD-FOR-FIELD identical to a groupParticipantsOnline group (same
// buildMembership, same status/arrays), so bot-fill, auto-open, lock and the move guards all
// behave identically to an O1-created group. Same generality note as moveSeatCore.
async function createNewGroupCore(gameInstanceId: string, participantId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  // §O2.4: works in BOTH modes. The new group carries members[] only in ONLINE mode (so it matches
  // an O1-generated group); a classroom new group is shaped like a triggerMatching group (no
  // members[]). clock_mode is read only to decide that — never to reject.
  const configSnap = await instanceRef.collection('config').doc('main').get()
  const online = String(configSnap.data()?.['clock_mode'] ?? 'on') === 'off'

  return db.runTransaction(async (tx) => {
    // ── reads first (Firestore: all reads before any writes) ──
    const pRef = instanceRef.collection('participants').doc(participantId)
    const pSnap = await tx.get(pRef)
    if (!pSnap.exists) throw new HttpsError('not-found', 'Participant not found.')
    const p = pSnap.data() as Record<string, unknown>
    if (p['is_bot'] === true) throw new HttpsError('failed-precondition', 'Only human participants can be grouped.')

    const sourceGroupId = p['group_id'] as string | undefined
    let source: Record<string, unknown> | null = null
    let sourceRef: FirebaseFirestore.DocumentReference | null = null
    let newSource: string[] = []
    let sourceHumanData = new Map<string, Record<string, unknown>>()
    if (sourceGroupId) {
      sourceRef = instanceRef.collection('groups').doc(sourceGroupId)
      const sSnap = await tx.get(sourceRef)
      if (sSnap.exists) {
        source = sSnap.data() as Record<string, unknown>
        if (source['seats_locked_at'] != null) throw new HttpsError('failed-precondition', 'The source group has already started playing (seats are locked).')
        newSource = ((source['player_participants'] as string[] | undefined) ?? []).filter((x) => x !== participantId)
        const sourceBots = new Set((source['bot_participants'] as string[] | undefined) ?? [])
        const humanPids = newSource.filter((x) => !sourceBots.has(x))
        const snaps = humanPids.length ? await tx.getAll(...humanPids.map((id) => instanceRef.collection('participants').doc(id))) : []
        sourceHumanData = new Map(snaps.map((s) => [s.id, (s.data() ?? {}) as Record<string, unknown>]))
      }
    }

    // ── writes ──
    const newGroupId = randomUUID()
    const now = FieldValue.serverTimestamp()
    // forceMembers = online → the new group carries members[] (matches an O1 group); classroom → none.
    const nm = membership(null, [participantId], new Set(), new Map([[participantId, p]]), online)
    tx.set(instanceRef.collection('groups').doc(newGroupId), {
      group_id: newGroupId,
      game_instance_id: gameInstanceId,
      bot_participants: [],
      bot_count: 0,
      bot_types: {},
      outcome: null,
      status: 'matched',
      matched_at: now,
      ...nm.fields, // player_participants + lead_participant_id (+ members/member_logins if online)
    })
    tx.update(pRef, { group_id: newGroupId, is_lead: true, role: 'player' })

    if (source && sourceRef) {
      const sourceBots = new Set((source['bot_participants'] as string[] | undefined) ?? [])
      const src = membership(source, newSource, sourceBots, sourceHumanData) // members[] only if present
      tx.update(sourceRef, src.fields)
      for (const pid of newSource) if (!sourceBots.has(pid)) tx.update(instanceRef.collection('participants').doc(pid), { is_lead: pid === src.lead })
    }

    return { ok: true as const, created: true, new_group: newGroupId }
  })
}

export const moveSeat = onCall(CORS, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const participantId = String(data['participant_id'] ?? '')
  if (!participantId) throw new HttpsError('invalid-argument', 'participant_id required')
  const targetGroupId = String(data['target_group_id'] ?? '')
  // Sentinels on the SAME callable (no new binding): '' = ungroup; 'new' = create a fresh group;
  // any real group id = move into it. (group ids are UUIDs, never '' or 'new'.)
  if (!targetGroupId) return ungroupCore(gameInstanceId, participantId)
  if (targetGroupId === 'new') return createNewGroupCore(gameInstanceId, participantId)
  return moveSeatCore(gameInstanceId, participantId, targetGroupId)
})

// ── topUpGroupWithBots (instructor) ──────────────────────────────────────────────
// Fill a group's empty seats with server bot seat-fillers so a short group (1–2 humans) can
// play. Reuses THE bot creation path (makeBotSeat) and the once-at-fill fixed-type draw
// (drawBotType) — no second copy of decide() or the bot doc shape. §O2.4: BOTH modes; refused
// only on a locked group. Touches only the bot arrays — members[] (humans) is untouched, so a
// classroom group stays members[]-free.
async function topUpCore(gameInstanceId: string, groupId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  const groupSnap = await instanceRef.collection('groups').doc(groupId).get()
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

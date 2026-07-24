// ═══════════════════════════════════════════════════════════════════════════════
// CRISIS — the bot-fill REMAINDER matcher (§5.1, §5.4). Crisis-LOCAL port of SAA's
// matchWithBots. The shared triggerMatching (unchanged) forms floor(n/3) FULL human
// groups of 3 and LEAVES the remainder ungrouped (perRoleCap:3 locks each group at
// exactly 3). This purely-ADDITIVE step picks up the ungrouped eligible humans and forms
// ONE final group padded to 3 with server-side bots (is_bot:true) — so a class whose
// turnout isn't a multiple of 3 can still run. A bot-filled remainder is the NORM, not an
// emergency; groups with ONE human are ALLOWED (§5.4 — no lower-bound guard).
//
// Bots are assigned AT FORMATION, never mid-play, and CONCENTRATED in the remainder
// group. Each bot draws its Seller TYPE ONCE here (§5.2 — held all 10 rounds); the type is
// used iff the bot ends up a Seller after the late role assignment (a bot may become the
// Buyer, in which case the type is simply unused).
//
// Crisis is CONSUMER #2 of 3 — do NOT extract to shared game-server yet.
// ═══════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId, makeTriggerMatching } from '@mygames/game-server'
import { crisisGameDef } from './gameDefinition'
import type { SellerType } from './round/decide'

const GROUP_SIZE = 3 // spec §6 (fixed)

// The shared human matcher (unchanged) — PRIVATE: run in-process via .run(request) inside
// the deployed triggerMatching below, so nothing can call the bare (remainder-stranding)
// matcher by name.
const humanMatcher = makeTriggerMatching(crisisGameDef)

/** Independent 50/50 Seller-type draw (§5.2 — do not force the mix). EXPORTED so the online
 *  top-up path (groupOnline.ts) uses the SAME draw, not a second copy. */
export function drawBotType(): SellerType {
  return Math.random() < 0.5 ? 'high' : 'low'
}

/**
 * THE bot seat-filler creation path — a single source shared by the remainder filler
 * (below) AND the online top-up (groupOnline.topUpGroupWithBots). A server bot is a
 * participant row with is_bot:true and a FIXED Seller type (§5.2, drawn once at fill/format
 * and held all 10 rounds). No login, no auth, no browser. Returns the pid + the doc so the
 * caller batches the write and appends the pid to the group's player/bot arrays.
 */
export function makeBotSeat(gameInstanceId: string, groupId: string, index: number, type: SellerType, now: FirebaseFirestore.FieldValue) {
  const pid = `bot_${groupId.slice(0, 8)}_${index}`
  const doc = {
    participant_id: pid,
    game_instance_id: gameInstanceId,
    role: 'player',
    display_name: `Bot ${index}`,
    is_bot: true,
    bot_type: type,               // §5.2 — drawn ONCE, held all 10 rounds
    group_id: groupId,
    is_lead: false,
    prep_status: 'complete',
    knowledge_check_score: null,
    attendance_confirmed_at: now,
    confirmed_ready_at: now,
  }
  return { pid, doc }
}

/**
 * Bot-fill core (no auth): pad the ungrouped eligible-human remainder to a full group of 3
 * with server bots. Idempotent — no ungrouped humans → a no-op.
 */
async function fillRemainderCore(gameInstanceId: string) {
  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  try {
    const [presenceSnap, participantsSnap] = await Promise.all([
      admin.database().ref(`presence/${gameInstanceId}`).once('value'),
      instanceRef.collection('participants').get(),
    ])
    const presentIds = new Set<string>(Object.keys((presenceSnap.val() ?? {}) as object))

    const ungroupedHumans = participantsSnap.docs
      .filter((doc) => {
        const d = doc.data()
        return (
          d['is_bot'] !== true &&
          d['attendance_confirmed_at'] != null &&
          d['role'] === 'player' &&
          presentIds.has(doc.id) &&
          d['group_id'] == null
        )
      })
      .map((doc) => doc.id)

    if (ungroupedHumans.length === 0) {
      return { ok: true as const, created: false, reason: 'No ungrouped eligible humans — nothing to fill.' }
    }
    if (ungroupedHumans.length >= GROUP_SIZE) {
      throw new HttpsError(
        'failed-precondition',
        `${ungroupedHumans.length} ungrouped players (≥ ${GROUP_SIZE}). Run triggerMatching first so the full groups form; then fill the remainder.`,
      )
    }

    const humans = ungroupedHumans
    const botsNeeded = GROUP_SIZE - humans.length // 1 or 2 humans → 2 or 1 bots
    const groupId = randomUUID()
    const now = FieldValue.serverTimestamp()

    const batch = db.batch()
    const botPids: string[] = []
    const botTypes: Record<string, SellerType> = {}
    for (let i = 0; i < botsNeeded; i++) {
      const { pid: botPid, doc } = makeBotSeat(gameInstanceId, groupId, i + 1, drawBotType(), now)
      botPids.push(botPid)
      botTypes[botPid] = doc.bot_type
      batch.set(instanceRef.collection('participants').doc(botPid), doc)
    }

    // Humans first → seats 0..h-1; bots after. openRound assigns roles late over these seats.
    const playerParticipants = [...humans, ...botPids]
    const lead = humans[0] // a HUMAN is always the lead; a bot never leads.

    batch.set(instanceRef.collection('groups').doc(groupId), {
      group_id: groupId,
      game_instance_id: gameInstanceId,
      player_participants: playerParticipants,
      bot_participants: botPids,
      bot_count: botsNeeded,
      bot_types: botTypes,          // pid → 'high' | 'low' (read at openRound → per-seat)
      lead_participant_id: lead,
      outcome: null,
      status: 'matched',
      matched_at: now,
    })
    for (const pid of humans) {
      batch.update(instanceRef.collection('participants').doc(pid), { group_id: groupId, is_lead: pid === lead })
    }

    await batch.commit()
    return { ok: true as const, created: true, group_id: groupId, humans: humans.length, bots: botsNeeded }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[fillRemainderWithBots] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
}

// ── Standalone bot-fill callable ────────────────────────────────────────────────
export const fillRemainderWithBots = onCall({ cors: crisisGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)
  return fillRemainderCore(gameInstanceId)
})

// ── triggerMatching — the server-authoritative single matching action ──────────────
// DEPLOYED UNDER THE NAME 'triggerMatching' on purpose: the instructor "Match" button is
// the shared game-ui InstructorDashboard, which calls httpsCallable('triggerMatching') by
// NAME. So the chained logic lives under exactly that name: run the EXISTING human matcher
// (floor(n/3) full groups of 3 — unchanged) THEN bot-fill the ungrouped remainder to 3.
export const triggerMatching = onCall({ cors: crisisGameDef.corsOrigins }, async (request: CallableRequest) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  // 1. Human groups — EXACTLY today's path (the shared matcher's own handler, in-process).
  let human: unknown
  try {
    human = await humanMatcher.run(request)
  } catch (err) {
    // n < 3 → the human matcher can't form a base group and throws failed-precondition.
    // That is NOT an error here: every present human goes into the bot-filled remainder.
    if (err instanceof HttpsError && err.code === 'failed-precondition') {
      human = { ok: false as const, groups: [], note: 'no full human group; all humans join the bot-filled remainder' }
    } else {
      throw err
    }
  }
  // 2. Pad the group_id==null remainder with bots (idempotent).
  const remainder = await fillRemainderCore(gameInstanceId)

  return { ok: true as const, human, remainder }
})

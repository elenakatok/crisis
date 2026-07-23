import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'

// Emulator-only dev seed. Creates a matched Crisis group of 3 `player` participants so the
// round-loop harness can start from a matched group without driving the whole join+match
// flow. Kept LOCKED (404 unless FUNCTIONS_EMULATOR==='true') — never bound in prod.

// Crisis: single matching role `player`, fixed group of 3 (roles assigned late at openRound).
export const seedGroupForTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') { res.status(404).json({ error: 'Not found' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }

  const body = (req.body?.data ?? req.body) as {
    game_instance_id?: unknown
    group_id?: unknown
    player_participants?: unknown
  }
  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' }); return
  }
  if (!Array.isArray(body.player_participants) || body.player_participants.length !== 3) {
    res.status(400).json({ error: 'player_participants must be an array of exactly 3 ids' }); return
  }

  const gameInstanceId = body.game_instance_id
  const groupId = typeof body.group_id === 'string' && body.group_id ? body.group_id : 'g1'
  const playerPids = body.player_participants as string[]

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const batch = db.batch()

  batch.set(instanceRef.collection('groups').doc(groupId), {
    group_id: groupId,
    game_instance_id: gameInstanceId,
    lead_participant_id: playerPids[0],
    status: 'matched',
    player_participants: playerPids,
  })

  playerPids.forEach((pid) => {
    batch.set(instanceRef.collection('participants').doc(pid), {
      participant_id: pid,
      game_instance_id: gameInstanceId,
      role: 'player',
      group_id: groupId,
      is_lead: pid === playerPids[0],
      knowledge_check_completed_at: new Date(),
      knowledge_check_score: 1,
      prep_status: 'complete',
      attendance_confirmed_at: new Date(),
      confirmed_ready_at: new Date(),
    }, { merge: true })
  })

  await batch.commit()
  res.json({ data: { ok: true, group_id: groupId, player_participants: playerPids } })
})

// Emulator-only: seed N UNMATCHED, present, attendance-verified players so the REAL
// chained triggerMatching (human groups + bot-fill remainder) can be driven end-to-end.
// Writes RTDB presence for each (the matcher's eligibility gate).
export const seedRosterForTest = onRequest(async (req, res) => {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') { res.status(404).json({ error: 'Not found' }); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return }
  const body = (req.body?.data ?? req.body) as { game_instance_id?: unknown; participant_ids?: unknown }
  if (typeof body.game_instance_id !== 'string' || !body.game_instance_id) {
    res.status(400).json({ error: 'game_instance_id required' }); return
  }
  if (!Array.isArray(body.participant_ids) || body.participant_ids.length === 0) {
    res.status(400).json({ error: 'participant_ids must be a non-empty array' }); return
  }
  const gameInstanceId = body.game_instance_id
  const pids = body.participant_ids as string[]

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)
  const batch = db.batch()
  for (const pid of pids) {
    batch.set(instanceRef.collection('participants').doc(pid), {
      participant_id: pid,
      game_instance_id: gameInstanceId,
      role: 'player',
      is_bot: false,
      group_id: null,
      knowledge_check_completed_at: new Date(),
      knowledge_check_score: 1,
      prep_status: 'complete',
      confirmed_ready_at: new Date(),
      attendance_confirmed_at: new Date(),
    }, { merge: true })
  }
  await batch.commit()
  // RTDB presence (the matcher's eligibility gate).
  const presence: Record<string, boolean> = {}
  for (const pid of pids) presence[pid] = true
  await admin.database().ref(`presence/${gameInstanceId}`).set(presence)

  res.json({ data: { ok: true, participant_ids: pids } })
})
